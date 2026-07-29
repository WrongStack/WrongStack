#!/usr/bin/env node
/**
 * One detached Chronicle owner per local project.
 *
 * Event mapping and secret scrubbing remain in the originating process. This
 * server owns ordering/hash chaining, partition rotation, retention, the
 * project file watcher, derived metrics, and journal queries.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import { useDaemonPerfDefaults } from '../utils/perf-profile.js';
import { type ChronicleContext, createChronicleContext } from './context.js';
import { type ChronicleFileObserver, startChronicleFileObserver } from './file-observer.js';
import { resolveChronicleRuntimeLocation } from './identity.js';
import { ChronicleJournal, type ChronicleJournalStats } from './journal.js';
import { ChronicleMetricsStore } from './metrics-store.js';
import { ChroniclePartitionRangeCache } from './partition-range-cache.js';
import {
  chronicleProjectServerEndpoint,
  chronicleProjectServerMetadataPath,
  ensureChronicleProjectServerSocketDirectory,
} from './project-server-endpoint.js';
import {
  CHRONICLE_PROJECT_SERVER_MAX_FRAME_CHARS,
  CHRONICLE_PROJECT_SERVER_PROTOCOL_VERSION,
  type ChronicleProjectServerClientMessage,
  type ChronicleProjectServerHealth,
  type ChronicleProjectServerInfo,
  type ChronicleProjectServerMessage,
  type ChronicleServerOperationName,
  type ChronicleServerOperations,
  encodeChronicleProjectServerMessage,
} from './project-server-protocol.js';
import { ChronicleQueryEngine, type ChronicleQuery } from './query.js';
import { importLegacyChronicleJournal } from './legacy-journal-import.js';
import { type ChronicleQuarantinedFamily, ChronicleSqliteJournal } from './sqlite-journal.js';
import type { ChronicleSqliteQueryEngine } from './sqlite-query.js';
import type { ChronicleEventSink } from './sink.js';
import type { ChronicleEvent, ChronicleEventInput } from './types.js';

const DEFAULT_IDLE_MS = 5 * 60_000;
const MAX_APPEND_BATCH = 10_000;

interface ParsedArgs {
  projectRoot: string;
  globalRoot: string;
  projectId: string;
  projectDir: string;
  workspaceId: string;
  retentionDays: number;
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
  return {
    projectRoot: path.resolve(values.get('--project-root')!),
    globalRoot: path.resolve(values.get('--global-root')!),
    projectId: values.get('--project-id')!,
    projectDir: path.resolve(values.get('--project-dir')!),
    workspaceId: values.get('--workspace-id')!,
    retentionDays: Number.isFinite(retentionInput) && retentionInput >= 0 ? retentionInput : 30,
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
  const keep = new Set(
    [...journals.keys()].sort().reverse().slice(0, MAX_OPEN_JOURNAL_DAYS),
  );
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
    const journal = new ChronicleSqliteJournal({ directory: chronicleDirectory });
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
      return (useSqliteStore()
        ? ((await (await store()).purge(args)) as ChronicleServerOperations[O]['result'])
        : ((await journalForToday().purge(args)) as ChronicleServerOperations[O]['result']));
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
      const refreshed = args.refresh === false
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

function send(state: ClientState, message: ChronicleProjectServerMessage): void {
  if (state.socket.destroyed) return;
  const encoded = encodeChronicleProjectServerMessage(message);
  if (encoded.length > CHRONICLE_PROJECT_SERVER_MAX_FRAME_CHARS) {
    state.socket.destroy(new Error('Chronicle project server response exceeded frame limit'));
    return;
  }
  state.socket.write(encoded);
}

async function handleMessage(
  state: ClientState,
  message: ChronicleProjectServerClientMessage,
): Promise<void> {
  if (message.type === 'shutdown') {
    send(state, { type: 'response', id: message.id, ok: true, result: undefined });
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
  const temporary = `${metadataPath}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(serverInfo, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    await fsp.rename(temporary, metadataPath);
  } catch {
    await fsp.rm(metadataPath, { force: true });
    await fsp.rename(temporary, metadataPath);
  }
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
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const state of clients) state.socket.destroy();
  clients.clear();
  await watcher?.close().catch(() => {});
  watcher = undefined;
  await flushJournals().catch(() => {});
  metricsStore?.close();
  metricsStore = undefined;
  await removeOwnedMetadata();
  if (process.platform !== 'win32') await fsp.rm(endpoint, { force: true }).catch(() => {});
}

ensureChronicleProjectServerSocketDirectory(endpoint);
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
  send(state, { type: 'hello', ...serverInfo });
  socket.on('data', (chunk: string) => onData(state, chunk));
  socket.on('close', () => {
    clients.delete(state);
    scheduleIdleStop();
  });
});

let probingExistingEndpoint = false;

function listenForOwnership(): void {
  server.listen(endpoint);
}

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE' && process.platform === 'win32') {
    process.exitCode = 0;
    return;
  }
  if (error.code === 'EADDRINUSE' && !probingExistingEndpoint) {
    probingExistingEndpoint = true;
    const probe = net.createConnection(endpoint);
    probe.once('connect', () => {
      probe.destroy();
      process.exitCode = 0;
    });
    probe.once('error', () => {
      probe.destroy();
      try {
        fs.rmSync(endpoint, { force: true });
      } catch {
        // A competing candidate may already have repaired the endpoint.
      }
      probingExistingEndpoint = false;
      listenForOwnership();
    });
    return;
  }
  process.exitCode = 1;
});

server.on('listening', () => {
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(endpoint, 0o600);
    } catch {
      // The containing 0700 directory still limits access to this user.
    }
  }
  void writeMetadata();
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
});

process.once('SIGINT', () => void stop('SIGINT'));
process.once('SIGTERM', () => void stop('SIGTERM'));
listenForOwnership();
