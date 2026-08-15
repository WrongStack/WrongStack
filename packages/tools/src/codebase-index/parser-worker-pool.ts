/**
 * Multi-threaded parser worker pool for bulk indexing.
 *
 * Spawns N worker threads (N = CPU cores - 1, clamped to [1, 4]) that share
 * the file-parsing load during startup/full reindex passes. Each worker runs
 * `parser-worker-script.ts`, reads files from disk, parses them via
 * `parseFileContent`, and returns `FileSymbols[]`.
 *
 * The main thread distributes files in round-robin batches, collects results,
 * and performs all SQLite writes via `commitBatch`. Workers never touch the
 * database — single-writer WAL semantics are preserved.
 *
 * The pool is created lazily on first use and terminated on shutdown. Workers
 * are `unref()`'d so they don't keep the process alive.
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import type { FileSymbols, SymbolLang } from './schema.js';
import type { ParserWorkerResponse } from './parser-worker-script.js';

/** Minimum number of files before the pool is worth spawning. */
export const WORKER_POOL_THRESHOLD = 500;

interface PendingBatch {
  resolve: (results: FileSymbols[]) => void;
  reject: (err: unknown) => void;
  accumulated: FileSymbols[];
  expectedWorkers: number;
  completedWorkers: number;
}

interface PoolWorker {
  worker: Worker;
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
          this.workers.push({ worker: w, busy: false });
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
   * `FileSymbols[]` in completion order (caller sorts if needed).
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

    // Round-robin distribute files across workers.
    const chunks: { file: string; lang: SymbolLang }[][] = Array.from(
      { length: workerCount },
      () => [],
    );
    for (let i = 0; i < files.length; i++) {
      chunks[i % workerCount]!.push(files[i]!);
    }

    return new Promise<FileSymbols[]>((resolve, reject) => {
      this.pending.set(batchId, {
        resolve,
        reject,
        accumulated: [],
        expectedWorkers: workerCount,
        completedWorkers: 0,
      });

      for (let i = 0; i < workerCount; i++) {
        const pw = this.workers[i]!;
        pw.busy = true;
        pw.worker.postMessage({
          type: 'parse',
          id: batchId,
          files: chunks[i],
        });
      }
    });
  }

  /** Shut down all workers. Safe to call multiple times. */
  async shutdown(): Promise<void> {
    const workers = this.workers.map((w) => w.worker);
    this.workers = [];
    this.unavailable = false;

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

    // Reject any pending batches.
    for (const [, p] of this.pending) p.reject(new Error('ParserWorkerPool shut down'));
    this.pending.clear();
  }

  private handleMessage(msg: ParserWorkerResponse): void {
    const batch = this.pending.get(msg.id);
    if (!batch) return; // Late response from a terminated worker.

    batch.accumulated.push(...msg.results);
    batch.completedWorkers++;

    // Mark the worker that sent this as free (match by elimination).
    // Workers don't carry their own ID in the response, so we find a
    // busy worker and mark it free. This is safe because each batch has
    // a fixed set of workers, and responses arrive one-per-worker.
    const freeWorker = this.workers.find((w) => w.busy);
    if (freeWorker) freeWorker.busy = false;

    if (batch.completedWorkers >= batch.expectedWorkers) {
      this.pending.delete(msg.id);
      batch.resolve(batch.accumulated);
    }
  }

  private handleError(err: unknown, source: Worker): void {
    // Remove the dead worker from the pool.
    this.workers = this.workers.filter((w) => w.worker !== source);

    // If all workers die, reject all pending batches.
    if (this.workers.length === 0) {
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
      this.unavailable = true;
    }
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
 */
function resolveWorkerScriptUrl(): URL | null {
  for (const rel of ['./parser-worker-script.js', './codebase-index/parser-worker-script.js']) {
    try {
      const url = new URL(rel, import.meta.url);
      if (url.protocol === 'file:' && fs.existsSync(fileURLToPath(url))) return url;
    } catch {
      /* try next candidate */
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
