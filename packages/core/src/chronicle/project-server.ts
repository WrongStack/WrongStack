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
import { bindProjectEndpoint } from '@wrongstack/persistence';
import { restrictFilePermissions } from '../security/file-permissions.js';
import { atomicWrite } from '../utils/atomic-write.js';
import { startSharedHeapWatchdog } from '../utils/heap-watchdog.js';
import { useDaemonPerfDefaults } from '../utils/perf-profile.js';
import { type ChronicleContext, createChronicleContext } from './context.js';
import { type ChronicleFileObserver, startChronicleFileObserver } from './file-observer.js';
import { resolveChronicleRuntimeLocation } from './identity.js';
import { ChronicleJournal, type ChronicleJournalStats } from './journal.js';
import { importLegacyChronicleJournal } from './legacy-journal-import.js';
import { ChronicleMetricsStore } from './metrics-store.js';
import { ChroniclePartitionRangeCache } from './partition-range-cache.js';
import {
  chronicleProjectServerEndpoint,
  chronicleProjectServerMetadataPath,
} from './project-server-endpoint.js';
import {
  CHRONICLE_MAX_APPEND_BATCH,
  CHRONICLE_PROJECT_SERVER_MAX_FRAME_CHARS,
  CHRONICLE_PROJECT_SERVER_PROTOCOL_VERSION,
  type ChronicleProjectServerClientMessage,
  type ChronicleProjectServerHealth,
  type ChronicleProjectServerInfo,
  type ChronicleProjectServerMessage,
  type ChronicleProjectServerMetadata,
  type ChronicleServerOperationName,
  type ChronicleServerOperations,
  encodeChronicleProjectServerMessage,
} from './project-server-protocol.js';
import { type ChronicleQuery, ChronicleQueryEngine } from './query.js';
import type { ChronicleEventSink } from './sink.js';
import { type ChronicleQuarantinedFamily, ChronicleSqliteJournal } from './sqlite-journal.js';
import type { ChronicleSqliteQueryEngine } from './sqlite-query.js';
import type { ChronicleEvent, ChronicleEventInput } from './types.js';

const DEFAULT_IDLE_MS = 5 * 60_000;
/** Re-exported name kept local for readability; the bound is the protocol's. */
const MAX_APPEND_BATCH = CHRONICLE_MAX_APPEND_BATCH;
/** Outbound bytes queued for one client before it is dropped as unresponsive. */
const MAX_CLIENT_WRITE_BUFFER_BYTES = 8 * 1024 * 1024;

interface ParsedArgs {
  projectRoot: string;
  globalRoot: string;
  projectId: string;
  projectDir: string;
  workspaceId: string;
  retentionDays: number;
  durability: 'normal' | 'full';
}

interface ClientState {
  socket: net.Socket;
  buffer: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (key?.startsWith('--') && argv[index + 1] !== undefined) {
      values.set(key, argv[++index]!);
    }
  }
  const required = [
    '--project-root',
    '--global-root',
    '--project-id',
    '--project-dir',
    '--workspace-id',
  ] as const;
  for (const key of required) {
    if (!values.get(key)) throw new Error(`Chronicle project server requires ${key}`);
  }
  const retentionInput = Number(values.get('--retention-days'));
  // Durability is an operator escape hatch rather than per-session config, so
  // it is read from the environment the daemon already inherits instead of
  // being threaded through the client's spawn arguments. Anything other than
  // an explicit 'full' keeps the WAL default of NORMAL.
  const durabilityInput =
    values.get('--durability') ?? process.env['WRONGSTACK_CHRONICLE_DURABILITY'] ?? '';
  return {
    projectRoot: path.resolve(values.get('--project-root')!),
    globalRoot: path.resolve(values.get('--global-root')!),
    projectId: values.get('--project-id')!,
    projectDir: path.resolve(values.get('--project-dir')!),
    workspaceId: values.get('--workspace-id')!,
    retentionDays: Number.isFinite(retentionInput) && retentionInput > 0 ? retentionInput : 30,
    durability: durabilityInput.trim().toLowerCase() === 'full' ? 'full' : 'normal',
  };
}

// Long-lived daemon: lean SQLite residency unless the operator says
// otherwise. Must run before any store opens.
useDaemonPerfDefaults();

const parsed = parseArgs(process.argv.slice(2));
const chronicleDirectory = path.join(parsed.projectDir, 'chronicle');
const endpoint = chronicleProjectServerEndpoint(parsed.projectDir);
const metadataPath = chronicleProjectServerMetadataPath(parsed.projectDir);
const idleInput = Number(process.env['WRONGSTACK_CHRONICLE_SERVER_IDLE_MS']);
const idleMs = Number.isFinite(idleInput) && idleInput >= 100 ? idleInput : DEFAULT_IDLE_MS;
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
let stopping = false;
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

/**
 * Days of journal to keep open. Yesterday stays available because events can
 * still arrive for it right after midnight; anything older can only accumulate.
 */
const MAX_OPEN_JOURNAL_DAYS = 2;

/**
 * Drop journals for days we will not write to again.
 *
 * `journals` was only ever `get`/`set`/iterated — there was no `delete` and no
 * cap — so a daemon that lived across midnight kept one open `ChronicleJournal`
 * (with its write buffer and file handle) per day, forever. These daemons
 * routinely stay up for many hours.
 */
function pruneJournals(currentDay: string): void {
  if (journals.size <= MAX_OPEN_JOURNAL_DAYS) return;
  const keep = new Set([...journals.keys()].sort().reverse().slice(0, MAX_OPEN_JOURNAL_DAYS));
  keep.add(currentDay);
  for (const [day, journal] of journals) {
    if (keep.has(day)) continue;
    journals.delete(day);
    // Flush what is still buffered before letting it go. Detached, so a slow
    // disk cannot stall an append — but never unhandled.
    void journal.flush().catch(() => {
      /* best-effort: the daemon is dropping this day either way */
    });
  }
}

/** Compose the legacy partition path a `ChronicleJournal` writes to. */
function legacyPartitionPath(location: { chronicleDirectory: string; day: string }): string {
  return path.join(location.chronicleDirectory, `${location.day}.events.jsonl`);
}

/**
 * SQLite is the daemon's store; `WRONGSTACK_CHRONICLE_STORE=jsonl` restores the
 * partition writer. This is the production write path — the inline one only
 * runs in explicit recovery mode — so the cut-over lives here.
 */
function useSqliteStore(): boolean {
  return process.env['WRONGSTACK_CHRONICLE_STORE'] !== 'jsonl';
}

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
    const journal = new ChronicleSqliteJournal({
      directory: chronicleDirectory,
      retentionDays: parsed.retentionDays,
      durability: parsed.durability,
      // Bound burst growth independently of age retention. Prefix eviction keeps
      // at most this many rows while preserving chain verification via checkpoints.
      maxEvents: 100_000,
      // Formal aggregate allocation ceiling. Quota-enabled journals reserve
      // rollback-journal headroom and constrain the main database with max_page_count.
      maxBytes: 512 * 1024 * 1024,
    });
    try {
      const result = await importLegacyChronicleJournal(journal, chronicleDirectory);
      quarantinedFamilies = result.quarantined;
    } catch (error) {
      // Caching a rejected promise poisons the daemon for its whole lifetime:
      // every later request awaits the same rejection, and the handle above
      // keeps the database — and its write-ahead log — open the entire time.
      // Drop both so the next request gets a real retry.
      sqliteStore = undefined;
      journal.close();
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
    pruneJournals(day);
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
  metricsStore ??= ChronicleMetricsStore.open(chronicleDirectory);
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
  if (useSqliteStore()) {
    quarantinedFamilies = (await store()).quarantinedFamilies();
  }
  const journalStats: ChronicleJournalStats = journalForToday().stats();
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

/** True when the only narrowing is a time window/page — no genuinely ad hoc
 *  filter (text/path/provider/model/session/etc.) that fixed-dimension
 *  aggregation in ChronicleMetricsStore can't answer. */
function isDefaultView(query: ChronicleQuery): boolean {
  const { from, to, limit, order, cursor, ...rest } = query;
  return Object.values(rest).every((value) => value === undefined);
}

async function dispatch<O extends ChronicleServerOperationName>(
  op: O,
  rawArgs: unknown,
): Promise<ChronicleServerOperations[O]['result']> {
  switch (op) {
    case 'ping':
      return (await serverHealth()) as ChronicleServerOperations[O]['result'];
    case 'append': {
      const args = rawArgs as ChronicleServerOperations['append']['args'];
      return (await appendInputs(args.inputs)) as ChronicleServerOperations[O]['result'];
    }
    case 'flush':
      await flushJournals();
      return undefined as ChronicleServerOperations[O]['result'];
    case 'purge': {
      const args = rawArgs as ChronicleServerOperations['purge']['args'];
      return useSqliteStore()
        ? ((await (await store()).purge(args)) as ChronicleServerOperations[O]['result'])
        : ((await journalForToday().purge(args)) as ChronicleServerOperations[O]['result']);
    }
    case 'query': {
      const args = rawArgs as ChronicleServerOperations['query']['args'];
      const result = await (await queryEngine()).query(args.query);
      // The default/unfiltered view (only from/to/limit/order/cursor set) is
      // servable from the incrementally-refreshed metrics store instead of
      // the summary the query engine just computed by scanning matched
      // events — any other filter (text/path/provider/model/session/etc.)
      // keeps the raw-scan summary, since fixed-dimension aggregation can't
      // answer genuinely ad hoc filters.
      if (isDefaultView(args.query)) {
        await refreshMetrics();
        result.summary = metrics().defaultSummary({
          ...(args.query.from ? { from: args.query.from } : {}),
          ...(args.query.to ? { to: args.query.to } : {}),
        });
      }
      return result as ChronicleServerOperations[O]['result'];
    }
    case 'facet': {
      const args = rawArgs as ChronicleServerOperations['facet']['args'];
      const engine = await queryEngine();
      return {
        values: await engine.facet(args.field, args.query, args.limit),
        diagnostics: engine.diagnostics,
      } as ChronicleServerOperations[O]['result'];
    }
    case 'facets': {
      const args = rawArgs as ChronicleServerOperations['facets']['args'];
      const engine = await queryEngine();
      return {
        values: await engine.facets(args.fields, args.query, args.limit),
        diagnostics: engine.diagnostics,
      } as ChronicleServerOperations[O]['result'];
    }
    case 'graph': {
      const args = rawArgs as ChronicleServerOperations['graph']['args'];
      return (await (
        await queryEngine()
      ).graph(args.seed, args.hops, args.maxNodes)) as ChronicleServerOperations[O]['result'];
    }
    case 'metrics': {
      const args = rawArgs as ChronicleServerOperations['metrics']['args'];
      const refreshed =
        args.refresh === false
          ? { ingestedEvents: 0, ingestedBytes: 0, sourceFiles: 0, invalidLines: 0 }
          : await refreshMetrics();
      if (args.refresh === false) {
        // Keep the projection converging without putting historical indexing
        // latency on the caller's critical path.
        void refreshMetrics().catch(() => {});
      }
      const store = metrics();
      const data =
        args.view === 'providers'
          ? store.providerDaily(args.providers)
          : args.view === 'tasks'
            ? store.taskOutcomes(args.tasks)
            : args.view === 'files'
              ? store.fileLineage(args.files)
              : store.summary();
      return { refreshed, data } as ChronicleServerOperations[O]['result'];
    }
  }
}

function encodeResponse(
  state: ClientState,
  message: ChronicleProjectServerMessage,
): string | undefined {
  if (state.socket.destroyed) return undefined;
  const encoded = encodeChronicleProjectServerMessage(message);
  if (encoded.length > CHRONICLE_PROJECT_SERVER_MAX_FRAME_CHARS) {
    state.socket.destroy(new Error('Chronicle project server response exceeded frame limit'));
    return undefined;
  }
  // The frame cap above bounds one message; this bounds the queue. Ignoring
  // `socket.write()`'s `false` return lets a client that stopped reading grow
  // the owner's heap without limit — see the identical guard in the mailbox,
  // kanban, SAGE and index owners.
  if (state.socket.writableLength > MAX_CLIENT_WRITE_BUFFER_BYTES) {
    state.socket.destroy(new Error('Chronicle client fell too far behind on reads'));
    return undefined;
  }
  return encoded;
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
  if (message.authToken !== authToken) {
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
  try {
    const result = await dispatch(message.op, message.args);
    send(state, { type: 'response', id: message.id, ok: true, result });
  } catch (error) {
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
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  // WS-059: remove metadata BEFORE releasing the endpoint. The bind is the
  // ownership election, so while it is still held no successor daemon can
  // exist — and therefore none can have its metadata deleted by the
  // read-then-delete pid compare in `removeOwnedMetadata`.
  await removeOwnedMetadata();
  // Destroy client sockets before awaiting close(): net.Server.close() waits
  // for every connection to end, so live clients can otherwise block daemon
  // shutdown indefinitely after ownership metadata has already been removed.
  for (const state of clients) state.socket.destroy();
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
  const state: ClientState = { socket, buffer: '' };
  clients.add(state);
  // Greet only once the token is readable on disk — see `metadataWritten`.
  void metadataWritten.then(() => {
    if (!socket.destroyed) send(state, { type: 'hello', ...serverInfo });
  });
  socket.on('data', (chunk: string) => onData(state, chunk));
  socket.on('close', () => {
    clients.delete(state);
    scheduleIdleStop();
  });
});

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
  void writeMetadata().then(() => markMetadataWritten?.());
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
  scheduleIdleStop();
})();

/**
 * One SIGINT/SIGTERM pair per PROCESS, not per module instance.
 *
 * The in-process test harness imports this module once per test case with a
 * `?case=<n>` query URL, so every case evaluates this module body fresh; a
 * bare top-level `process.once(signal, ...)` pair accumulates one handler
 * per case until Node raises MaxListenersExceededWarning in every coverage
 * run. The guard lives on globalThis under a Symbol.for key: the first
 * evaluation registers the pair, every evaluation re-targets it at its own
 * `stop`, and a fired signal removes the pair (once semantics).
 */
interface ChronicleSignalGuard {
  arm(stop: (signal: string) => Promise<void>): void;
}
const SIGNAL_GUARD: unique symbol = Symbol.for('wrongstack.chronicle.project-server.signalGuard');

const signalGuardStore = globalThis as typeof globalThis & {
  [SIGNAL_GUARD]?: ChronicleSignalGuard | undefined;
};
let signalGuard = signalGuardStore[SIGNAL_GUARD];
if (!signalGuard) {
  let current: (signal: string) => Promise<void> = async () => undefined;
  let armed = false;
  const handlers = new Map<string, () => void>();
  const disarm = (): void => {
    if (!armed) return;
    armed = false;
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    handlers.clear();
  };
  signalGuard = {
    arm(next) {
      current = next;
      if (armed) return;
      armed = true;
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        const handler = (): void => {
          disarm();
          void current(signal);
        };
        handlers.set(signal, handler);
        process.on(signal, handler);
      }
    },
  };
  signalGuardStore[SIGNAL_GUARD] = signalGuard;
}
signalGuard.arm(stop);
