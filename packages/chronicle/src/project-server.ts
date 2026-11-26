#!/usr/bin/env node
/**
 * One detached Chronicle owner per local project.
 *
 * Event mapping and secret scrubbing remain in the originating process. This
 * server owns ordering/hash chaining, partition rotation, retention, the
 * project file watcher, derived metrics, and journal queries.
 */
import { randomBytes } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import { restrictFilePermissions } from '@wrongstack/core/security';
import {
  atomicWrite,
  startSharedHeapWatchdog,
  useDaemonPerfDefaults,
} from '@wrongstack/core/utils';
import { bindProjectEndpoint, createProjectMetadataReasserter } from '@wrongstack/persistence';
import { timingSafeTokenEqual, WRONGSTACK_RUNTIME_VERSION } from '@wrongstack/primitives';
import { type ChronicleContext, createChronicleContext } from './context.js';
import { type ChronicleFileObserver, startChronicleFileObserver } from './file-observer.js';
import { resolveChronicleRuntimeLocation } from './identity.js';
import { ChronicleJournal, type ChronicleJournalStats } from './journal.js';
import { importLegacyChronicleJournal } from './legacy-journal-import.js';
import { ChronicleMetricsStore } from './metrics-store.js';
import { ChroniclePartitionRangeCache } from './partition-range-cache.js';
import { dispatchChronicle } from './project-server-dispatch.js';
import {
  chronicleProjectServerEndpoint,
  chronicleProjectServerMetadataPath,
} from './project-server-endpoint.js';
import {
  type ClientState,
  encodeResponse,
  legacyPartitionPath,
  parseArgs,
  pruneJournals,
  resolveChronicleServerTimings,
  useSqliteStore,
} from './project-server-options.js';
import {
  CHRONICLE_MAX_APPEND_BATCH,
  CHRONICLE_PROJECT_SERVER_MAX_FRAME_CHARS,
  CHRONICLE_PROJECT_SERVER_PROTOCOL_VERSION,
  type ChronicleProjectServerClientMessage,
  type ChronicleProjectServerHealth,
  type ChronicleProjectServerInfo,
  type ChronicleProjectServerMessage,
  type ChronicleProjectServerMetadata,
  type ChronicleServerOperations,
} from './project-server-protocol.js';
import { armChronicleSignalGuard } from './project-server-signal-guard.js';
import { ChronicleQueryEngine } from './query.js';
import type { ChronicleEventSink } from './sink.js';
import { type ChronicleQuarantinedFamily, ChronicleSqliteJournal } from './sqlite-journal.js';
import type { ChronicleSqliteQueryEngine } from './sqlite-query.js';
import type { ChronicleEvent, ChronicleEventInput } from './types.js';

/** Re-exported name kept local for readability; the bound is the protocol's. */
const MAX_APPEND_BATCH = CHRONICLE_MAX_APPEND_BATCH;

// Long-lived daemon: lean SQLite residency unless the operator says
// otherwise. Must run before any store opens.
useDaemonPerfDefaults();

const parsed = parseArgs(process.argv.slice(2));
const chronicleDirectory = path.join(parsed.projectDir, 'chronicle');
const endpoint = chronicleProjectServerEndpoint(parsed.projectDir);
const metadataPath = chronicleProjectServerMetadataPath(parsed.projectDir);
// `silentClientMs` reaps sockets that connected and never spoke; see
// resolveChronicleServerTimings for why that keeps idle shutdown reachable.
const { idleMs, silentClientMs, silentSweepMs } = resolveChronicleServerTimings(process.env);
const startedAt = new Date().toISOString();
/**
 * Per-process auth token. WS-027: this daemon owns the project's chronicle —
 * the durable record of what every agent did — and admitted anything that
 * could open the socket, to read it or append to it. The 0600 socket only
 * excludes OTHER users, and on Windows it does not even do that.
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

const serverInfo: ChronicleProjectServerInfo = {
  runtimeVersion: WRONGSTACK_RUNTIME_VERSION,
  protocolVersion: CHRONICLE_PROJECT_SERVER_PROTOCOL_VERSION,
  pid: process.pid,
  projectRoot: parsed.projectRoot,
  projectDir: parsed.projectDir,
  chronicleDirectory,
  endpoint,
  startedAt,
};

process.title = `wrongstack-chronicle:${path.basename(parsed.projectRoot)}`;

const clients = new Set<ClientState>();
const journals = new Map<string, ChronicleJournal>();
let activeRequests = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let silentClientSweep: ReturnType<typeof setInterval> | undefined;
let stopping = false;
/** The startup metadata write; `stop()` waits on it before removing the file. */
let metadataWrite: Promise<void> | undefined;
let watcher: ChronicleFileObserver | undefined;
let watcherLastError: string | undefined;
let queryGeneration = 0;
let cachedQuery: { generation: number; engine: ChronicleQueryEngine } | undefined;
let metricsStore: ChronicleMetricsStore | undefined;
let partitionRangeCache: ChroniclePartitionRangeCache | undefined;
let metricsRefresh:
  | Promise<ChronicleServerOperations['metrics']['result']['refreshed']>
  | undefined;
const pendingMutationHints: Parameters<ChronicleFileObserver['noteToolMutation']>[0][] = [];
const stopMemoryWatchdog = startSharedHeapWatchdog({
  collectStats: () => ({
    surface: 'chronicle-project-server',
    clients: clients.size,
    journals: journals.size,
    activeRequests,
    pendingMutationHints: pendingMutationHints.length,
    queryGeneration,
    cachedQuery: cachedQuery !== undefined,
  }),
});

let sqliteStore: Promise<ChronicleSqliteJournal> | undefined;

/** Day families the legacy import refused; surfaced by `ping` so health degrades. */
let quarantinedFamilies: ChronicleQuarantinedFamily[] = [];

/**
 * Open the store, importing the legacy partitions the first time.
 *
 * The import is folded into opening so no request can observe a half-migrated
 * journal: everything queues behind this one promise.
 */
function store(): Promise<ChronicleSqliteJournal> {
  sqliteStore ??= (async () => {
    await fsp.mkdir(chronicleDirectory, { recursive: true });
    // Constructed INSIDE the try: the constructor opens the SQLite handle and
    // switches it to WAL before any step that can fail (a corrupt file, a
    // read-only directory, a full disk all throw from ensureChronicleSchema or
    // the quota manager). Constructed outside, such a throw would escape every
    // catch below — the rejected promise stayed memoized for the daemon's
    // lifetime (every later request re-awaited the same rejection) AND the
    // already-open handle leaked with its write-ahead log. `journal` is typed
    // as possibly-undefined so the catch can close a handle that exists; when
    // the constructor itself threw, there is nothing to close and the memo
    // reset is the whole repair.
    let journal: ChronicleSqliteJournal | undefined;
    try {
      journal = new ChronicleSqliteJournal({
        directory: chronicleDirectory,
        retentionDays: parsed.retentionDays,
        durability: parsed.durability,
        maxEvents: parsed.maxEvents,
        maxBytes: parsed.maxBytes,
      });
      const result = await importLegacyChronicleJournal(journal, chronicleDirectory);
      quarantinedFamilies = result.quarantined;
    } catch (error) {
      // Caching a rejected promise poisons the daemon for its whole lifetime:
      // every later request awaits the same rejection, and the handle above
      // keeps the database — and its write-ahead log — open the entire time.
      // Drop both so the next request gets a real retry.
      sqliteStore = undefined;
      journal?.close();
      throw error;
    }
    return journal;
  })();
  return sqliteStore;
}

function journalForToday(): ChronicleJournal {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  let journal = journals.get(day);
  if (!journal) {
    const location = resolveChronicleRuntimeLocation({
      globalRoot: parsed.globalRoot,
      projectId: parsed.projectId,
      projectDir: parsed.projectDir,
      now,
    });
    journal = new ChronicleJournal({
      filePath: legacyPartitionPath(location),
      retentionDays: parsed.retentionDays,
    });
    journals.set(day, journal);
    pruneJournals(journals, day);
  }
  return journal;
}

const runtimeLocation = resolveChronicleRuntimeLocation({
  globalRoot: parsed.globalRoot,
  projectId: parsed.projectId,
  projectDir: parsed.projectDir,
});
const serverContext: ChronicleContext = createChronicleContext({
  installationId: runtimeLocation.installationId,
  machineId: runtimeLocation.machineId,
  projectId: parsed.projectId,
  workspaceId: parsed.workspaceId,
});

function noteMutation(input: ChronicleEventInput): void {
  if (
    input.eventType !== 'file.mutation.observed' ||
    input.resource?.kind !== 'file' ||
    !input.resource.path ||
    !input.correlation.toolCallId
  ) {
    return;
  }
  const toolName = input.attributes?.['toolName'];
  if (typeof toolName !== 'string' || !toolName) return;
  const at = input.occurredAt ? Date.parse(input.occurredAt) : Number.NaN;
  const hint = {
    path: input.resource.path,
    toolUseId: input.correlation.toolCallId,
    toolName,
    agentId: input.scope.agentId,
    sessionId: input.scope.sessionId,
    ...(Number.isFinite(at) ? { at } : {}),
  };
  if (watcher) watcher.noteToolMutation(hint);
  else {
    if (pendingMutationHints.length >= 1_000) pendingMutationHints.shift();
    pendingMutationHints.push(hint);
  }
}

async function appendInputs(inputs: ChronicleEventInput[]): Promise<ChronicleEvent[]> {
  if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > MAX_APPEND_BATCH) {
    throw new TypeError(`Chronicle append requires 1..${MAX_APPEND_BATCH} inputs`);
  }
  for (const input of inputs) {
    if (!input || typeof input !== 'object' || typeof input.eventType !== 'string') {
      throw new TypeError('Chronicle append received an invalid event input');
    }
    noteMutation(input);
  }
  const events = useSqliteStore()
    ? await (await store()).appendBatch(inputs)
    : await Promise.all(inputs.map((input) => journalForToday().append(input)));
  queryGeneration += events.length;
  return events;
}

const watcherSink: ChronicleEventSink = {
  append: async (input) => (await appendInputs([input]))[0]!,
  // The file observer reconciles a whole burst at once (a branch switch, a
  // build drop). Routing that through `appendInputs` as ONE call keeps it to
  // one `BEGIN IMMEDIATE` + one fsync instead of one per changed file.
  appendBatch: (inputs) => appendInputs([...inputs]),
  flush: async () => flushJournals(),
  stats: () => journalForToday().stats(),
};

async function flushJournals(): Promise<void> {
  if (useSqliteStore()) {
    // Transactional writes leave nothing buffered; this only waits for an
    // in-flight open (and its legacy import).
    if (sqliteStore) await sqliteStore;
    return;
  }
  await Promise.all([...journals.values()].map((journal) => journal.flush()));
}

function rangeCache(): ChroniclePartitionRangeCache {
  partitionRangeCache ??= new ChroniclePartitionRangeCache(chronicleDirectory);
  return partitionRangeCache;
}

async function queryEngine(): Promise<ChronicleQueryEngine | ChronicleSqliteQueryEngine> {
  // The SQLite engine reads through the journal's own connection, so it always
  // sees the latest commit — the generation cache exists only to avoid
  // re-scanning partition files and is meaningless here.
  if (useSqliteStore()) return (await store()).queryEngine();
  if (cachedQuery?.generation === queryGeneration) return cachedQuery.engine;
  const engine = await ChronicleQueryEngine.fromDirectory(chronicleDirectory, {
    rangeCache: rangeCache(),
  });
  cachedQuery = { generation: queryGeneration, engine };
  return engine;
}

function metrics(): ChronicleMetricsStore {
  metricsStore ??= ChronicleMetricsStore.open(chronicleDirectory, {
    rowRetentionDays: parsed.metricsRowRetentionDays,
  });
  return metricsStore;
}

async function refreshMetrics(): Promise<
  ChronicleServerOperations['metrics']['result']['refreshed']
> {
  if (metricsRefresh) return metricsRefresh;
  const run = metrics().refresh();
  metricsRefresh = run;
  try {
    return await run;
  } finally {
    metricsRefresh = undefined;
  }
}

async function serverHealth(): Promise<ChronicleProjectServerHealth> {
  const memory = process.memoryUsage();
  await flushJournals();
  // `ping` is the one call a health probe makes, so it has to open the store:
  // a daemon that answers "healthy" without ever touching its own journal is
  // exactly what let a broken import go unnoticed while nothing was recorded.
  let journalStats: ChronicleJournalStats;
  if (useSqliteStore()) {
    const sqlite = await store();
    quarantinedFamilies = sqlite.quarantinedFamilies();
    journalStats = sqlite.stats();
  } else {
    journalStats = journalForToday().stats();
  }
  return {
    ...serverInfo,
    checkedAt: Date.now(),
    uptimeMs: Math.round(process.uptime() * 1_000),
    clients: clients.size,
    activeRequests,
    journal: journalStats,
    ...(quarantinedFamilies.length > 0 ? { quarantinedFamilies } : {}),
    watcher: {
      active: watcher !== undefined,
      watchedFiles: watcher?.watchedFiles ?? 0,
      ...(watcherLastError ? { lastError: watcherLastError } : {}),
    },
    memory: {
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
      external: memory.external,
    },
  };
}

function send(state: ClientState, message: ChronicleProjectServerMessage): void {
  const encoded = encodeResponse(state, message);
  if (encoded !== undefined) state.socket.write(encoded);
}

async function sendAcknowledgement(
  state: ClientState,
  message: ChronicleProjectServerMessage,
): Promise<void> {
  const encoded = encodeResponse(state, message);
  if (encoded === undefined)
    throw new Error('Chronicle client disconnected before acknowledgement');
  await new Promise<void>((resolve, reject) => {
    state.socket.write(encoded, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function handleMessage(
  state: ClientState,
  message: ChronicleProjectServerClientMessage,
): Promise<void> {
  // WS-027: prove you could read the owner-only metadata file before acting.
  // WS-SEC-LOW: `!==` on a secret returns at the first differing byte, so
  // its timing leaks the shared-prefix length. Every other credential
  // surface in the repo already compares in constant time; these four IPC
  // daemons were the ones that did not.
  if (!timingSafeTokenEqual(message.authToken, authToken)) {
    void metadataGuard.reassert();
    send(state, {
      type: 'response',
      id: message.id,
      ok: false,
      error:
        'Chronicle IPC request rejected: missing or invalid authToken. ' +
        'Reconnect to refresh metadata (server.json#authToken).',
      errorName: 'UnauthorizedChronicleRequest',
    });
    return;
  }
  if (message.type === 'shutdown') {
    await sendAcknowledgement(state, {
      type: 'response',
      id: message.id,
      ok: true,
      result: { stopped: true },
    });
    await stop(message.reason ?? 'client request');
    return;
  }
  activeRequests++;
  state.unsettled.add(message.id);
  try {
    const result = await dispatchChronicle(
      {
        serverHealth,
        appendInputs,
        flushJournals,
        useSqliteStore,
        store,
        journalForToday,
        queryEngine,
        refreshMetrics,
        metrics,
      },
      message.op,
      message.args,
    );
    state.unsettled.delete(message.id);
    send(state, { type: 'response', id: message.id, ok: true, result });
  } catch (error) {
    state.unsettled.delete(message.id);
    send(state, {
      type: 'response',
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : undefined,
    });
  } finally {
    activeRequests--;
    // The client may have hung up while this ran — the socket 'close' handler
    // already tried to arm the idle stop and was refused because work was in
    // flight. Re-arm here or the daemon would linger with nobody attached.
    scheduleIdleStop();
  }
}

function onData(state: ClientState, chunk: string): void {
  state.spoken = true;
  state.buffer += chunk;
  if (state.buffer.length > CHRONICLE_PROJECT_SERVER_MAX_FRAME_CHARS) {
    state.socket.destroy(new Error('Chronicle project server request exceeded frame limit'));
    return;
  }
  while (true) {
    const newline = state.buffer.indexOf('\n');
    if (newline < 0) return;
    const line = state.buffer.slice(0, newline);
    state.buffer = state.buffer.slice(newline + 1);
    if (!line) continue;
    let message: ChronicleProjectServerClientMessage;
    try {
      message = JSON.parse(line) as ChronicleProjectServerClientMessage;
    } catch {
      state.socket.destroy(new Error('Invalid Chronicle project server request'));
      return;
    }
    // JSON `null` parses. handleMessage reads message.authToken, and that
    // throw is an unhandled rejection that exits the daemon. A client message
    // is an object; anything else is the same malformed frame as bad JSON.
    if (typeof message !== 'object' || message === null) {
      state.socket.destroy(new Error('Invalid Chronicle project server request'));
      return;
    }
    void handleMessage(state, message);
  }
}

/**
 * Arm the idle stop, but never while a request is still running.
 *
 * "Idle" has to mean no clients *and* no work — a long operation outlives the
 * connection that asked for it. The legacy import is the extreme case: it runs
 * for minutes inside the first `ping`, so a client that disconnects meanwhile
 * left the daemon counting down and exiting mid-import. Each restart then
 * redid the scan from the top, and because the completion marker is only
 * written at the end, it could never finish. `activeRequests` is decremented
 * in a `finally` that re-arms this, so a hung-up client still gets collected.
 */
function scheduleIdleStop(): void {
  if (stopping || clients.size > 0 || activeRequests > 0 || idleTimer) return;
  idleTimer = setTimeout(() => {
    idleTimer = undefined;
    void stop('idle timeout');
  }, idleMs);
  idleTimer.unref?.();
}

// A daemon of another release can own a different endpoint for this project
// and still write the same metadata file; a refused token puts ours back.
const metadataGuard = createProjectMetadataReasserter({
  metadataPath,
  endpoint,
  pid: process.pid,
  write: writeMetadata,
});

async function writeMetadata(): Promise<void> {
  await fsp.mkdir(path.dirname(metadataPath), { recursive: true });
  // The token lives ONLY in this owner-only file, never on the wire (WS-027).
  const metadata: ChronicleProjectServerMetadata = { ...serverInfo, authToken };
  // WS-059: was a hand-rolled write + rename with an `rm(metadataPath)`
  // fallback. On Windows the rename fails whenever a reader holds the
  // destination, so that fallback was the common path — and between the `rm`
  // and the retry `rename` the file does not exist. A client reading in that
  // window concludes there is no daemon and spawns a second one, breaking the
  // one-daemon-per-project invariant. `atomicWrite` replaces in place with a
  // bounded rename retry and never unlinks the destination first.
  await atomicWrite(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  // `mode: 0o600` is honored on POSIX but ignored by Node on Windows, where
  // the file inherits the parent directory's ACLs instead — and the IPC
  // endpoint excludes nobody on Windows either, so a readable metadata file
  // hands this daemon's per-process token to any local account. Strips
  // inherited ACEs and grants the owner alone.
  await restrictFilePermissions(metadataPath, {
    label: 'chronicle-server-metadata',
    warn: (message) => process.stderr.write(`${message}\n`),
  });
}

async function removeOwnedMetadata(): Promise<void> {
  try {
    const current = JSON.parse(await fsp.readFile(metadataPath, 'utf8')) as { pid?: number };
    if (current.pid === process.pid) await fsp.rm(metadataPath, { force: true });
  } catch {
    // Missing or replaced metadata is not ours to remove.
  }
}

async function stop(_reason: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  await metadataGuard.disable();
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  if (silentClientSweep) clearInterval(silentClientSweep);
  silentClientSweep = undefined;
  // WS-059: remove metadata BEFORE releasing the endpoint. The bind is the
  // ownership election, so while it is still held no successor daemon can
  // exist — and therefore none can have its metadata deleted by the
  // read-then-delete pid compare in `removeOwnedMetadata`. A startup write
  // still in flight would land AFTER the removal and outlive this daemon, so
  // let it settle first.
  await metadataWrite?.catch(() => {});
  await removeOwnedMetadata();
  // Answer in-flight requests BEFORE the transport goes away (unsettled →
  // clean rejection), then end() each socket: end() FLUSHES everything
  // already queued for it — including responses from dispatches that settled
  // mid-stop — before the FIN. write()+destroy() in the same tick loses
  // those bytes on Windows named pipes (observed twice in the round proof).
  // No timers: stop() resolves only from server.close()'s callback below
  // (daemon-metadata-lifecycle guard). A client that stops reading can hold
  // the end() flush open — the same exposure the awaited shutdown
  // acknowledgement already accepts.
  const closing = [...clients];
  const flushed: Promise<void>[] = [];
  for (const state of closing) {
    for (const id of state.unsettled) {
      const encoded = encodeResponse(state, {
        type: 'response',
        id,
        ok: false,
        error: 'Chronicle server is stopping; the request was not completed',
        errorName: 'ChronicleStoppingError',
      });
      if (encoded !== undefined) state.socket.write(encoded);
    }
    flushed.push(new Promise<void>((resolve) => state.socket.end(() => resolve())));
  }
  await Promise.all(flushed);
  for (const state of closing) state.socket.destroy();
  clients.clear();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  await watcher?.close().catch((error) => {
    // A failed shutdown flush IS the drain failure under the observer's
    // close() contract — record it so the daemon's ping watcher field
    // reports the lost audit tail instead of silently swallowing it.
    watcherLastError = error instanceof Error ? error.message : String(error);
  });
  watcher = undefined;
  await flushJournals().catch(() => {});
  metricsStore?.close();
  metricsStore = undefined;
  if (process.platform !== 'win32') await fsp.rm(endpoint, { force: true }).catch(() => {});
  await stopMemoryWatchdog();
}

const server = net.createServer((socket) => {
  if (stopping) {
    socket.destroy();
    return;
  }
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  socket.setEncoding('utf8');
  const state: ClientState = {
    socket,
    buffer: '',
    greetedAt: Number.POSITIVE_INFINITY,
    spoken: false,
    unsettled: new Set<number>(),
  };
  clients.add(state);
  // Greet only once the token is readable on disk — see `metadataWritten`.
  void metadataWritten.then(() => {
    if (socket.destroyed) return;
    state.greetedAt = Date.now();
    send(state, { type: 'hello', ...serverInfo });
  });
  socket.on('data', (chunk: string) => onData(state, chunk));
  socket.on('error', () => {
    // 'close' owns cleanup; a listener is required or Node throws on 'error'
    // events (e.g. a write racing a client disconnect during shutdown).
  });
  socket.on('close', () => {
    clients.delete(state);
    scheduleIdleStop();
  });
});

// See `silentClientMs`: drops only sockets that connected and never sent a
// byte, so the idle shutdown can actually be reached. `close` does the rest.
silentClientSweep = setInterval(() => {
  const cutoff = Date.now() - silentClientMs;
  for (const state of clients) {
    if (!state.spoken && state.greetedAt < cutoff) {
      state.socket.destroy(new Error('Chronicle client connected without ever sending a request'));
    }
  }
}, silentSweepMs);
silentClientSweep.unref?.();

// The bind is the ownership election, including the probe-then-reclaim ladder
// for an endpoint whose owner died without cleanup. Shared with every other
// project daemon via `bindProjectEndpoint`.
void (async () => {
  const bind = await bindProjectEndpoint({ server, endpoint, service: 'chronicle' });
  if (bind.outcome === 'already-owned') {
    process.exitCode = 0;
    return;
  }
  if (bind.outcome === 'failed') {
    process.stderr.write(`chronicle project server failed: ${bind.error.message}\n`);
    process.exitCode = 1;
    return;
  }
  if (bind.reclaimedStaleEndpoint) {
    process.stderr.write(`chronicle project server reclaimed stale endpoint ${endpoint}\n`);
  }
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (stopping) return;
    process.stderr.write(`chronicle project server error: ${error.message}\n`);
    process.exitCode = 1;
  });
  void startChronicleFileObserver({
    projectRoot: parsed.projectRoot,
    journal: watcherSink,
    context: serverContext,
    excludedPaths: [chronicleDirectory],
    onError: (error) => {
      watcherLastError = error instanceof Error ? error.message : String(error);
    },
  })
    .then((value) => {
      watcher = value;
      for (const hint of pendingMutationHints.splice(0)) value.noteToolMutation(hint);
      watcherLastError = undefined;
    })
    .catch((error) => {
      watcherLastError = error instanceof Error ? error.message : String(error);
    });
  // Idle is armed only once the metadata is on disk. Arming it at bind let a
  // short idle window (or a slow atomic write + ACL restrict under load) stop
  // the daemon mid-write: `removeOwnedMetadata` found nothing, the write then
  // landed anyway, and clients read live-looking metadata for a daemon that
  // was already refusing connections.
  if (stopping) return;
  metadataWrite = writeMetadata();
  try {
    await metadataWrite;
  } catch {
    void stop('metadata-write-failed').finally(() => {
      process.exitCode = 1;
    });
    return;
  }
  // A stop that raced the write awaited it before removing the file.
  if (stopping) return;
  metadataGuard.enable();
  markMetadataWritten?.();
  scheduleIdleStop();
})();

armChronicleSignalGuard(stop);
