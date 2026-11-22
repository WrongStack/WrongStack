/**
 * The read and parse phases of one indexer batch: parallel stat + incremental
 * skip + read, then a single-threaded parse pass (worker pool or inline).
 */

import type { Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import { toErrorMessage } from '@wrongstack/core/utils';
import { xxhash64String as contentHashHex } from './content-hash.js';
import { isMissingPathError, MAX_INDEX_FILE_BYTES } from './index-source-files.js';
import { isAbortError } from './indexer-run-state.js';
import { shouldUseParserWorkerPool } from './indexer-symbol-ownership.js';
import { detectLang } from './languages.js';
import { type parseFileContent, parseFilesContent } from './parser-dispatch.js';
import {
  createRebuildParserPool,
  getParserPool,
  type ParserWorkerPool,
} from './parser-worker-pool.js';
import { recordFilesystemRead } from './perf-metrics.js';
import type { FileMeta, SymbolLang } from './schema.js';

export interface BatchFileRead {
  file: string;
  stat: Stats;
  lang: string;
  parsed: Awaited<ReturnType<typeof parseFileContent>> | null;
  content?: string;
  contentHash?: string;
  skippedMeta?: FileMeta;
  error?: string;
  missing?: boolean;
}

export interface BatchReadContext {
  signal: AbortSignal | undefined;
  force: boolean;
  existingMeta: Map<string, FileMeta>;
  /** Content hashes discovery already computed for dirty files. */
  dirtyHashes: Map<string, string> | undefined;
}

/** Phase 1: Parallel stat + incremental skip + read (parsing is deferred). */
export function readBatchFiles(
  batchFiles: string[],
  ctx: BatchReadContext,
): Promise<PromiseSettledResult<BatchFileRead>[]> {
  const { signal, force, existingMeta, dirtyHashes } = ctx;
  const statOpts = signal ? { signal } : {};
  return Promise.allSettled(
    batchFiles.map(async (file): Promise<BatchFileRead> => {
      let stat: Stats;
      try {
        stat = await (fs.stat as (path: string, opts: { signal?: AbortSignal }) => Promise<Stats>)(
          file,
          statOpts,
        );
      } catch (e) {
        if (isAbortError(e)) throw e;
        return {
          file,
          stat: null as never as Stats,
          lang: '',
          parsed: null,
          error: `stat error: ${toErrorMessage(e)}`,
          missing: isMissingPathError(e),
        };
      }
      if (!stat.isFile()) return { file, stat, lang: '', parsed: null };

      const lang = detectLang(file);
      if (!lang) return { file, stat, lang: '', parsed: null };
      if (stat.size > MAX_INDEX_FILE_BYTES) {
        return {
          file,
          stat,
          lang,
          parsed: null,
          error: `file too large (${stat.size} bytes; max ${MAX_INDEX_FILE_BYTES})`,
        };
      }

      const meta = force ? undefined : existingMeta.get(file);

      // Discovery already hashed every dirty file for the Git snapshot. A
      // match with the stored hash needs no second read; had the file
      // changed since, the end-of-run snapshot check retries the run.
      const snapshotHash = dirtyHashes?.get(file);
      if (meta?.contentHash && snapshotHash === meta.contentHash) {
        return {
          file,
          stat,
          lang,
          parsed: null,
          contentHash: snapshotHash,
          skippedMeta: { ...meta, mtimeMs: Math.floor(stat.mtimeMs) },
        };
      }

      let content: string;
      try {
        content = await fs.readFile(file, { encoding: 'utf8', signal });
        recordFilesystemRead(Buffer.byteLength(content, 'utf8'));
      } catch (e) {
        if (isAbortError(e)) throw e;
        return {
          file,
          stat,
          lang,
          parsed: null,
          error: `read error: ${toErrorMessage(e)}`,
        };
      }

      // Phase 2: content-hash short-circuit. mtime can change without the
      // bytes changing (git checkout, touch, formatter that's a no-op).
      // When the content hash matches what's stored, skip the expensive
      // parse pass entirely — but still update mtime so the next run's
      // fast path (the mtime check above) hits again.
      //
      // Compute the hash once here — it's reused in the return object so
      // the batch-write path doesn't hash the same content a second time.
      // Skip the short-circuit when there's no stored hash yet (first
      // index of this file, or a legacy v4 DB that hasn't been populated).
      // Without this guard, an empty stored hash would match an empty
      // computed hash on every run, skipping parsing forever.
      const contentHash = contentHashHex(content);
      if (!force && meta && meta.contentHash && contentHash === meta.contentHash) {
        return {
          file,
          stat,
          lang,
          parsed: null,
          content,
          contentHash,
          skippedMeta: { ...meta, mtimeMs: Math.floor(stat.mtimeMs) },
        };
      }

      // Phase 5: Parsing is deferred to a post-batch pass to avoid
      // concurrent-mutation races inside Promise.allSettled callbacks.
      // The callback returns the read content; the main thread decides
      // whether to parse inline or delegate to the worker pool after all
      // stat+hash checks have settled.
      return { file, stat, lang, parsed: null, content, contentHash };
    }),
  );
}

export interface BatchParseContext {
  parserPoolCandidateCount: number;
  clearedAll: boolean;
  frugalRebuild: boolean;
  /** The rebuild's private pool, created on first use; the caller shuts it down. */
  rebuildPool: { current?: ParserWorkerPool | undefined };
}

/** Phase 1.5: parse what the read phase left unparsed, filling `parsed` / `error` in place. */
export async function parseBatchFiles(
  statReadParse: PromiseSettledResult<BatchFileRead>[],
  batchFiles: string[],
  ctx: BatchParseContext,
): Promise<void> {
  const { parserPoolCandidateCount, clearedAll, frugalRebuild } = ctx;
  // Phase 1.5: Post-batch parse pass. Files were stat+hash-checked and
  // content-read in the parallel pass above, but parsing was deferred to
  // avoid the concurrent-mutation race that an inline pool delegation
  // inside each Promise.allSettled callback would create. Here we collect
  // all files that need parsing, then either delegate to the worker pool
  // (when available and the batch is large enough) or parse inline — both
  // single-threaded, no race.
  const toParse: Array<{
    index: number;
    file: string;
    content: string;
    lang: SymbolLang;
  }> = [];
  for (let pi = 0; pi < statReadParse.length; pi++) {
    const s = statReadParse[pi]!;
    if (s.status !== 'fulfilled') continue;
    const r = s.value;
    if (r.error || r.skippedMeta || !r.lang || r.parsed) continue;
    if (r.content === undefined) continue;
    toParse.push({
      index: pi,
      file: batchFiles[pi]!,
      content: r.content,
      lang: r.lang as SymbolLang,
    });
  }

  if (toParse.length > 0) {
    // Try the worker pool for large batches (Phase 5 — threshold-gated).
    // Falls back to inline parsing when the pool isn't available or the
    // batch is too small to justify spawn overhead. Activation is based on
    // files-to-parse count, not total file count, so stat-skipped batches
    // don't waste pool overhead on a tiny workload.
    let pool: ParserWorkerPool | null = null;
    if (
      shouldUseParserWorkerPool(parserPoolCandidateCount, toParse.length, {
        rebuild: clearedAll,
      })
    ) {
      if (frugalRebuild) {
        ctx.rebuildPool.current ??= createRebuildParserPool();
        pool = ctx.rebuildPool.current;
      } else {
        pool = getParserPool();
      }
    }
    if (pool) {
      try {
        await pool.ensureReady();
        const parsedResults = await pool.parseFiles(
          toParse.map((p) => ({ file: p.file, content: p.content, lang: p.lang })),
        );
        // Match by file path — pool results arrive in completion order
        // (worker N may finish before worker M), not positional alignment.
        // Files that errored inside a worker are absent from parsedResults;
        // record them as parse errors so the commit loop doesn't silently
        // index them with zero symbols.
        const byFile = new Map(parsedResults.map((r) => [r.file, r]));
        for (const item of toParse) {
          const parsed = byFile.get(item.file);
          const settled = statReadParse[item.index]!;
          if (settled.status !== 'fulfilled') continue;
          if (parsed) {
            settled.value.parsed = parsed;
          } else {
            settled.value.error = `parse error: worker returned no result for ${item.file}`;
          }
        }
      } catch {
        // Pool failure — fall through to inline parsing for all files.
        pool = null;
      }
    }

    // Inline fallback (or when pool wasn't available). Parse in parallel
    // — this is the same parallelism the pre-refactor code had via the
    // single Promise.allSettled callback. Sequential parsing would
    // regress incremental indexing latency. P3.8: one call for the whole
    // slice, so Go/Python files inside it share one toolchain child
    // process per chunk instead of one spawn per file.
    if (!pool) {
      const parsedAll = await parseFilesContent(
        toParse.map((p) => ({ file: p.file, content: p.content, lang: p.lang })),
      );
      for (let pi2 = 0; pi2 < parsedAll.length && pi2 < toParse.length; pi2++) {
        const settled = statReadParse[toParse[pi2]!.index]!;
        if (settled.status !== 'fulfilled') continue;
        const slot = parsedAll[pi2]!;
        if (slot.result) {
          settled.value.parsed = slot.result;
        } else {
          // A throwing parser no longer aborts the run — parseFilesContent
          // contains it and carries the message (P3.8 fix; P2.5 surfaces it).
          settled.value.error = `parse error: ${slot.error ?? `no result for ${toParse[pi2]!.file}`}`;
        }
      }
    }
  }
}
