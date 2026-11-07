import type { IndexerOptions } from './indexer-discovery.js';
import { discoverIndexerFiles } from './indexer-discovery.js';

export { shouldUseParserWorkerPool } from './indexer-symbol-ownership.js';

/**
 * Main indexing orchestrator.
 *
 * Given a project root and a list of files:
 * 1. Parse each file with the appropriate parser (TS, Go, Python, Rust, JSON, YAML)
 * 2. Delete old symbols for changed/deleted files
 * 3. Insert new symbols
 * 4. Update file metadata
 * 5. Return index statistics
 */

import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import { indexParallelBatchSize, isFrugalPerf } from '@wrongstack/core/utils';
import { throwIfAborted, YIELD_EVERY_N, yieldEventLoop } from './index-scheduling.js';
import { gitBlobStamp } from './index-source-files.js';
import { commitBatchResults } from './indexer-batch-commit.js';
import { parseBatchFiles, readBatchFiles } from './indexer-batch-read.js';
import { finalizeIndexRun } from './indexer-finalize.js';
import {
  type IndexRunState,
  MODULE_OWNER_VERSION,
  MODULE_OWNER_VERSION_KEY,
} from './indexer-run-state.js';
import type { ParserWorkerPool } from './parser-worker-pool.js';
import type { FileMeta, IndexResult } from './schema.js';
import { IndexStore } from './writer.js';
import { resolveIndexDir } from './writer-helpers.js';
import { IndexOwnedExternallyError, isOwnedByWrongIndex } from './wrongindex/owner-lock.js';

export { GRAPH_STAMP_KEY } from './indexer-run-state.js';

/**
 * Parallel parse batch size — see {@link indexParallelBatchSize}.
 * Re-resolved at the start of each index run so env profile changes apply.
 */
export function resolveParallelBatch(): number {
  return indexParallelBatchSize(availableParallelism());
}

/** Balanced-profile batch width, used by a frugal process's rebuild. */
const REBUILD_PARALLEL_BATCH = 40;

/** Run a full or incremental index and return statistics. */
export async function runIndexer(_ctx: Context, opts: IndexerOptions): Promise<IndexResult> {
  const store = new IndexStore(opts.projectRoot, { indexDir: opts.indexDir });
  try {
    return await runIndexerWithStore(store, opts);
  } finally {
    // Always release the synchronous SQLite connection — an abort mid-run
    // (executor timeout, session teardown) previously leaked it.
    try {
      store.close();
    } catch {
      /* already closed */
    }
  }
}

export async function runIndexerWithStore(
  store: IndexStore,
  opts: IndexerOptions,
): Promise<IndexResult> {
  // Checked per run: a long-lived store (project server, pool) may predate a
  // WrongIndex claim on this index.
  const ownedDir = resolveIndexDir(opts.projectRoot, opts.indexDir);
  if (isOwnedByWrongIndex(ownedDir)) throw new IndexOwnedExternallyError(ownedDir);
  // An edit that races the run no longer voids it: the finalize pass withholds
  // the Git stamp of a file that moved, and its next run reads it again.
  const result = await store.runAtomicIndexUpdate(() => runIndexerAtomic(store, opts));
  // VACUUM cannot run inside a transaction. Publish the completed generation
  // first, then perform best-effort maintenance on full-project runs.
  if (!opts.files) store.compactIfNeeded();
  return result;
}

async function runIndexerAtomic(store: IndexStore, opts: IndexerOptions): Promise<IndexResult> {
  const { projectRoot, langs, ignore = [], signal } = opts;
  // Graph semantics changed without a structural SQLite schema change. Keep a
  // separate data-version marker so older running processes do not downgrade
  // and wipe the same shared DB while a new WebUI is being rolled out.
  const relationGraphVersion = '2';
  const refResolutionVersion = '2';
  const graphVersionStale = store.getMetadata('relation_graph_version') !== relationGraphVersion;
  const force = (opts.force ?? false) || graphVersionStale;
  const needsFullRefResolution =
    force || store.getMetadata('ref_resolution_version') !== refResolutionVersion;
  const startMs = Date.now();
  const errors: string[] = [];
  const langStats: Record<string, number> = {};
  let { files, discoveredFiles, discoveryComplete, cleanBlobs, discoverySnapshotKey, dirtyHashes } =
    await discoverIndexerFiles({ projectRoot, opts, store, signal, ignore, errors, langs });

  // A user-forced run limited to some languages or files re-parses exactly
  // that scope. Clearing the WHOLE index first (as a scoped `force` used to)
  // deleted every other language's symbols — `codebase-index({ force: true,
  // langs: ['json'] })` wiped the TypeScript index until the next full run.
  // A relation-graph version bump still clears everything: the old rows are
  // semantically invalid regardless of scope.
  const scopedRun = (langs?.length ?? 0) > 0 || (opts.files?.length ?? 0) > 0;
  const clearedAll = force && (graphVersionStale || !scopedRun);
  if (clearedAll) {
    store.clearAll();
    // Rebuilding into an empty index: bulk-insert without the secondary
    // indexes and build each once after the batch loop. Nothing in the loop
    // may look rows up by those columns — see the `clearedAll` branches.
    store.deferSecondaryIndexes();
  }

  // Collect existing file metadata for incremental check. A targeted run
  // needs only its own files' previous state; a full scan needs every row to
  // find the files that vanished. Loaded even for a forced run, so the
  // relation pass can tell a re-parsed file from a new one.
  const existingMeta: Map<string, FileMeta> = new Map();
  const previousMetas = opts.files ? store.getFileMetas(files) : store.getAllFileMetas();
  for (const meta of previousMetas) existingMeta.set(meta.file, meta);
  // Files indexed under an older ref-ownership rule: forget their content
  // stamps so this run re-parses them (see moduleOwnerSymbol). Only a full run
  // records the new version, so a targeted run cannot strand the upgrade.
  const moduleOwnersStale =
    !clearedAll && store.getMetadata(MODULE_OWNER_VERSION_KEY) !== MODULE_OWNER_VERSION;
  if (moduleOwnersStale) {
    for (const meta of previousMetas) {
      existingMeta.set(meta.file, { ...meta, contentHash: '', gitBlob: '' });
    }
  }
  const healSageAnchors =
    !clearedAll && existsSync(path.join(projectRoot, '.wrongstack', 'memories'));
  const run: IndexRunState = {
    clearedAll,
    errors,
    langStats,
    filesIndexed: 0,
    filesParsed: 0,
    filesSkipped: 0,
    filesEmpty: 0,
    filesFailed: 0,
    symbolsIndexed: 0,
    existingMeta,
    rewritten: new Set<string>(),
    added: new Set<string>(),
    deleted: new Set<string>(),
    rewrittenHashes: new Map<string, string>(),
    failed: new Set<string>(),
    deferredRefNames: new Set<string>(),
    ...(healSageAnchors
      ? {
          prevSymbolsForHeal: [],
          nextSymbolsForHeal: [],
        }
      : {}),
  };

  // Per-file Git trust. A clean working copy only proves the file matches its
  // staged blob; it says nothing about whether the DB row was built from that
  // blob. `files.git_blob` records exactly that — the blob (and content hash)
  // a completed full run saw this file clean at — so a match means unchanged
  // since, with no stat and no read. Trust used to be one repository-wide
  // snapshot key: any edit anywhere voided it and the run re-read every file.
  const totalFilesForProgress = files.length;
  let filesPreSkipped = 0;
  if (!force && cleanBlobs) {
    files = files.filter((file) => {
      const meta = existingMeta.get(file);
      const blob = cleanBlobs.get(file);
      // An empty stamp vouches for nothing: `gitBlobStamp` of a row with no
      // content hash is '' too, and equality alone trusted such rows forever.
      if (
        !meta?.gitBlob ||
        blob === undefined ||
        meta.gitBlob !== gitBlobStamp(blob, meta.contentHash)
      ) {
        return true;
      }
      langStats[meta.lang] = (langStats[meta.lang] ?? 0) + meta.symbolCount;
      run.symbolsIndexed += meta.symbolCount;
      // P5.15: skipped files no longer count toward filesIndexed — the
      // headline is files actually parsed this run (see fileOutcomes).
      run.filesSkipped++;
      filesPreSkipped++;
      return false;
    });
    if (filesPreSkipped > 0) opts.onProgress?.(filesPreSkipped, totalFilesForProgress);
  }

  // Process files in batches for parallel I/O and parsing.
  // SQLite writes remain sequential (they're synchronous and CPU-bound).
  // Batch width follows WRONGSTACK_PERF_PROFILE (frugal ≤4, balanced cores×4).
  // A frugal process rebuilding into an empty index uses the balanced batch
  // width and a small private parser pool; see shouldUseParserWorkerPool.
  const frugalRebuild = clearedAll && isFrugalPerf();
  const parallelBatch = frugalRebuild ? REBUILD_PARALLEL_BATCH : resolveParallelBatch();
  const parserPoolCandidateCount = files.length;
  const rebuildPool: { current?: ParserWorkerPool | undefined } = {};
  let filesSinceLastYield = 0;
  try {
    for (let batchStart = 0; batchStart < files.length; batchStart += parallelBatch) {
      const batchEnd = Math.min(batchStart + parallelBatch, files.length);
      const batchFiles = files.slice(batchStart, batchEnd);

      // Report progress to the caller so UIs can show indexing status.
      opts.onProgress?.(filesPreSkipped + batchEnd, totalFilesForProgress);

      // Yield the event loop periodically so the main thread stays responsive
      // (TUI rendering, input handling, etc.) during large index builds.
      // Uses a running counter instead of batchStart % YIELD_EVERY_N which
      // only works when the batch size divides YIELD_EVERY_N evenly — with
      // dynamic batch sizes that invariant no longer holds and the yield would
      // fire far less often than intended.
      // Also check for cancellation — the tool executor's timeout or a
      // session abort propagates through `signal`.
      filesSinceLastYield += batchFiles.length;
      if (filesSinceLastYield >= YIELD_EVERY_N) {
        filesSinceLastYield = 0;
        await yieldEventLoop();
        // Frugal: brief pause so sustained reindex doesn't pin a core.
        if (isFrugalPerf()) {
          await new Promise<void>((r) => setTimeout(r, 8));
        }
        throwIfAborted(signal);
      }

      const statReadParse = await readBatchFiles(batchFiles, {
        signal,
        force,
        existingMeta,
        dirtyHashes,
      });
      await parseBatchFiles(statReadParse, batchFiles, {
        parserPoolCandidateCount,
        clearedAll,
        frugalRebuild,
        rebuildPool,
      });
      commitBatchResults(store, run, statReadParse, batchFiles);
    }
  } finally {
    // The rebuild's private pool must not outlive the run (each worker holds
    // a TypeScript compiler); shut it down on success, failure and abort alike.
    await rebuildPool.current?.shutdown();
  }

  return finalizeIndexRun(store, run, {
    projectRoot,
    opts,
    force,
    needsFullRefResolution,
    discoveredFiles,
    discoveryComplete,
    cleanBlobs,
    discoverySnapshotKey,
    startMs,
    relationGraphVersion,
    refResolutionVersion,
  });
}
