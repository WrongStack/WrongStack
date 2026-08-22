/**
 * Multi-threaded parser worker pool for bulk indexing.
 *
 * Spawns N worker threads (N = CPU cores - 1, clamped to [1, 4]) that share
 * the file-parsing load during startup/full reindex passes. Each worker runs
 * `parser-worker-script.ts`, parses file content supplied by the main thread
 * via `parseFileContent`, and returns `FileSymbols[]`.
 *
 * The main thread distributes files in round-robin chunks, collects results,
 * and performs all SQLite writes via `commitBatch`. Workers never touch the
 * database — single-writer WAL semantics are preserved.
 *
 * Failover (P3.7): every response carries the responding worker's
 * `workerId` (threadId), so busy-tracking is identity-based and a batch
 * knows exactly which chunk each worker owes. When a worker dies mid-batch,
 * its orphaned chunk is re-parsed inline on this thread instead of waiting
 * for a response that never arrive — a partial pool death previously hung
 * the batch until the outer 60s/240s watchdog. Only when every worker dies
 * does the batch reject, letting the indexer's existing inline fallback
 * take over.
 *
 * The pool is created lazily on first use and terminated on shutdown. Workers
 * are `unref()`'d so they don't keep the process alive.
 */

import * as fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { ParserWorkerResponse } from './parser-worker-script.js';
import type { FileSymbols, SymbolLang } from './schema.js';

/** Minimum number of files before the pool is worth spawning. */
export const WORKER_POOL_THRESHOLD = 500;

/**
 * Effective pool threshold for this run (audit T-04): the documented
 * {@link WORKER_POOL_THRESHOLD} default unless `WRONGSTACK_INDEX_WORKER_THRESHOLD`
 * overrides it. Re-resolved on every call — like `resolveParallelBatch` — so
 * profile changes (and tests) apply per index run without a process restart.
 *
 * - unset / unparsable / negative → the 500 default
 * - `0` → disables the worker path (per the `WRONGSTACK_*=0` opt-out
 *   convention, e.g. `WRONGSTACK_TOOLCHAIN_BATCH=0`): no candidate count can
 *   satisfy `>= 0 && parseBatchCount > 1` gate semantics with an explicit
 *   disable, so the gate checks the disable first.
 */
export function resolveWorkerPoolThreshold(): number {
  const raw = process.env['WRONGSTACK_INDEX_WORKER_THRESHOLD'];
  if (raw === undefined) return WORKER_POOL_THRESHOLD;
  // Full-value validation (Chimera follow-up): parseInt parses the PREFIX,
  // so '0junk' → 0 silently DISABLED the worker path and '10foo' → 10
  // honored a malformed value. Only an all-digits value counts; anything
  // else ('1.5', '1e3', trailing junk, empty, negative) falls back to the
  // documented default rather than guessing intent from a prefix.
  if (!/^\d+$/.test(raw)) return WORKER_POOL_THRESHOLD;
  return Number.parseInt(raw, 10);
}

interface PendingBatch {
  resolve: (results: FileSymbols[]) => void;
  reject: (err: unknown) => void;
  accumulated: FileSymbols[];
  /** Workers this batch still expects a result from (workerId → chunk). */
  pendingChunks: Map<number, { file: string; content: string; lang: SymbolLang }[]>;
  /**
   * Terminal-signal claim: exactly one of resolve/reject may fire. Worker
   * deaths, shutdown, and late salvages race on the same batch; a settled
   * batch ignores every later terminal path (double-reject is silently
   * swallowed by native promises, but resolve-after-reject and stale
   * accumulation are real logic hazards).
   */
  settled: boolean;
}

interface PoolWorker {
  worker: Worker;
  /** `threadId` — the identity responses carry back. */
  workerId: number;
  busy: boolean;
}

export class ParserWorkerPool {
  private workers: PoolWorker[] = [];
  private nextBatchId = 1;
  private pending = new Map<number, PendingBatch>();
  private creating = false;
  private unavailable = false;

  constructor(private readonly maxWorkers: number = defaultWorkerCount()) {}

  /**
   * True if the pool is available for use. Returns false when:
   * - Worker threads aren't supported (sandbox, exotic runtime)
   * - The built worker script can't be found
   * - Pool creation was attempted and failed
   */
  isAvailable(): boolean {
    return !this.unavailable && this.workers.length > 0;
  }

  /**
   * Lazily create the worker pool. Returns true if the pool is ready, false
   * if it's unavailable (caller should fall back to inline parsing).
   */
  async ensureReady(): Promise<boolean> {
    if (this.isAvailable()) return true;
    if (this.unavailable) return false;
    if (this.creating) {
      // Another caller is already creating — wait briefly and re-check.
      await new Promise((r) => setTimeout(r, 50));
      return this.isAvailable();
    }

    this.creating = true;
    try {
      const url = resolveWorkerScriptUrl();
      if (!url) {
        this.unavailable = true;
        return false;
      }

      for (let i = 0; i < this.maxWorkers; i++) {
        try {
          const w = new Worker(url, { name: `wstack-parser-${i}` });
          w.unref();
          w.on('message', (msg: ParserWorkerResponse) => this.handleMessage(msg));
          w.on('error', (err) => this.handleError(err, w));
          // Not every death raises an `error` event (process abort, stack
          // overflow in native code) — `exit` is the reliable backstop.
          // retireByReference is idempotent, so double-firing is safe.
          w.on('exit', () => this.retireByReference(w));
          this.workers.push({ worker: w, workerId: w.threadId, busy: false });
        } catch {
          // If we can't spawn all workers, use what we got.
          if (this.workers.length === 0) {
            this.unavailable = true;
            return false;
          }
          break;
        }
      }
      return this.workers.length > 0;
    } finally {
      this.creating = false;
    }
  }

  /**
   * Parse files in parallel across the worker pool. Returns a flat
   * `FileSymbols[]` in completion order (caller matches by file path).
   *
   * Content is pre-read by the main thread (for the content-hash check)
   * and passed to workers to avoid a second disk read. Files are
   * distributed round-robin across workers.
   */
  async parseFiles(
    files: ReadonlyArray<{ file: string; content: string; lang: SymbolLang }>,
  ): Promise<FileSymbols[]> {
    if (!this.isAvailable()) {
      throw new Error('ParserWorkerPool.parseFiles called before ensureReady() succeeded');
    }
    if (files.length === 0) return [];

    const batchId = this.nextBatchId++;
    const workerCount = Math.min(this.workers.length, files.length);

    // Round-robin distribute files across workers, recording each worker's
    // chunk so a mid-batch death knows exactly which files were orphaned.
    const chunks: { file: string; content: string; lang: SymbolLang }[][] = Array.from(
      { length: workerCount },
      () => [],
    );
    for (let i = 0; i < files.length; i++) {
      chunks[i % workerCount]!.push(files[i]!);
    }

    return new Promise<FileSymbols[]>((resolve, reject) => {
      const pendingChunks = new Map<
        number,
        { file: string; content: string; lang: SymbolLang }[]
      >();
      this.pending.set(batchId, {
        resolve,
        reject,
        accumulated: [],
        pendingChunks,
        settled: false,
      });

      for (let i = 0; i < workerCount; i++) {
        const pw = this.workers[i]!;
        pw.busy = true;
        pendingChunks.set(pw.workerId, chunks[i]!);
        pw.worker.postMessage({ type: 'parse', id: batchId, files: chunks[i]! });
      }
    });
  }

  /** Shut down all workers. Safe to call multiple times. */
  async shutdown(): Promise<void> {
    const workers = this.workers.map((w) => w.worker);
    this.workers = [];
    this.unavailable = false;

    // Claim and reject pending batches BEFORE waiting on graceful worker
    // exits: a result still in flight during the wait could otherwise
    // resolve a batch this shutdown is about to reject.
    for (const [, p] of this.pending) {
      if (p.settled) continue;
      p.settled = true;
      p.reject(new Error('ParserWorkerPool shut down'));
    }
    this.pending.clear();

    for (const w of workers) {
      try {
        w.postMessage({ type: 'shutdown' });
      } catch {
        // Worker may already be dead.
      }
    }

    // Give workers a moment to shut down gracefully, then terminate.
    await Promise.allSettled(
      workers.map((w) =>
        Promise.race([
          new Promise<void>((resolve) => {
            w.once('exit', () => resolve());
          }),
          new Promise<void>((resolve) => setTimeout(() => resolve(), 2000)),
        ]).then(() => {
          if (!w.threadId) return;
          return w.terminate().catch(() => {});
        }),
      ),
    );
  }

  private handleMessage(msg: ParserWorkerResponse): void {
    const batch = this.pending.get(msg.id);
    if (!batch) return; // Late response from a terminated worker.

    // Identity-based busy tracking (P3.7): free exactly the worker that
    // answered. The old code freed "the first busy worker" by elimination,
    // which mis-attributed completion when several workers were in flight.
    const worker = this.workers.find((w) => w.workerId === msg.workerId);
    if (worker) worker.busy = false;
    batch.pendingChunks.delete(msg.workerId);

    batch.accumulated.push(...msg.results);
    // Per-file errors (msg.errors) stay ABSENT from results on purpose: the
    // indexer's commit loop records absent files as `parse error: worker
    // returned no result` — converting them to zero-symbol rows here would
    // silently turn failures into "successfully indexed, empty".

    if (batch.pendingChunks.size === 0) {
      if (batch.settled) return;
      batch.settled = true;
      this.pending.delete(msg.id);
      batch.resolve(batch.accumulated);
    }
  }

  /**
   * Remove a worker from the pool and salvage any chunk it still owed.
   *
   * Idempotent by workerId — `error` and `exit` can both fire for one
   * death, and a worker may die while no batch references it. When the
   * dead worker owed files to an in-flight batch and other workers remain,
   * those files are re-parsed inline on this thread (one fewer worker
   * should cost latency, not correctness). When it was the last worker,
   * every remaining batch rejects so the indexer's existing inline
   * fallback takes over the whole batch.
   */
  private retireWorker(workerId: number): void {
    const entry = this.workers.find((w) => w.workerId === workerId);
    if (!entry) return;
    this.workers = this.workers.filter((w) => w.workerId !== workerId);

    for (const [batchId, batch] of [...this.pending]) {
      const orphaned = batch.pendingChunks.get(workerId);
      if (!orphaned) continue;

      if (this.workers.length === 0) {
        // Pool empty — nothing to salvage with. Reject; the indexer's
        // catch-block re-parses the entire batch inline.
        this.pending.delete(batchId);
        this.unavailable = true;
        if (!batch.settled) {
          batch.settled = true;
          batch.reject(new Error('ParserWorkerPool: all workers died mid-batch'));
        }
        continue;
      }

      // Salvage: re-parse the orphaned chunk inline. The chunk STAYS in
      // pendingChunks (still keyed by the dead workerId) until the salvage
      // completes — otherwise a fast surviving worker could resolve the
      // batch before the salvaged files land. reparseInline deletes the
      // entry (and resolves, if last) when it finishes.
      void this.reparseInline(batch, orphaned, workerId);
    }
  }

  /**
   * Salvage path: re-parse an orphaned chunk on this thread. Files that
   * fail here stay absent from the results — same contract as a per-file
   * error inside a live worker (see handleMessage).
   */
  private async reparseInline(
    batch: PendingBatch,
    orphaned: ReadonlyArray<{ file: string; content: string; lang: SymbolLang }>,
    workerId: number,
  ): Promise<void> {
    // Every exit path must release the pending-marker and resolve-if-last:
    // the marker is what keeps the batch from resolving before this salvage
    // lands, so a failure between `retireWorker` and the tail below would
    // otherwise re-create the watchdog hang P3.7 exists to kill.
    try {
      const { parseFileContent } = await import('./parser-dispatch.js');
      for (const item of orphaned) {
        // The batch may have been settled (rejected) while this salvage was
        // importing or yielding — stop parsing; its promise already ended.
        if (batch.settled) return;
        try {
          const parsed = await parseFileContent(item.file, item.content, item.lang);
          batch.accumulated.push(parsed);
        } catch {
          // Absent on purpose — see handleMessage.
        }
        // Yield between salvaged files so a large orphaned chunk cannot
        // starve the event loop the surviving workers also use.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } finally {
      this.finishSalvage(batch, workerId);
    }
  }

  /**
   * Terminal tail of a salvage — runs on every exit path. Kept free of
   * control flow inside a `finally` (noUnsafeFinally): releases the
   * pending-marker and resolves the batch if this was its last chunk.
   */
  private finishSalvage(batch: PendingBatch, workerId: number): void {
    batch.pendingChunks.delete(workerId);
    if (batch.pendingChunks.size === 0) {
      // Resolve only if still tracked — a concurrent reject (e.g. the last
      // worker died while salvaging) must win.
      for (const [batchId, tracked] of this.pending) {
        if (tracked === batch) {
          if (batch.settled) return;
          batch.settled = true;
          this.pending.delete(batchId);
          batch.resolve(batch.accumulated);
          return;
        }
      }
    }
  }

  /**
   * Retire by worker object rather than threadId. `threadId` is -1 before
   * the worker emits `online`, so a death during script load would make a
   * threadId-keyed lookup silently no-op and leak the entry (with its
   * pending chunk) — reference identity is correct in every case.
   */
  private retireByReference(source: Worker): void {
    // Only a tracked worker can owe a pending chunk; an untracked source
    // (already retired via its other death event) needs no action.
    const entry = this.workers.find((w) => w.worker === source);
    if (entry) this.retireWorker(entry.workerId);
  }

  private handleError(err: unknown, source: Worker): void {
    // The error object itself is not needed beyond diagnosis logging.
    void err;
    this.retireByReference(source);
  }
}

/**
 * Default worker count: CPU cores minus 1 (leave one for the main thread),
 * clamped to [1, 4]. The cap of 4 prevents excessive SQLite write contention
 * and keeps WASM grammar memory bounded (~25MB per worker × 4 = 100MB max).
 */
function defaultWorkerCount(): number {
  const cores = (globalThis.navigator?.hardwareConcurrency as number | undefined) ?? 4;
  return Math.max(1, Math.min(4, cores - 1));
}

/**
 * Locate the compiled worker script. The bundler outputs it alongside the
 * main codebase-index bundle. From source (vitest) the file doesn't exist,
 * so the pool reports unavailable and the indexer falls back to inline.
 *
 * `WRONGSTACK_PARSER_WORKER_SCRIPT` (absolute path) overrides the probe —
 * used by dist-gated tests to drive the source pool class with the built
 * worker, and usable in exotic packaging layouts where the script lands
 * somewhere the relative probe cannot reach.
 */
function resolveWorkerScriptUrl(): URL | null {
  const override = process.env['WRONGSTACK_PARSER_WORKER_SCRIPT'];
  // pathToFileURL, not manual interpolation: override paths may contain
  // URL-reserved characters (#, %) that a hand-built file:/// URL would
  // silently reinterpret as fragment/escape.
  if (override) return pathToFileURL(override);
  for (const rel of ['./parser-worker-script.js', './codebase-index/parser-worker-script.js']) {
    try {
      const url = new URL(rel, import.meta.url);
      if (url.protocol === 'file:' && fs.existsSync(fileURLToPath(url))) return url;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

// ─── Module-level singleton ─────────────────────────────────────────────────

let _pool: ParserWorkerPool | null = null;

/**
 * Lazily-created process-wide singleton. Returns null when worker threads
 * are unavailable (sandbox, exotic runtime) or the compiled worker script
 * can't be found — callers must fall back to inline parsing in that case.
 */
export function getParserPool(): ParserWorkerPool | null {
  _pool ??= new ParserWorkerPool();
  return _pool;
}
