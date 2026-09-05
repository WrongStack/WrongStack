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
import { startSharedHeapWatchdog, useDaemonPerfDefaults } from '@wrongstack/core/utils';
import { bindProjectEndpoint } from '@wrongstack/persistence';
import { indexService } from './index-service.js';
import {
  PROJECT_INDEX_SERVER_PROTOCOL_VERSION,
  projectIndexServerBuildId,
  projectIndexServerEndpoint,
  projectIndexServerMetadataPath,
} from './project-server-endpoint.js';
import { consumeClientChunk, sendServerMessage } from './project-server-framing.js';
import {
  armCodebaseIndexSignalGuard,
  removeMetadataIfOwned,
  writeProjectServerMetadata,
} from './project-server-lifecycle.js';
import { dispatchOperation, type OperationContext } from './project-server-operations.js';
import type {
  ProjectIndexServerActivity,
  ProjectIndexServerHealth,
  ProjectIndexServerInfo,
  ProjectIndexServerMetadata,
  ProjectServerClientMessage,
  ProjectServerMessage,
} from './project-server-protocol.js';
import { ServerQueryCaches } from './project-server-query-cache.js';
import type { ActiveFullIndex, ClientState } from './project-server-types.js';
import {
  DEFAULT_EXTERNAL_COALESCE_WINDOW_MS,
  DEFAULT_EXTERNAL_DEBOUNCE_MS,
  ProjectServerWatcherManager,
} from './project-server-watcher.js';
import { WalMaintenance } from './wal-maintenance.js';
import { indexStorePool, resolveIndexDir } from './writer.js';

const DEFAULT_IDLE_MS = 5 * 60_000;
const DEFAULT_CLIENT_LEASE_MS = 45_000;

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
const idleMsRaw = Number(process.env['WRONGSTACK_INDEX_SERVER_IDLE_MS']?.replaceAll('_', ''));
const idleMs = Number.isFinite(idleMsRaw) && idleMsRaw >= 100 ? idleMsRaw : DEFAULT_IDLE_MS;
const clientLeaseMsRaw = Number(
  process.env['WRONGSTACK_INDEX_SERVER_CLIENT_LEASE_MS']?.replaceAll('_', ''),
);
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
      // P2: FTS5 segment merge once churn justifies it — best-effort and
      // gated, so a clean index pays only one metadata read + one COUNT.
      store.optimizeFtsIfNeeded();
    } finally {
      indexStorePool.release(store);
    }
  },
});

function send(state: ClientState, message: ProjectServerMessage): void {
  sendServerMessage(state, message);
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

const watcherManager = new ProjectServerWatcherManager({
  projectRoot,
  onFilesChanged: (files) => {
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
  },
});

function serverHealth(): ProjectIndexServerHealth {
  const memory = process.memoryUsage();
  const now = Date.now();
  let watchingClients = 0;
  let oldestClientIdleMs = 0;
  for (const client of clients) {
    if (client.watchExternal) watchingClients++;
    const idle = Math.max(0, now - client.lastSeenAt);
    if (idle > oldestClientIdleMs) oldestClientIdleMs = idle;
  }
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
    pendingExternalFiles: watcherManager.pendingFileCount,
    watchingExternal: watcherManager.isWatching,
    watchingClients,
    clientLeaseTimeoutMs: clientLeaseMs,
    oldestClientIdleMs,
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

const operationContext: OperationContext = {
  projectRoot,
  indexDir,
  queryCaches,
  getActivity: () => indexActivity,
  withIndexWrite,
  send,
  getActiveFullIndex: () => activeFullIndex,
  setActiveFullIndex: (active) => {
    activeFullIndex = active;
  },
};

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
      watcherManager.reconcile(clients);
      send(state, {
        type: 'response',
        id: message.id,
        ok: true,
        result: {
          watching: watcherManager.isWatching,
          health: serverHealth(),
        },
      });
    } catch (error) {
      state.watchExternal = previousWatchExternal;
      state.debounceMs = previousDebounceMs;
      state.coalesceWindowMs = previousCoalesceWindowMs;
      try {
        watcherManager.reconcile(clients);
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
    const result = await dispatchOperation(operationContext, state, message);
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

function consume(state: ClientState, chunk: Buffer): void {
  consumeClientChunk(state, chunk, handleMessage);
}

function scheduleIdleStop(): void {
  if (stopping || clients.size > 0) return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void stop('idle-timeout'), idleMs);
  idleTimer.unref?.();
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
      watcherManager.reconcile(clients);
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
  watcherManager.stop();
  walMaintenance.dispose();
  indexStorePool.closeAll();
  removeMetadataIfOwned(metadataPath, process.pid);
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
  const metadata: ProjectIndexServerMetadata = { ...serverInfo, authToken };
  await writeProjectServerMetadata(metadataPath, metadata);
  markMetadataWritten?.();
  scheduleIdleStop();
})();

armCodebaseIndexSignalGuard(stop);
