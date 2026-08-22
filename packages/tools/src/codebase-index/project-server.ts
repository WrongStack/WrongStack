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
import {
  decodeBinaryFrame,
  encodeBinaryFrame,
  isBinaryFrame,
  MAX_INBOUND_BINARY_FRAME_BYTES,
} from './binary-frame.js';
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
import {
  indexRefreshInProgressError,
  ServerQueryCaches,
  staleAwareRead,
} from './project-server-query-cache.js';
import { WalMaintenance } from './wal-maintenance.js';
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
  /**
   * Raw inbound bytes. Frames may be newline-delimited JSON or length-
   * prefixed binary (magic 0x57); the mode is sniffed per frame. Kept as
   * bytes because a JSON text line may split a multibyte UTF-8 sequence at a
   * chunk boundary — the StringDecoder handles that at parse time.
   */
  buffer: Buffer;
  cancelled: Set<number>;
  cancel: Map<number, () => void>;
  watchExternal: boolean;
  debounceMs: number;
  coalesceWindowMs: number;
  lastSeenAt: number;
  /** True once this client has sent at least one binary frame. */
  binary: boolean;
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
  // P6: this build can switch to binary framing after the handshake — the
  // client opts in by sending its first frame in binary form; the server
  // mirrors per-frame, so JSON-only clients keep working unchanged.
  binarySupported: true,
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
/**
 * Generation-scoped read caches with the stale-serve policy from
 * project-server-query-cache.ts: a refresh serves previous-generation hits
 * flagged `stale`, and incremental completions keep the caches alive.
 */
const queryCaches = new ServerQueryCaches();
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
    ...queryCaches.sizes(),
  }),
});
let lastProgressBroadcastAt = 0;
let externalWatcher: ProjectWatchSubscription | undefined;
const DEFAULT_EXTERNAL_DEBOUNCE_MS = 400;
const DEFAULT_EXTERNAL_COALESCE_WINDOW_MS = 50;
let externalDebounceMs = DEFAULT_EXTERNAL_DEBOUNCE_MS;
let externalCoalesceWindowMs = DEFAULT_EXTERNAL_COALESCE_WINDOW_MS;
const externalDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const externalReadyFiles = new Set<string>();
let externalReadyFlush: ReturnType<typeof setTimeout> | undefined;

function clearQueryCaches(): void {
  queryCaches.clear();
}

/**
 * P4.14: idle-time WAL maintenance. Armed after every completed write run
 * (success or failure — both leave WAL frames behind); fires once the write
 * stream has been quiet for the idle window. All timers unref'd so this can
 * never delay the daemon's own idle exit.
 */
const walMaintenance = new WalMaintenance({
  checkpoint: () => {
    const store = indexStorePool.acquire(projectRoot, { indexDir });
    try {
      return store.checkpointWal();
    } finally {
      indexStorePool.release(store);
    }
  },
  optimize: () => {
    const store = indexStorePool.acquire(projectRoot, { indexDir });
    try {
      store.optimize();
    } finally {
      indexStorePool.release(store);
    }
  },
});

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
  // Reply in the framing this connection negotiated: a client that has sent
  // at least one binary frame gets binary frames back; JSON-only clients
  // (and the pre-first-frame greeting) get newline-delimited JSON.
  state.socket.write(
    state.binary ? encodeBinaryFrame(message) : encodeProjectServerMessage(message),
  );
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

/**
 * Cache policy at write-run completion.
 *
 * A run with an explicit targeted file list (edit/watcher reindex) makes a
 * per-file surgical change, so — on success — every previous-generation entry
 * stays valid as a stale answer for the NEXT refresh. On failure the run's
 * transaction rolls back, which equally leaves the cached entries describing
 * the on-disk truth. (Precision: the rollback is per-file — a multi-file
 * targeted run commits the files that parsed and rolls back only the failed
 * one — but each file's slice is atomic, and queries never straddle slices,
 * so cached answers stay correct.) Anything else (full scan, force rebuild,
 * langs/ignore-filtered scan) can reshape the whole index, so its caches are
 * dropped on completion and on failure alike.
 */
function preservesQueryCaches(args: IndexOpArgs): boolean {
  return !args.force && args.files !== undefined && args.files.length > 0;
}

function withIndexWrite<T>(
  job: (onProgress: (currentFile: number, totalFiles: number) => void) => Promise<T>,
  options: { preserveCaches: boolean },
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
      if (!options.preserveCaches) clearQueryCaches();
      broadcastIndexActivity();
      walMaintenance.notifyWriteCompleted();
      return result;
    } catch (error) {
      indexActivity = {
        ...indexActivity,
        indexing: false,
        generation: indexActivity.generation + 1,
        updatedAt: Date.now(),
        lastError: error instanceof Error ? error.message : String(error),
      };
      if (!options.preserveCaches) clearQueryCaches();
      broadcastIndexActivity();
      walMaintenance.notifyWriteCompleted();
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
    const promise = withIndexWrite(
      (reportProgress) =>
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
      // Shareable full index: whole-index scope, caches drop on completion.
      { preserveCaches: false },
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
      return withIndexWrite(
        (reportProgress) =>
          indexService(fixedArgs(args), {
            signal: controller.signal,
            onProgress: (current, total) => {
              reportProgress(current, total);
              if (!state.cancelled.has(id)) send(state, { type: 'progress', id, current, total });
            },
          }),
        { preserveCaches: preservesQueryCaches(args) },
      );
    }
    case 'search': {
      const { value, stale } = staleAwareRead(
        queryCaches.searchCache,
        JSON.stringify(message.args),
        indexActivity,
        () => searchService(fixedArgs(message.args as SearchOpArgs)),
      );
      return stale ? { ...value, stale: true } : value;
    }
    case 'stats':
      // Stats is the refresh progress poll: serving a cached pre-run answer
      // would read as "finished" with stale numbers, so it keeps refusing
      // for the whole refresh even on a cache hit.
      if (indexActivity.indexing) {
        throw indexRefreshInProgressError(indexActivity.currentFile, indexActivity.totalFiles);
      }
      return staleAwareRead(queryCaches.statsCache, 'stats', indexActivity, () =>
        statsService(fixedArgs(message.args as StatsOpArgs)),
      ).value;
    case 'packageGraph': {
      const { value, stale } = staleAwareRead(
        queryCaches.packageGraphCache,
        'package',
        indexActivity,
        () => packageGraphService(fixedArgs(message.args as StatsOpArgs)),
      );
      return stale ? { ...value, stale: true } : value;
    }
    case 'fileGraph': {
      const key = (message.args as FileGraphOpArgs).packageFilter;
      const { value, stale } = staleAwareRead(queryCaches.fileGraphCache, key, indexActivity, () =>
        fileGraphService(fixedArgs(message.args as FileGraphOpArgs)),
      );
      return stale ? { ...value, stale: true } : value;
    }
    case 'symbolGraph': {
      const key = (message.args as SymbolGraphOpArgs).fileFilter;
      const { value, stale } = staleAwareRead(
        queryCaches.symbolGraphCache,
        key,
        indexActivity,
        () => symbolGraphService(fixedArgs(message.args as SymbolGraphOpArgs)),
      );
      return stale ? { ...value, stale: true } : value;
    }
    case 'incomingCalls': {
      const callArgs = fixedArgs(message.args as CallRefsOpArgs);
      const cacheKey = JSON.stringify([
        callArgs.symbol,
        callArgs.file ?? '',
        callArgs.limit ?? 100,
        callArgs.transitive ?? false,
      ]);
      const { value, stale } = staleAwareRead(
        queryCaches.incomingCallsCache,
        cacheKey,
        indexActivity,
        () => incomingCallsService(callArgs),
      );
      return stale ? { ...value, stale: true } : value;
    }
    case 'outgoingCalls': {
      const callArgs = fixedArgs(message.args as CallRefsOpArgs);
      const cacheKey = JSON.stringify([
        callArgs.symbol,
        callArgs.file ?? '',
        callArgs.limit ?? 100,
        callArgs.transitive ?? false,
      ]);
      const { value, stale } = staleAwareRead(
        queryCaches.outgoingCallsCache,
        cacheKey,
        indexActivity,
        () => outgoingCallsService(callArgs),
      );
      return stale ? { ...value, stale: true } : value;
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
    const previousCoalesceWindowMs = state.coalesceWindowMs;
    try {
      state.watchExternal = message.watchExternal;
      state.debounceMs = Math.max(0, message.debounceMs);
      state.coalesceWindowMs = Math.max(
        0,
        message.coalesceWindowMs ?? DEFAULT_EXTERNAL_COALESCE_WINDOW_MS,
      );
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
      state.coalesceWindowMs = previousCoalesceWindowMs;
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
    // Sliding coalescing window: each file that arrives resets the flush
    // timer so a staggered burst (formatter-on-save touching several files
    // over ~10-50ms) stays open until the gap between arrivals exceeds the
    // window. windowMs=0 falls back to immediate flush via setTimeout(fn, 0).
    if (externalReadyFlush) clearTimeout(externalReadyFlush);
    externalReadyFlush = setTimeout(() => {
      externalReadyFlush = undefined;
      const files = [...externalReadyFiles].sort();
      externalReadyFiles.clear();
      void withIndexWrite(
        (onProgress) =>
          indexService(
            {
              projectRoot,
              indexDir,
              files,
            },
            { onProgress },
          ),
        // Watcher runs are targeted file lists — keep the caches so the next
        // refresh's stale-serve window has previous-generation answers.
        { preserveCaches: true },
      ).catch(() => {
        // External indexing is best effort. A subsequent explicit request
        // surfaces errors through the normal RPC/circuit-breaker path.
      });
    }, externalCoalesceWindowMs);
    externalReadyFlush.unref?.();
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
  if (externalReadyFlush) clearTimeout(externalReadyFlush);
  externalReadyFlush = undefined;
  externalReadyFiles.clear();
}

function reconcileExternalWatcher(): void {
  const owners = [...clients].filter((client) => client.watchExternal);
  if (owners.length === 0) {
    externalDebounceMs = DEFAULT_EXTERNAL_DEBOUNCE_MS;
    externalCoalesceWindowMs = DEFAULT_EXTERNAL_COALESCE_WINDOW_MS;
    stopExternalWatcher();
    return;
  }
  externalDebounceMs = Math.min(...owners.map((client) => client.debounceMs));
  externalCoalesceWindowMs = Math.min(...owners.map((client) => client.coalesceWindowMs));
  ensureExternalWatcher();
}

/**
 * Frame reader for one client connection. Each frame is sniffed per first
 * byte: `0x57` ('W') → length-prefixed MessagePack, anything else →
 * newline-delimited JSON text. Bytes stay raw until a complete frame is
 * assembled, so a multibyte UTF-8 sequence split across chunks is only ever
 * decoded as part of a finished line (raw `0x0a` only occurs as the JSON
 * delimiter — inside JSON strings `\n` is escaped — so a complete line is
 * always complete UTF-8).
 *
 * The buffer is consumed with a scan offset rather than re-slicing after
 * every frame: each parsed frame advances `scan` within the same Buffer,
 * and the leftover tail is compacted once at the end of the call. A burst
 * of small frames therefore costs one allocation per chunk, not one
 * per frame (the previous slice-per-frame loop reallocated on every frame
 * while pinning the whole parent buffer).
 */
function consume(state: ClientState, chunk: Buffer): void {
  const buffer = state.buffer.length === 0 ? chunk : Buffer.concat([state.buffer, chunk]);
  let scan = 0;
  while (true) {
    if (buffer.length - scan === 0) break;
    if (isBinaryFrame(buffer[scan]!)) {
      if (buffer.length - scan < 5) break; // header not fully received yet
      const frameLen = buffer.readUInt32BE(scan + 1);
      // Inbound frames are client requests, checked against the inbound cap
      // the moment the five-byte header completes: the connection is
      // destroyed without waiting for or accumulating the declared payload.
      // This direction is unauthenticated at framing time.
      if (frameLen > MAX_INBOUND_BINARY_FRAME_BYTES) {
        state.buffer = Buffer.alloc(0);
        state.socket.destroy(new Error('codebase-index client binary frame exceeds the IPC limit'));
        return;
      }
      if (buffer.length - scan < 5 + frameLen) break; // payload incomplete
      const payload = buffer.subarray(scan + 5, scan + 5 + frameLen);
      let message: ProjectServerClientMessage;
      try {
        message = decodeBinaryFrame(payload) as ProjectServerClientMessage;
      } catch {
        state.buffer = Buffer.alloc(0);
        state.socket.destroy(new Error('invalid codebase-index client binary frame'));
        return;
      }
      scan += 5 + frameLen;
      state.binary = true;
      state.lastSeenAt = Date.now();
      void handleMessage(state, message);
      continue;
    }
    const newline = buffer.indexOf(0x0a, scan);
    if (newline < 0) {
      if (buffer.length - scan > PROJECT_INDEX_SERVER_MAX_FRAME_CHARS) {
        state.buffer = Buffer.alloc(0);
        state.socket.destroy(new Error('codebase-index client message exceeds the IPC limit'));
        // Like every other destroy path: return, so the post-loop
        // compaction cannot resurrect bytes from the stale local buffer.
        return;
      }
      break;
    }
    if (newline - scan > PROJECT_INDEX_SERVER_MAX_FRAME_CHARS) {
      state.buffer = Buffer.alloc(0);
      state.socket.destroy(new Error('codebase-index client message exceeds the IPC limit'));
      return;
    }
    const line = buffer.subarray(scan, newline).toString('utf8');
    scan = newline + 1;
    if (!line) continue;
    let message: ProjectServerClientMessage;
    try {
      message = JSON.parse(line) as ProjectServerClientMessage;
    } catch {
      state.buffer = Buffer.alloc(0);
      state.socket.destroy(new Error('invalid codebase-index client message'));
      return;
    }
    state.lastSeenAt = Date.now();
    void handleMessage(state, message);
  }
  // Compact the parsed prefix once per chunk instead of once per frame.
  // The tail is COPIED into a right-sized buffer: subarray would pin the
  // whole parent allocation, so an unauthenticated client sending a
  // near-64 MiB frame followed by a one-byte partial would hold ~64 MiB
  // per connection until more data arrived or the lease expired.
  state.buffer = scan === 0 ? buffer : Buffer.from(buffer.subarray(scan));
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
    warn: (message: string) => process.stderr.write(`${message}\n`),
  });
}

const server = net.createServer((socket) => {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  // No setEncoding: the reader needs raw bytes to sniff binary frames.
  socket.setKeepAlive(true, 30_000);
  const state: ClientState = {
    socket,
    buffer: Buffer.alloc(0),
    cancelled: new Set(),
    cancel: new Map(),
    watchExternal: false,
    debounceMs: DEFAULT_EXTERNAL_DEBOUNCE_MS,
    coalesceWindowMs: DEFAULT_EXTERNAL_COALESCE_WINDOW_MS,
    lastSeenAt: Date.now(),
    binary: false,
  };
  clients.add(state);
  // Greet only once the token is readable on disk — see `metadataWritten`.
  void metadataWritten.then(() => {
    if (socket.destroyed) return;
    send(state, { type: 'hello', ...serverInfo });
    send(state, { type: 'index-state', state: indexActivity });
  });
  socket.on('data', (chunk: Buffer) => consume(state, chunk));
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
  walMaintenance.dispose();
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
