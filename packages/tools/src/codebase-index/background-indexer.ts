import type { ReindexCompletion } from './background-indexer-policy.js';
import {
  circuitOpenError,
  DEFAULT_COALESCE_WINDOW_MS,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_FULL_INDEX_TIMEOUT_MS,
  DEFAULT_INCREMENTAL_TIMEOUT_MS,
  DEFAULT_QUERY_TIMEOUT_MS,
  debounceKey,
  isIndexableFile,
  isRecoverableConstraintError,
  reindexBatchKey,
  resolveLastError,
  settleReindexCompletions,
} from './background-indexer-policy.js';
/**
 * Index host — the main-thread coordinator for all codebase-index operations.
 *
 * Production mode runs every operation (full scans, per-file reindexes,
 * searches, stats) in a dedicated worker thread (`worker.ts`), so the
 * synchronous `node:sqlite` calls and the TypeScript parser can never block
 * the main event loop — the failure mode that used to freeze terminals is
 * structurally impossible. When the built worker file is not present (tests
 * run from source, exotic runtimes) or `WRONGSTACK_INDEX_INLINE=1` is set,
 * operations fall back to running inline through the same service layer.
 *
 * Concerns owned here, in front of either execution mode:
 *
 * 1. **Serialization** — every write run (startup scan, per-edit incremental,
 *    external file-watch, manual reindex) goes through one process-wide
 *    promise-chain mutex so two runs never race the same `index.db` writer.
 * 2. **Debounce** — rapid successive edits to the same file coalesce, then
 *    files that become ready in the same event-loop turn share one index run.
 * 3. **Watchdog** — every operation is raced against a timeout. In worker
 *    mode a timeout hard-terminates the worker (it respawns lazily on the
 *    next request); inline it aborts the run's signal. Either way the mutex
 *    chain always advances and the promise always settles.
 * 4. **Circuit breaker** — repeated failures/timeouts pause indexing instead
 *    of queuing more work behind a wedged pipeline. See circuit-breaker.ts.
 * 5. **State tracking** — ready/indexing/progress flags + change listeners
 *    for the TUI status chip and the search/stats tools' gating.
 */
import { type CircuitSnapshot, indexCircuitBreaker } from './circuit-breaker.js';
import type { ContextResult } from './context-retrieval.js';
import type { CallOpts } from './index-inline.js';
import type { IncomingCallsResult, OutgoingCallsResult } from './index-service.js';
import {
  dispatchIndexOp,
  resetIndexWorkerState,
  shutdownIndexWorker,
  warnEndpointInvalidOnce,
} from './index-worker-rpc.js';
import {
  checkProjectIndexServerHealth,
  closeProjectIndexServerClients,
  ensureProjectIndexServer,
  getProjectIndexServerConnectionState,
  onProjectIndexServerConnectionStateChange,
  type ProjectIndexServerClientHealth,
  type ProjectIndexServerConnectionState,
  type ProjectIndexServerShutdownResult,
  resolveProjectIndexDaemonAvailability,
  shutdownProjectIndexServer,
} from './project-server-client.js';
import { publishConnectionState } from './project-server-client-state.js';
import type { CodeMapGraph, IndexResult, IndexStats } from './schema.js';
import type {
  CallRefsOpArgs,
  ContextOpArgs,
  FileGraphOpArgs,
  OpName,
  OpShapes,
  SearchOpArgs,
  SearchOpResult,
  StatsOpArgs,
  SymbolGraphOpArgs,
  VectorSearchOpArgs,
  VectorSearchOpResult,
} from './worker-protocol.js';
import { indexStorePool } from './writer.js';
import { resolveIndexDir } from './writer-helpers.js';
import { isOwnedByWrongIndex } from './wrongindex/owner-lock.js';
import { onWrongIndexPublication } from './wrongindex/publication.js';
import {
  acquireWrongIndexSession,
  registerWrongIndexProject,
  releaseWrongIndexSessions,
  resolveIndexRoute,
  setBeforeWrongIndexClaim,
  WrongIndexUnavailableError,
  wrongIndexHealth,
} from './wrongindex/service.js';

// Before this process lets WrongIndex claim an index, its own local owner of
// that index (the detached project server and pooled stores) steps down.
setBeforeWrongIndexClaim(async (projectRoot, indexDir) => {
  await shutdownProjectIndexServer(projectRoot, indexDir, 'wrongindex-takeover').catch(
    () => undefined,
  );
  indexStorePool.evict(projectRoot, indexDir);
});

export { isIndexableFile, resolveLastError } from './background-indexer-policy.js';

// ─── Indexing lifecycle state ─────────────────────────────────────────────────
// Process-wide counters so codebase-search / codebase-stats can gate on
// readiness and UIs can show an indexing indicator.
let _ready = false;
let _indexing = false;
let _currentFile = 0;
let _totalFiles = 0;
let _lastError: string | null = null;
/** When `_lastError` was recorded (ms epoch); 0 when there is none. */
let _lastErrorAt = 0;

/** True once the first full-project index has completed (success or failure). */
export function isIndexReady(): boolean {
  return _ready;
}

/**
 * Mark the index as ready so downstream tools (codebase-search, codebase-stats)
 * don't gate on a startup index that never ran.
 */
export function setIndexReady(): void {
  _ready = true;
}

/** True while an index build is actively running. */
export function isIndexing(): boolean {
  return _indexing;
}

/** Current indexing progress: { currentFile, totalFiles, ready, indexing, circuit }. */
export function getIndexState(): {
  ready: boolean;
  indexing: boolean;
  currentFile: number;
  totalFiles: number;
  lastError: string | null;
  /** Detached per-project server connection owned by this client process. */
  server: ProjectIndexServerConnectionState;
  /** Circuit-breaker state — `open` means indexing is paused after repeated failures. */
  circuit: CircuitSnapshot;
} {
  const server = getProjectIndexServerConnectionState();
  const remoteActivity = server.activity;
  const remoteIndexing = remoteActivity?.indexing ?? false;
  return {
    ready: _ready || (remoteActivity?.generation ?? 0) > 0,
    indexing: _indexing || remoteIndexing,
    currentFile: remoteIndexing ? (remoteActivity?.currentFile ?? 0) : _currentFile,
    totalFiles: remoteIndexing ? (remoteActivity?.totalFiles ?? 0) : _totalFiles,
    lastError: resolveLastError(remoteActivity, _lastError, _lastErrorAt),
    server,
    circuit: indexCircuitBreaker.snapshot(),
  };
}

/**
 * Optional callback fired on every lifecycle transition (started, progress,
 * completed, failed). Plug into the event bus or a TUI dispatcher to surface
 * the indexing state in real time.
 */
type IndexStateListener = (state: ReturnType<typeof getIndexState>) => void;
let _listeners: IndexStateListener[] = [];

export function onIndexStateChange(listener: IndexStateListener): () => void {
  _listeners.push(listener);
  return () => {
    _listeners = _listeners.filter((l) => l !== listener);
  };
}

function emitState() {
  const state = getIndexState();
  for (const l of _listeners) l(state);
}

// Server lifecycle changes are part of index state even while no indexing job
// is active, so the TUI can keep a truthful connected/offline/error indicator.
onProjectIndexServerConnectionStateChange(() => emitState());
onWrongIndexPublication((publication) => {
  publishConnectionState(`wrongindex:${publication.indexDir}`, {
    status: 'connected',
    connected: true,
    projectRoot: publication.projectRoot,
    indexDir: publication.indexDir,
    publication: {
      daemonInstanceId: publication.daemonInstanceId,
      graphStamp: publication.graphStamp,
      freshness: publication.freshness,
    },
    activity: {
      generation: publication.generation,
      indexing: publication.indexing === true,
      currentFile: 0,
      totalFiles: 0,
      updatedAt: publication.observedAt,
      lastError: publication.lastError ?? null,
    },
  });
});

function setIndexProgress(current: number, total: number) {
  _currentFile = current;
  _totalFiles = total;
  emitState();
}

/**
 * Tear down the index host (worker + pending debounces). Call on process
 * shutdown; safe to call when nothing is running.
 */
export async function shutdownCodebaseIndexHost(): Promise<void> {
  cancelPendingReindexes();
  closeProjectIndexServerClients();
  indexStorePool.closeAll();
  await shutdownIndexWorker();
  // Only this process's watch leases; the global WrongIndex daemon stays up.
  await releaseWrongIndexSessions();
}

// ─── Process-wide write mutex ────────────────────────────────────────────────
// A single promise chain. Each enqueued job awaits the previous one's settle
// (success OR failure) before running, so a thrown job never wedges the chain.
// Only write runs (index) take the mutex; searches/stats are WAL reads.
let chain: Promise<unknown> = Promise.resolve();

function withMutex<T>(job: () => Promise<T>): Promise<T> {
  if (process.env['WRONGSTACK_INDEX_BENCH_NO_HOST_MUTEX'] === '1') return job();
  const run = chain.then(job, job);
  // Keep the chain alive regardless of this job's outcome.
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingReindexCompletions = new Map<string, Set<ReindexCompletion>>();
interface ReadyReindexBatch {
  projectRoot: string;
  indexDir?: string | undefined;
  files: Set<string>;
  timeoutMs: number;
  onErrors: Set<(err: unknown) => void>;
  completions: Set<{ resolve: () => void; reject: (err: unknown) => void }>;
  flush?: ReturnType<typeof setTimeout> | undefined;
}
const readyReindexBatches = new Map<string, ReadyReindexBatch>();

function flushReadyReindexBatch(key: string): void {
  const batch = readyReindexBatches.get(key);
  if (!batch) return;
  readyReindexBatches.delete(key);

  if (!indexCircuitBreaker.allowRequest()) {
    const error = circuitOpenError();
    for (const onError of batch.onErrors) onError(error);
    settleReindexCompletions(batch.completions, error);
    return;
  }

  void withMutex(() =>
    callIndexOp(
      'index',
      {
        projectRoot: batch.projectRoot,
        files: [...batch.files].sort(),
        indexDir: batch.indexDir,
      },
      { timeoutMs: batch.timeoutMs },
    ),
  ).then(
    () => {
      indexCircuitBreaker.recordSuccess();
      settleReindexCompletions(batch.completions);
    },
    (err) => {
      indexCircuitBreaker.recordFailure(err);
      for (const onError of batch.onErrors) onError(err);
      settleReindexCompletions(batch.completions, err);
    },
  );
}

function addReadyReindex(opts: {
  projectRoot: string;
  file: string;
  indexDir?: string | undefined;
  timeoutMs: number;
  onError?: ((err: unknown) => void) | undefined;
  coalesceWindowMs?: number | undefined;
}): void {
  const key = reindexBatchKey(opts.projectRoot, opts.indexDir);
  const windowMs = opts.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS;
  const pending = pendingReindexCompletions.get(key);
  pendingReindexCompletions.delete(key);
  const existing = readyReindexBatches.get(key);
  if (existing) {
    existing.files.add(opts.file);
    existing.timeoutMs = Math.max(existing.timeoutMs, opts.timeoutMs);
    if (opts.onError) existing.onErrors.add(opts.onError);
    if (pending) for (const completion of pending) existing.completions.add(completion);
    // Sliding window: each file that joins resets the flush timer so a
    // staggered burst stays open until the gap between arrivals exceeds
    // the window. Only schedule a new timer when a window is configured.
    if (windowMs > 0 && existing.flush) {
      clearTimeout(existing.flush);
      existing.flush = setTimeout(() => flushReadyReindexBatch(key), windowMs);
      existing.flush.unref?.();
    }
    return;
  }

  const batch: ReadyReindexBatch = {
    projectRoot: opts.projectRoot,
    indexDir: opts.indexDir,
    files: new Set([opts.file]),
    timeoutMs: opts.timeoutMs,
    onErrors: new Set(opts.onError ? [opts.onError] : []),
    completions: pending ?? new Set(),
  };
  // setTimeout(fn, 0) is equivalent to setImmediate but keeps the timer type
  // uniform so clearTimeout works on both branches without casts.
  batch.flush = setTimeout(() => flushReadyReindexBatch(key), Math.max(0, windowMs));
  batch.flush.unref?.();
  readyReindexBatches.set(key, batch);
}

export async function runStartupIndex(opts: {
  projectRoot: string;
  indexDir?: string | undefined;
  force?: boolean | undefined;
  langs?: string[] | undefined;
  signal?: AbortSignal | undefined;
  /** Watchdog timeout for the whole run. Default: 120s. */
  timeoutMs?: number | undefined;
}): Promise<IndexResult> {
  // Circuit breaker: after repeated failures/timeouts, fail fast instead of
  // queuing yet another run behind a possibly-wedged pipeline.
  if (!indexCircuitBreaker.allowRequest()) throw circuitOpenError();

  _indexing = true;
  emitState();

  try {
    let result: IndexResult;
    try {
      result = await runIndexPass(opts);
    } catch (err) {
      // Auto-recovery: SQLite constraint failures indicate index DB corruption
      // from a previous interrupted write (e.g., process killed mid-insert).
      // Rebuild with force=true under THIS run's breaker admission. Recursing
      // into runStartupIndex re-ran allowRequest(): a half-open circuit refused
      // it, the probe never settled, and every later run was rejected until a
      // manual reset — and the inner `finally` cleared `_indexing` while this
      // run was still active.
      if (!isRecoverableConstraintError(err) || opts.force || opts.signal?.aborted) throw err;
      const failure = err instanceof Error ? err.message : String(err);
      result = {
        ...(await runIndexPass({ ...opts, force: true })),
        // Tag the result so callers can distinguish a normal run from a
        // corruption-triggered recovery.
        autoRecovered: { failure, rebuiltWithForce: true },
      };
    }
    _ready = true;
    indexCircuitBreaker.recordSuccess();
    return result;
  } catch (err) {
    // A caller-initiated abort (session teardown, Ctrl+C, project switch) is
    // not a broken index: recording "Indexing cancelled" here made every read
    // tool refuse with "Index build failed" until the next full run, although
    // the persisted index was untouched and fully readable.
    if (!opts.signal?.aborted) {
      _lastError = err instanceof Error ? err.message : String(err);
      _lastErrorAt = Date.now();
    }
    _ready = true; // index is "ready" in the sense that we won't try again; downstream tools will see lastError
    // Caller-initiated aborts (session teardown, Ctrl+C) are not indexer
    // failures — only genuine errors and watchdog timeouts trip the breaker.
    // An aborted half-open probe must still be released, or the circuit stays
    // half-open and refuses every later run.
    if (opts.signal?.aborted) indexCircuitBreaker.abandonProbe();
    else indexCircuitBreaker.recordFailure(err);
    throw err;
  } finally {
    _indexing = false;
    emitState();
  }
}

/** One serialized index run (no breaker accounting — the caller owns that). */
function runIndexPass(opts: {
  projectRoot: string;
  indexDir?: string | undefined;
  force?: boolean | undefined;
  langs?: string[] | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}): Promise<IndexResult> {
  return withMutex(() => {
    // Reset counters inside the mutex — if runStartupIndex is called twice
    // concurrently, the second caller must not clobber a running index's
    // progress counters.
    _currentFile = 0;
    _totalFiles = 0;
    _lastError = null;
    _lastErrorAt = 0;
    return callIndexOp(
      'index',
      {
        projectRoot: opts.projectRoot,
        indexDir: opts.indexDir,
        force: opts.force,
        langs: opts.langs,
      },
      {
        timeoutMs: opts.timeoutMs ?? DEFAULT_FULL_INDEX_TIMEOUT_MS,
        signal: opts.signal,
        onProgress: setIndexProgress,
      },
    );
  });
}

/**
 * Debounced, fire-and-forget incremental reindex of specific files. Used by the
 * per-edit toolCall middleware and the external file watcher. Non-indexable
 * paths are dropped. Errors are reported via the optional `onError` callback and
 * never thrown to the caller (background work must not crash a turn).
 */
export function enqueueReindex(opts: {
  projectRoot: string;
  files: string[];
  indexDir?: string | undefined;
  debounceMs?: number | undefined;
  /**
   * Per-project trailing coalescing window. After a file's debounce timer
   * fires, the ready batch stays open for this long before flushing. Any file
   * whose timer fires within the window joins the same batch and resets the
   * timer (sliding). Default: 50ms; set to 0 for immediate flush.
   */
  coalesceWindowMs?: number | undefined;
  /** Watchdog timeout per file. Default: 30s. */
  timeoutMs?: number | undefined;
  onError?: ((err: unknown) => void) | undefined;
}): Promise<void> {
  const files = opts.files.filter(isIndexableFile);
  if (files.length === 0) return Promise.resolve();
  const completion = new Promise<void>((resolve, reject) => {
    const key = reindexBatchKey(opts.projectRoot, opts.indexDir);
    const pending = pendingReindexCompletions.get(key) ?? new Set<ReindexCompletion>();
    pending.add({ resolve, reject });
    pendingReindexCompletions.set(key, pending);
  });
  const ms = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  for (const file of files) {
    const key = debounceKey(opts.projectRoot, opts.indexDir, file);
    const existing = debounceTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      debounceTimers.delete(key);
      addReadyReindex({
        projectRoot: opts.projectRoot,
        file,
        indexDir: opts.indexDir,
        timeoutMs: opts.timeoutMs ?? DEFAULT_INCREMENTAL_TIMEOUT_MS,
        onError: opts.onError,
        coalesceWindowMs: opts.coalesceWindowMs,
      });
    }, ms);
    timer.unref?.();
    debounceTimers.set(key, timer);
  }
  return completion;
}

/** Cancel all pending debounced reindexes. For teardown / tests. */
export function cancelPendingReindexes(): void {
  for (const t of debounceTimers.values()) clearTimeout(t);
  debounceTimers.clear();
  for (const batch of readyReindexBatches.values()) {
    if (batch.flush) clearTimeout(batch.flush);
  }
  const cancelled = new Error('pending reindex cancelled');
  for (const batch of readyReindexBatches.values()) {
    settleReindexCompletions(batch.completions, cancelled);
  }
  readyReindexBatches.clear();
  for (const completions of pendingReindexCompletions.values()) {
    settleReindexCompletions(completions, cancelled);
  }
  pendingReindexCompletions.clear();
}

/**
 * Ranked symbol search against the index. The query runs in the index worker
 * (or inline in fallback mode) — the main thread never opens SQLite. Reads
 * don't take the write mutex (WAL readers don't block the writer) and don't
 * feed the circuit breaker; a wedged read still trips the watchdog, which
 * recycles the worker.
 */
export async function searchCodebaseIndex(
  args: SearchOpArgs,
  opts: { timeoutMs?: number | undefined; signal?: AbortSignal | undefined } = {},
): Promise<SearchOpResult> {
  return callIndexOp('search', args, {
    timeoutMs: opts.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
    signal: opts.signal,
  });
}

/** Index health/statistics, fetched off the main thread like searches. */
export async function codebaseIndexStats(
  args: StatsOpArgs,
  opts: { timeoutMs?: number | undefined; signal?: AbortSignal | undefined } = {},
): Promise<IndexStats> {
  return callIndexOp('stats', args, {
    timeoutMs: opts.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
    signal: opts.signal,
  });
}

/**
 * Personalised retrieval — the single call that answers "which files does this
 * task touch?", served by the same per-project index process so the wiring
 * graph is built once per generation rather than once per query.
 */
export async function codebaseContext(args: ContextOpArgs): Promise<ContextResult> {
  return callIndexOp('context', args, { timeoutMs: DEFAULT_QUERY_TIMEOUT_MS });
}

/**
 * Nearest files to an already-embedded query vector. The model stays in the
 * caller's process; only numbers cross IPC.
 */
export async function codebaseVectorSearch(
  args: VectorSearchOpArgs,
): Promise<VectorSearchOpResult> {
  return callIndexOp('vectorSearch', args, { timeoutMs: DEFAULT_QUERY_TIMEOUT_MS });
}

/** Package dependency graph, served by the same per-project index process. */
export async function packageGraphService(
  args: StatsOpArgs,
  signal?: AbortSignal,
): Promise<CodeMapGraph> {
  return callIndexOp('packageGraph', args, { timeoutMs: DEFAULT_QUERY_TIMEOUT_MS, signal });
}

/** File dependency graph, served by the same per-project index process. */
export async function fileGraphService(
  args: FileGraphOpArgs,
  signal?: AbortSignal,
): Promise<CodeMapGraph> {
  return callIndexOp('fileGraph', args, { timeoutMs: DEFAULT_QUERY_TIMEOUT_MS, signal });
}

/** Symbol dependency graph, served by the same per-project index process. */
export async function symbolGraphService(
  args: SymbolGraphOpArgs,
  signal?: AbortSignal,
): Promise<CodeMapGraph> {
  return callIndexOp('symbolGraph', args, { timeoutMs: DEFAULT_QUERY_TIMEOUT_MS, signal });
}

/** Incoming call sites for a named symbol (who calls/uses this symbol?). */
export async function incomingCallsService(args: CallRefsOpArgs): Promise<IncomingCallsResult> {
  return callIndexOp('incomingCalls', args, { timeoutMs: DEFAULT_QUERY_TIMEOUT_MS });
}

/** Outgoing call sites for a named symbol (what does this symbol call/use?). */
export async function outgoingCallsService(args: CallRefsOpArgs): Promise<OutgoingCallsResult> {
  return callIndexOp('outgoingCalls', args, { timeoutMs: DEFAULT_QUERY_TIMEOUT_MS });
}

/**
 * Stop this project's detached index server. Unlike
 * shutdownCodebaseIndexHost(), this intentionally affects every connected
 * TUI/CLI/WebUI client for the project.
 */
export function shutdownCodebaseIndexServer(
  projectRoot: string,
  indexDir?: string,
  reason?: string,
): Promise<ProjectIndexServerShutdownResult> {
  if (resolveIndexRoute(projectRoot, indexDir) === 'wrongindex') {
    // The global service is not this client's to stop.
    return releaseWrongIndexSessions().then(() => ({
      stopped: false,
      reason: 'served by the WrongIndex service; only this client session was released',
    }));
  }
  return shutdownProjectIndexServer(projectRoot, indexDir, reason);
}

/** Probe the connected project server without starting a missing server. */
export function checkCodebaseIndexServerHealth(
  projectRoot: string,
  indexDir?: string,
  options: { timeoutMs?: number | undefined } = {},
): Promise<ProjectIndexServerClientHealth> {
  if (resolveIndexRoute(projectRoot, indexDir) === 'wrongindex') {
    const t0 = Date.now();
    return wrongIndexHealth().then(
      (h): ProjectIndexServerClientHealth => ({
        status: h['draining'] ? 'degraded' : 'healthy',
        checkedAt: Date.now(),
        lastHealthyAt: Date.now(),
        latencyMs: Date.now() - t0,
        missedHeartbeats: 0,
      }),
      (err: unknown): Promise<ProjectIndexServerClientHealth> | ProjectIndexServerClientHealth => {
        // Service gone and the index free: report the local engine instead.
        if (
          err instanceof WrongIndexUnavailableError &&
          !isOwnedByWrongIndex(resolveIndexDir(projectRoot, indexDir))
        ) {
          return checkProjectIndexServerHealth(projectRoot, indexDir, options);
        }
        return {
          status: 'unresponsive',
          checkedAt: Date.now(),
          lastHealthyAt: null,
          latencyMs: null,
          missedHeartbeats: 1,
        };
      },
    );
  }
  return checkProjectIndexServerHealth(projectRoot, indexDir, options);
}

/** Ensure the detached project server exists and owns external watching. */
export function ensureCodebaseIndexServer(options: {
  projectRoot: string;
  indexDir?: string | undefined;
  watchExternal?: boolean | undefined;
  debounceMs?: number | undefined;
  coalesceWindowMs?: number | undefined;
}): Promise<void> {
  if (resolveIndexRoute(options.projectRoot, options.indexDir) === 'wrongindex') {
    // The service watches the project while a session lease is held (policy
    // `session`) - only when external watching is on, as the local server
    // watches only then; the local detached server is not started for it -
    // unless the service is unavailable and does not hold the index.
    const attach = options.watchExternal
      ? acquireWrongIndexSession(options.projectRoot, options.indexDir)
      : registerWrongIndexProject(options.projectRoot, options.indexDir);
    return attach.catch((err: unknown) => {
      const dir = resolveIndexDir(options.projectRoot, options.indexDir);
      if (!(err instanceof WrongIndexUnavailableError) || isOwnedByWrongIndex(dir)) throw err;
      return ensureLocalIndexServer(options);
    });
  }
  return ensureLocalIndexServer(options);
}

function ensureLocalIndexServer(options: {
  projectRoot: string;
  indexDir?: string | undefined;
  watchExternal?: boolean | undefined;
  debounceMs?: number | undefined;
  coalesceWindowMs?: number | undefined;
}): Promise<void> {
  const availability = resolveProjectIndexDaemonAvailability(options.projectRoot, options.indexDir);
  if (availability.kind !== 'available') {
    if (availability.kind === 'endpoint-invalid') warnEndpointInvalidOnce(availability);
    return Promise.resolve();
  }
  return ensureProjectIndexServer({
    projectRoot: options.projectRoot,
    indexDir: options.indexDir,
    watchExternal: options.watchExternal ?? false,
    debounceMs: options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
    coalesceWindowMs: options.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS,
  });
}

// ─── Test-only reset ───────────────────────────────────────────────────────────

/**
 * Reset all process-global indexing state for test isolation.
 *
 * Vitest runs test files in parallel within the same process, so module-level
 * state (`_indexing`, `_ready`, `chain`, `indexCircuitBreaker`) leaks between
 * tests. Call this in `beforeEach` to ensure each test starts with a clean
 * slate. Production code should NEVER call this.
 */
export function resetIndexStateForTesting(): void {
  _ready = false;
  _indexing = false;
  _currentFile = 0;
  _totalFiles = 0;
  _lastError = null;
  _lastErrorAt = 0;
  chain = Promise.resolve();
  indexCircuitBreaker.reset();
  cancelPendingReindexes();
  closeProjectIndexServerClients();
  resetIndexWorkerState();
}

function callIndexOp<O extends OpName>(
  op: O,
  args: OpShapes[O]['args'],
  opts: CallOpts,
): Promise<OpShapes[O]['result']> {
  return dispatchIndexOp(op, args, opts, _indexing);
}
