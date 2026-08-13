#!/usr/bin/env node
/**
 * One detached codebase-index server per local project index.
 *
 * Every TUI/CLI/WebUI process connects to the deterministic local IPC endpoint
 * for the project's index directory. The OS-level listen operation is the
 * election primitive: when several clients race to spawn a server, exactly one
 * process binds and the other candidates exit on EADDRINUSE.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { restrictFilePermissions } from '@wrongstack/core/security';
import {
  DEFAULT_WALK_IGNORE_SET,
  type ProjectWatchSubscription,
  startSharedHeapWatchdog,
  useDaemonPerfDefaults,
  watchProjectTree,
} from '@wrongstack/core/utils';
import { atomicWrite, bindProjectEndpoint } from '@wrongstack/persistence';
import type { IncomingCallsResult, OutgoingCallsResult } from './index-service.js';
import {
  fileGraphService,
  incomingCallsService,
  indexService,
  outgoingCallsService,
  packageGraphService,
  searchService,
  statsService,
  symbolGraphService,
} from './index-service.js';
import { isIndexablePath } from './languages.js';
import { GenerationLruCache } from './project-server-cache.js';
import {
  PROJECT_INDEX_SERVER_PROTOCOL_VERSION,
  projectIndexServerBuildId,
  projectIndexServerEndpoint,
  projectIndexServerMetadataPath,
} from './project-server-endpoint.js';
import {
  encodeProjectServerMessage,
  PROJECT_INDEX_SERVER_MAX_FRAME_CHARS,
  type ProjectIndexServerActivity,
  type ProjectIndexServerHealth,
  type ProjectIndexServerInfo,
  type ProjectIndexServerMetadata,
  type ProjectServerClientMessage,
  type ProjectServerMessage,
} from './project-server-protocol.js';
import type { CodeMapGraph, IndexStats, SearchResult } from './schema.js';
import type {
  CallRefsOpArgs,
  FileGraphOpArgs,
  IndexOpArgs,
  OpShapes,
  SearchOpArgs,
  StatsOpArgs,
  SymbolGraphOpArgs,
} from './worker-protocol.js';
import { indexStorePool, resolveIndexDir } from './writer.js';

const DEFAULT_IDLE_MS = 5 * 60_000;
const DEFAULT_CLIENT_LEASE_MS = 45_000;

interface ClientState {
  socket: net.Socket;
  buffer: string;
  cancelled: Set<number>;
  cancel: Map<number, () => void>;
  watchExternal: boolean;
  debounceMs: number;
  lastSeenAt: number;
}

interface FullIndexSubscriber {
  state: ClientState;
  id: number;
}

interface ActiveFullIndex {
  promise: Promise<OpShapes['index']['result']>;
  controller: AbortController;
  subscribers: Set<FullIndexSubscriber>;
}

function parseArgs(argv: string[]): { projectRoot: string; indexDir?: string | undefined } {
  let projectRoot: string | undefined;
  let indexDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--project-root') projectRoot = argv[++i];
    else if (arg === '--index-dir') indexDir = argv[++i];
  }
  if (!projectRoot) throw new Error('codebase-index project server requires --project-root');
  return {
    projectRoot: path.resolve(projectRoot),
    ...(indexDir ? { indexDir: path.resolve(indexDir) } : {}),
  };
}

// Long-lived daemon: lean SQLite residency unless the operator says
// otherwise. Must run before any store opens.
useDaemonPerfDefaults();

const parsed = parseArgs(process.argv.slice(2));
const projectRoot = parsed.projectRoot;
const indexDir = resolveIndexDir(projectRoot, parsed.indexDir);
const endpoint = projectIndexServerEndpoint(projectRoot, indexDir);
const metadataPath = projectIndexServerMetadataPath(projectRoot, indexDir);
const idleMsRaw = Number(process.env['WRONGSTACK_INDEX_SERVER_IDLE_MS']);
const idleMs = Number.isFinite(idleMsRaw) && idleMsRaw >= 100 ? idleMsRaw : DEFAULT_IDLE_MS;
const clientLeaseMsRaw = Number(process.env['WRONGSTACK_INDEX_SERVER_CLIENT_LEASE_MS']);
const clientLeaseMs =
  Number.isFinite(clientLeaseMsRaw) && clientLeaseMsRaw >= 100
    ? clientLeaseMsRaw
    : DEFAULT_CLIENT_LEASE_MS;
const clientLeaseSweepMs = Math.min(10_000, Math.max(100, Math.floor(clientLeaseMs / 3)));
const startedAt = new Date().toISOString();
/**
 * Per-process auth token. WS-027: this daemon reads every file in the
 * repository and answers content queries over the resulting index, and it
 * admitted anything that could open the socket. The 0600 socket only excludes
 * OTHER users, and on Windows it does not even do that — so "any process
 * running as you can search your whole codebase" was the boundary.
 *
 * Deliberately NOT part of `serverInfo`: that object is the `hello` payload
 * sent to every socket that connects, which is exactly how the SAGE daemon
 * handed its own credential to the caller it meant to refuse (WS-028).
 */
const authToken = randomBytes(16).toString('hex');

/**
 * Resolves once the metadata file is on disk. The endpoint bind is the
 * ownership election, so metadata cannot be written before listening — which
 * would leave a window where the socket accepts connections and no client can
 * know the token. The daemon holds `hello` until the file exists instead.
 */
let markMetadataWritten: (() => void) | undefined;
const metadataWritten = new Promise<void>((resolve) => {
  markMetadataWritten = resolve;
});

const serverInfo: ProjectIndexServerInfo = {
  protocolVersion: PROJECT_INDEX_SERVER_PROTOCOL_VERSION,
  buildId: projectIndexServerBuildId(import.meta.url),
  pid: process.pid,
  projectRoot,
  indexDir,
  endpoint,
  startedAt,
};

process.title = `wrongstack-codebase-index:${path.basename(projectRoot)}`;

const clients = new Set<ClientState>();
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let stopping = false;
let writeChain: Promise<unknown> = Promise.resolve();
let activeRequests = 0;
let activeWrites = 0;
let queuedWrites = 0;
let activeFullIndex: ActiveFullIndex | null = null;
const searchCache = new GenerationLruCache<{ results: SearchResult[]; total: number }>(128);
const statsCache = new GenerationLruCache<IndexStats>(1);
const packageGraphCache = new GenerationLruCache<CodeMapGraph>(1);
const fileGraphCache = new GenerationLruCache<CodeMapGraph>(32);
const symbolGraphCache = new GenerationLruCache<CodeMapGraph>(64);
const incomingCallsCache = new GenerationLruCache<IncomingCallsResult>(128);
const outgoingCallsCache = new GenerationLruCache<OutgoingCallsResult>(128);
let indexActivity: ProjectIndexServerActivity = {
  indexing: false,
  currentFile: 0,
  totalFiles: 0,
  generation: 0,
  updatedAt: null,
  lastError: null,
};
const stopMemoryWatchdog = startSharedHeapWatchdog({
  collectStats: () => ({
    surface: 'codebase-index-project-server',
    clients: clients.size,
    activeRequests,
    activeWrites,
    queuedWrites,
    searchCache: searchCache.size,
    statsCache: statsCache.size,
    packageGraphCache: packageGraphCache.size,
    fileGraphCache: fileGraphCache.size,
    symbolGraphCache: symbolGraphCache.size,
    incomingCallsCache: incomingCallsCache.size,
    outgoingCallsCache: outgoingCallsCache.size,
  }),
});
let lastProgressBroadcastAt = 0;
let externalWatcher: ProjectWatchSubscription | undefined;
const DEFAULT_EXTERNAL_DEBOUNCE_MS = 400;
let externalDebounceMs = DEFAULT_EXTERNAL_DEBOUNCE_MS;
const externalDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const externalReadyFiles = new Set<string>();
let externalReadyFlush: ReturnType<typeof setImmediate> | undefined;

function clearQueryCaches(): void {
  searchCache.clear();
  statsCache.clear();
  packageGraphCache.clear();
  fileGraphCache.clear();
  symbolGraphCache.clear();
  incomingCallsCache.clear();
  outgoingCallsCache.clear();
}

function cachedRead<T>(cache: GenerationLruCache<T>, key: string, load: () => T): T {
  if (indexActivity.indexing) {
    const error = new Error(
      `Codebase index refresh in progress (${indexActivity.currentFile}/${indexActivity.totalFiles} files); retry after the completed generation is published.`,
    );
    error.name = 'IndexRefreshInProgressError';
    throw error;
  }
  const generation = indexActivity.generation;
  const cached = cache.get(key, generation);
  if (cached !== undefined) return cached;
  const value = load();
  return cache.set(key, generation, value);
}

/**
 * Cap on outbound bytes queued for one client before it is dropped. This
 * server pushes index-activity updates to every client, and `socket.write()`
 * buffers without limit when its `false` return is ignored — so one client
 * that stops reading would otherwise grow the owner's heap indefinitely. The
 * index lives in SQLite; a dropped client re-queries on reconnect.
 */
const MAX_CLIENT_WRITE_BUFFER_BYTES = 8 * 1024 * 1024;

function send(state: ClientState, message: ProjectServerMessage): void {
  if (state.socket.destroyed) return;
  if (state.socket.writableLength > MAX_CLIENT_WRITE_BUFFER_BYTES) {
    state.socket.destroy(new Error('Index client fell too far behind on reads'));
    return;
  }
  state.socket.write(encodeProjectServerMessage(message));
}

function withWriteMutex<T>(job: () => Promise<T>): Promise<T> {
  queuedWrites++;
  const guarded = async () => {
    queuedWrites--;
    activeWrites++;
    try {
      return await job();
    } finally {
      activeWrites--;
    }
  };
  const run = writeChain.then(guarded, guarded);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function serverHealth(): ProjectIndexServerHealth {
  const memory = process.memoryUsage();
  const now = Date.now();
  return {
    checkedAt: now,
    uptimeMs: Math.round(process.uptime() * 1000),
    memory: {
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
      external: memory.external,
    },
    clients: clients.size,
    activeRequests,
    activeWrites,
    queuedWrites,
    pendingExternalFiles: externalDebounceTimers.size + externalReadyFiles.size,
    watchingExternal: externalWatcher !== undefined,
    watchingClients: [...clients].filter((client) => client.watchExternal).length,
    clientLeaseTimeoutMs: clientLeaseMs,
    oldestClientIdleMs:
      clients.size > 0
        ? Math.max(...[...clients].map((client) => Math.max(0, now - client.lastSeenAt)))
        : 0,
    activity: indexActivity,
  };
}

function broadcastIndexActivity(): void {
  for (const client of clients) {
    send(client, { type: 'index-state', state: indexActivity });
  }
}

function reportIndexProgress(currentFile: number, totalFiles: number): void {
  indexActivity = { ...indexActivity, currentFile, totalFiles };
  const now = Date.now();
  if (currentFile >= totalFiles || now - lastProgressBroadcastAt >= 100) {
    lastProgressBroadcastAt = now;
    broadcastIndexActivity();
  }
}

function withIndexWrite<T>(
  job: (onProgress: (currentFile: number, totalFiles: number) => void) => Promise<T>,
): Promise<T> {
  return withWriteMutex(async () => {
    indexActivity = {
      ...indexActivity,
      indexing: true,
      currentFile: 0,
      totalFiles: 0,
      lastError: null,
    };
    lastProgressBroadcastAt = 0;
    broadcastIndexActivity();
    try {
      const result = await job(reportIndexProgress);
      indexActivity = {
        ...indexActivity,
        indexing: false,
        generation: indexActivity.generation + 1,
        updatedAt: Date.now(),
        lastError: null,
      };
      clearQueryCaches();
      broadcastIndexActivity();
      return result;
    } catch (error) {
      indexActivity = {
        ...indexActivity,
        indexing: false,
        generation: indexActivity.generation + 1,
        updatedAt: Date.now(),
        lastError: error instanceof Error ? error.message : String(error),
      };
      broadcastIndexActivity();
      throw error;
    }
  });
}

function fixedArgs<T extends { projectRoot: string; indexDir?: string | undefined }>(args: T): T {
  return { ...args, projectRoot, indexDir };
}

function isShareableFullIndex(args: IndexOpArgs): boolean {
  return (
    !args.force &&
    (!args.files || args.files.length === 0) &&
    (!args.langs || args.langs.length === 0) &&
    (!args.ignore || args.ignore.length === 0)
  );
}

async function runFullIndex(
  state: ClientState,
  id: number,
  args: IndexOpArgs,
): Promise<OpShapes['index']['result']> {
  const subscriber: FullIndexSubscriber = { state, id };
  let active = activeFullIndex;
  if (!active) {
    const controller = new AbortController();
    const subscribers = new Set<FullIndexSubscriber>([subscriber]);
    const promise = withIndexWrite((reportProgress) =>
      indexService(fixedArgs(args), {
        signal: controller.signal,
        onProgress: (current, total) => {
          reportProgress(current, total);
          for (const item of subscribers) {
            if (!item.state.cancelled.has(item.id)) {
              send(item.state, { type: 'progress', id: item.id, current, total });
            }
          }
        },
      }),
    );
    active = { promise, controller, subscribers };
    activeFullIndex = active;
    void promise
      .finally(() => {
        if (activeFullIndex === active) activeFullIndex = null;
      })
      .catch(() => {});
  } else {
    active.subscribers.add(subscriber);
  }

  const selected = active;
  state.cancel.set(id, () => {
    state.cancelled.add(id);
    selected.subscribers.delete(subscriber);
    if (selected.subscribers.size === 0) {
      selected.controller.abort(new Error('Indexing cancelled'));
    }
  });
  try {
    return await selected.promise;
  } finally {
    selected.subscribers.delete(subscriber);
  }
}

async function dispatchOperation(
  state: ClientState,
  message: Extract<ProjectServerClientMessage, { type: 'request' }>,
): Promise<unknown> {
  const { id, op } = message;
  switch (op) {
    case 'index': {
      const args = message.args as IndexOpArgs;
      if (isShareableFullIndex(args)) return runFullIndex(state, id, args);
      const controller = new AbortController();
      state.cancel.set(id, () => {
        state.cancelled.add(id);
        controller.abort(new Error('Indexing cancelled'));
      });
      return withIndexWrite((reportProgress) =>
        indexService(fixedArgs(args), {
          signal: controller.signal,
          onProgress: (current, total) => {
            reportProgress(current, total);
            if (!state.cancelled.has(id)) send(state, { type: 'progress', id, current, total });
          },
        }),
      );
    }
    case 'search':
      return cachedRead(searchCache, JSON.stringify(message.args), () =>
        searchService(fixedArgs(message.args as SearchOpArgs)),
      );
    case 'stats':
      return cachedRead(statsCache, 'stats', () =>
        statsService(fixedArgs(message.args as StatsOpArgs)),
      );
    case 'packageGraph':
      return cachedRead(packageGraphCache, 'package', () =>
        packageGraphService(fixedArgs(message.args as StatsOpArgs)),
      );
    case 'fileGraph':
      return cachedRead(fileGraphCache, (message.args as FileGraphOpArgs).packageFilter, () =>
        fileGraphService(fixedArgs(message.args as FileGraphOpArgs)),
      );
    case 'symbolGraph':
      return cachedRead(symbolGraphCache, (message.args as SymbolGraphOpArgs).fileFilter, () =>
        symbolGraphService(fixedArgs(message.args as SymbolGraphOpArgs)),
      );
    case 'incomingCalls': {
      const callArgs = fixedArgs(message.args as CallRefsOpArgs);
      const cacheKey = JSON.stringify([
        callArgs.symbol,
        callArgs.file ?? '',
        callArgs.limit ?? 100,
        callArgs.transitive ?? false,
      ]);
      return cachedRead(incomingCallsCache, cacheKey, () => incomingCallsService(callArgs));
    }
    case 'outgoingCalls': {
      const callArgs = fixedArgs(message.args as CallRefsOpArgs);
      const cacheKey = JSON.stringify([
        callArgs.symbol,
        callArgs.file ?? '',
        callArgs.limit ?? 100,
        callArgs.transitive ?? false,
      ]);
      return cachedRead(outgoingCallsCache, cacheKey, () => outgoingCallsService(callArgs));
    }
    default:
      throw new Error(`unknown index operation: ${String(op satisfies never)}`);
  }
}

async function handleMessage(
  state: ClientState,
  message: ProjectServerClientMessage,
): Promise<void> {
  // `cancel` is ungated: it reaches only this connection's own in-flight
  // request, so there is nothing to escalate.
  if (message.type === 'cancel') {
    state.cancel.get(message.id)?.();
    return;
  }
  // WS-027: prove you could read the owner-only metadata file before acting.
  if (message.authToken !== authToken) {
    send(state, {
      type: 'response',
      id: message.id,
      ok: false,
      error:
        'Codebase-index IPC request rejected: missing or invalid authToken. ' +
        'Reconnect to refresh metadata (server.json#authToken).',
      errorName: 'UnauthorizedIndexRequest',
    });
    return;
  }
  if (message.type === 'ping') {
    send(state, { type: 'response', id: message.id, ok: true, result: serverHealth() });
    return;
  }
  if (message.type === 'configure') {
    const previousWatchExternal = state.watchExternal;
    const previousDebounceMs = state.debounceMs;
    try {
      state.watchExternal = message.watchExternal;
      state.debounceMs = Math.max(0, message.debounceMs);
      reconcileExternalWatcher();
      send(state, {
        type: 'response',
        id: message.id,
        ok: true,
        result: {
          watching: externalWatcher !== undefined,
          health: serverHealth(),
        },
      });
    } catch (error) {
      state.watchExternal = previousWatchExternal;
      state.debounceMs = previousDebounceMs;
      try {
        reconcileExternalWatcher();
      } catch {
        /* preserve the original configuration error */
      }
      send(state, {
        type: 'response',
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : undefined,
      });
    }
    return;
  }
  if (message.type === 'shutdown') {
    send(state, {
      type: 'response',
      id: message.id,
      ok: true,
      result: { stopping: true, pid: process.pid },
    });
    setImmediate(() => void stop(message.reason ?? 'remote-request'));
    return;
  }

  activeRequests++;
  try {
    const result = await dispatchOperation(state, message);
    if (!state.cancelled.has(message.id)) {
      send(state, { type: 'response', id: message.id, ok: true, result });
    }
  } catch (error) {
    if (!state.cancelled.has(message.id)) {
      send(state, {
        type: 'response',
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : undefined,
      });
    }
  } finally {
    activeRequests--;
    state.cancel.delete(message.id);
    state.cancelled.delete(message.id);
  }
}

function isIgnoredRelativePath(relativePath: string): boolean {
  return relativePath.split(/[/\\]/u).some((segment) => DEFAULT_WALK_IGNORE_SET.has(segment));
}

function enqueueExternalFile(file: string): void {
  const previous = externalDebounceTimers.get(file);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(() => {
    externalDebounceTimers.delete(file);
    externalReadyFiles.add(file);
    if (!externalReadyFlush) {
      externalReadyFlush = setImmediate(() => {
        externalReadyFlush = undefined;
        const files = [...externalReadyFiles].sort();
        externalReadyFiles.clear();
        void withIndexWrite((onProgress) =>
          indexService(
            {
              projectRoot,
              indexDir,
              files,
            },
            { onProgress },
          ),
        ).catch(() => {
          // External indexing is best effort. A subsequent explicit request
          // surfaces errors through the normal RPC/circuit-breaker path.
        });
      });
      externalReadyFlush.unref?.();
    }
  }, externalDebounceMs);
  timer.unref?.();
  externalDebounceTimers.set(file, timer);
}

function ensureExternalWatcher(): void {
  if (externalWatcher) return;
  externalWatcher = watchProjectTree(
    projectRoot,
    ({ filename }) => {
      if (!filename || isIgnoredRelativePath(filename)) return;
      const absolute = path.resolve(projectRoot, filename);
      const relative = path.relative(projectRoot, absolute);
      if (
        relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative) ||
        !isIndexablePath(absolute)
      ) {
        return;
      }
      enqueueExternalFile(absolute);
    },
    {
      onError: () => {
        // Watch errors are non-fatal; explicit edit/startup requests remain
        // available through the same server.
      },
    },
  );
}

function stopExternalWatcher(): void {
  try {
    externalWatcher?.close();
  } catch {
    /* already closed */
  }
  externalWatcher = undefined;
  for (const timer of externalDebounceTimers.values()) clearTimeout(timer);
  externalDebounceTimers.clear();
  if (externalReadyFlush) clearImmediate(externalReadyFlush);
  externalReadyFlush = undefined;
  externalReadyFiles.clear();
}

function reconcileExternalWatcher(): void {
  const owners = [...clients].filter((client) => client.watchExternal);
  if (owners.length === 0) {
    externalDebounceMs = DEFAULT_EXTERNAL_DEBOUNCE_MS;
    stopExternalWatcher();
    return;
  }
  externalDebounceMs = Math.min(...owners.map((client) => client.debounceMs));
  ensureExternalWatcher();
}

function consume(state: ClientState, chunk: string): void {
  state.buffer += chunk;
  while (true) {
    const newline = state.buffer.indexOf('\n');
    if (newline < 0) {
      if (state.buffer.length > PROJECT_INDEX_SERVER_MAX_FRAME_CHARS) {
        state.socket.destroy(new Error('codebase-index client message exceeds the IPC limit'));
      }
      return;
    }
    if (newline > PROJECT_INDEX_SERVER_MAX_FRAME_CHARS) {
      state.socket.destroy(new Error('codebase-index client message exceeds the IPC limit'));
      return;
    }
    const line = state.buffer.slice(0, newline);
    state.buffer = state.buffer.slice(newline + 1);
    if (!line) continue;
    let message: ProjectServerClientMessage;
    try {
      message = JSON.parse(line) as ProjectServerClientMessage;
    } catch {
      state.socket.destroy(new Error('invalid codebase-index client message'));
      return;
    }
    state.lastSeenAt = Date.now();
    void handleMessage(state, message);
  }
}

function scheduleIdleStop(): void {
  if (stopping || clients.size > 0) return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void stop('idle-timeout'), idleMs);
  idleTimer.unref?.();
}

function removeMetadataIfOwned(): void {
  try {
    const current = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as { pid?: number };
    if (current.pid === process.pid) fs.rmSync(metadataPath, { force: true });
  } catch {
    /* absent or owned by a successor */
  }
}

async function writeMetadata(): Promise<void> {
  fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
  // The token lives ONLY in this owner-only file, never on the wire (WS-027).
  const metadata: ProjectIndexServerMetadata = { ...serverInfo, authToken };
  // WS-059: this was a hand-rolled write + rename whose catch did
  // `rmSync(metadataPath)` then retried. The old comment justified that as
  // safe because the socket already elected this process the sole owner —
  // but ownership was never the risk. The risk is the window: between the
  // `rm` and the retry `rename` the metadata file does not exist, and a
  // client that reads it right then concludes there is no daemon and spawns
  // a second one. On Windows the rename fails whenever a reader holds the
  // destination, so that branch was the common path, not the edge case.
  //
  // `atomicWrite` replaces in place with a bounded rename retry and never
  // unlinks the destination, so the file is present at every instant. The
  // mailbox, chronicle and SAGE daemons already moved onto it.
  await atomicWrite(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  // `mode: 0o600` is honored on POSIX but ignored by Node on Windows, where
  // the file inherits the parent directory's ACLs instead — and the IPC
  // endpoint excludes nobody on Windows either, so a readable metadata file
  // hands the per-process token to any local account. Strips inherited ACEs
  // and grants the owner alone.
  await restrictFilePermissions(metadataPath, {
    label: 'codebase-index-metadata',
    warn: (message) => process.stderr.write(`${message}\n`),
  });
}

const server = net.createServer((socket) => {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  socket.setEncoding('utf8');
  socket.setKeepAlive(true, 30_000);
  const state: ClientState = {
    socket,
    buffer: '',
    cancelled: new Set(),
    cancel: new Map(),
    watchExternal: false,
    debounceMs: DEFAULT_EXTERNAL_DEBOUNCE_MS,
    lastSeenAt: Date.now(),
  };
  clients.add(state);
  // Greet only once the token is readable on disk — see `metadataWritten`.
  void metadataWritten.then(() => {
    if (socket.destroyed) return;
    send(state, { type: 'hello', ...serverInfo });
    send(state, { type: 'index-state', state: indexActivity });
  });
  socket.on('data', (chunk: string) => consume(state, chunk));
  socket.on('close', () => {
    for (const cancel of state.cancel.values()) cancel();
    state.cancel.clear();
    clients.delete(state);
    try {
      reconcileExternalWatcher();
    } catch {
      /* remaining clients can retry configuration */
    }
    scheduleIdleStop();
  });
  socket.on('error', () => {
    // close owns cleanup
  });
});

const clientLeaseTimer = setInterval(() => {
  const staleBefore = Date.now() - clientLeaseMs;
  for (const client of clients) {
    if (client.lastSeenAt < staleBefore) {
      client.socket.destroy(new Error('codebase-index client heartbeat lease expired'));
    }
  }
}, clientLeaseSweepMs);
clientLeaseTimer.unref?.();

async function stop(_reason: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  clearInterval(clientLeaseTimer);
  for (const state of clients) {
    for (const cancel of state.cancel.values()) cancel();
    state.socket.end();
  }
  activeFullIndex?.controller.abort(new Error('codebase-index server stopping'));
  stopExternalWatcher();
  indexStorePool.closeAll();
  removeMetadataIfOwned();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    const timer = setTimeout(() => {
      for (const state of clients) state.socket.destroy();
      resolve();
    }, 500);
    timer.unref?.();
  });
  if (process.platform !== 'win32') {
    try {
      fs.rmSync(endpoint, { force: true });
    } catch {
      /* already removed */
    }
  }
  await stopMemoryWatchdog();
}

// The bind is the ownership election, and `bindProjectEndpoint` reclaims an
// endpoint whose owner died without cleanup. Treating that case as a plain
// EADDRINUSE — as this daemon did — makes one SIGKILL wedge the project's
// index permanently: the stale socket refuses clients, and every replacement
// daemon exits on the file it could safely have removed.
void (async () => {
  const bind = await bindProjectEndpoint({ server, endpoint, service: 'codebase-index' });
  if (bind.outcome === 'already-owned') {
    process.exitCode = 0;
    return;
  }
  if (bind.outcome === 'failed') {
    process.stderr.write(`codebase-index server failed: ${bind.error.message}\n`);
    process.exitCode = 1;
    return;
  }
  if (bind.reclaimedStaleEndpoint) {
    process.stderr.write(`codebase-index server reclaimed stale endpoint ${endpoint}\n`);
  }
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (stopping) return;
    process.stderr.write(`codebase-index server error: ${error.message}\n`);
    process.exitCode = 1;
  });
  await writeMetadata();
  markMetadataWritten?.();
  scheduleIdleStop();
})();

process.once('SIGINT', () => void stop('SIGINT'));
process.once('SIGTERM', () => void stop('SIGTERM'));
