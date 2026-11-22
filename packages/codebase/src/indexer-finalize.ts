/**
 * The end of an index run: stale-row removal, ref resolution and binding,
 * relation and rank passes, Git blob trust stamps, and the result.
 */

import * as path from 'node:path';
import {
  detectMovedOrRenamedSymbols,
  remapAnchoredSageMemories,
  type SymbolSnapshotItem,
} from './ecosystem-bridge.js';
import { runGraphRankPass, shouldRefreshRanks } from './graph-rank-pass.js';
import { currentCleanBlobs, gitBlobStamp } from './index-source-files.js';
import type { IndexerOptions } from './indexer-discovery.js';
import {
  GRAPH_STAMP_KEY,
  type IndexRunState,
  MODULE_OWNER_VERSION,
  MODULE_OWNER_VERSION_KEY,
} from './indexer-run-state.js';
import { planRefBinding, runRefBinding } from './ref-binding-pass.js';
import {
  MODULE_RESOLUTION_VERSION,
  MODULE_RESOLUTION_VERSION_KEY,
  RELATION_STRUCTURE_KEY,
  resolveProjectRelations,
} from './relation-pass.js';
import type { IndexResult } from './schema.js';
import type { IndexStore } from './writer.js';

export interface FinalizeIndexRunInput {
  projectRoot: string;
  opts: IndexerOptions;
  force: boolean;
  needsFullRefResolution: boolean;
  discoveredFiles: Set<string> | null;
  discoveryComplete: boolean;
  cleanBlobs: Map<string, string> | undefined;
  discoverySnapshotKey: string | undefined;
  startMs: number;
  relationGraphVersion: string;
  refResolutionVersion: string;
}

export async function finalizeIndexRun(
  store: IndexStore,
  run: IndexRunState,
  input: FinalizeIndexRunInput,
): Promise<IndexResult> {
  const {
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
  } = input;
  const { langs, signal } = opts;
  const { clearedAll, errors, existingMeta, rewritten, added, deleted, rewrittenHashes, failed } =
    run;
  const { deferredRefNames } = run;

  if (clearedAll) store.restoreSecondaryIndexes();

  // Remove stale entries for files deleted since last run.
  // Instead of stat-ing every previously-indexed file (O(total indexed)),
  // derive stale files from the discovered set: any existingMeta entry not
  // in the scanned files is stale. Skip entirely for explicit file lists
  // (targeted reindex — can't derive stale from a subset).
  if (discoveredFiles && discoveryComplete && !clearedAll) {
    for (const [file_] of existingMeta) {
      if (!discoveredFiles.has(file_)) {
        if (run.prevSymbolsForHeal) {
          for (const sym of store.search('', { file: file_ })) {
            run.prevSymbolsForHeal.push({
              name: sym.name,
              kind: sym.kind,
              file: sym.file,
              line: sym.line,
              signature: sym.signature,
            });
          }
        }
        // Names re-resolve once below (resolveRefsForNames), not once per deleted file.
        store.deleteFile(file_, { deferResolution: deferredRefNames });
        deleted.add(file_);
      }
    }
  }

  // Batch commits resolve only names touched by that batch. Existing databases
  // get one global repair pass when this contract version changes; subsequent
  // single-file watcher runs avoid rebuilding the full symbol-name map.
  if (needsFullRefResolution) store.resolveRefs();
  else if (deferredRefNames.size > 0) store.resolveRefsForNames(deferredRefNames);
  // Import-aware binding runs after module resolution, but what it must
  // revisit is read before: the relation pass clears the targets it keys on.
  const bindingPlan = planRefBinding(store, {
    changes: { rewritten, deleted },
    full: clearedAll || needsFullRefResolution,
    structureKey: RELATION_STRUCTURE_KEY,
    moduleVersionCurrent:
      store.getMetadata(MODULE_RESOLUTION_VERSION_KEY) === MODULE_RESOLUTION_VERSION,
  });
  // Proportional to what changed: a watcher echo of an already-indexed edit,
  // or a full scan over an unchanged checkout, re-resolves nothing.
  const relationsResolved = await resolveProjectRelations(store, projectRoot, {
    changes: { rewritten, added, deleted },
    full: needsFullRefResolution,
    projectScan: !opts.files,
    errors,
    signal,
  });
  const bindingsChanged = runRefBinding(store, bindingPlan, {
    added,
    structureKey: RELATION_STRUCTURE_KEY,
    errors,
    signal,
  });
  const relationsChanged = relationsResolved || bindingsChanged;
  store.setMetadata('ref_resolution_version', refResolutionVersion);
  // Only a run that saw every file has re-parsed every symbol-less one.
  if (clearedAll || (!opts.files && !langs?.length && discoveryComplete)) {
    store.setMetadata(MODULE_OWNER_VERSION_KEY, MODULE_OWNER_VERSION);
  }
  store.setMetadata('relation_graph_version', relationGraphVersion);
  const changedFiles = rewritten.size + deleted.size;
  // Centrality last: every ref now has its final to_id/to_file, so this is the
  // first point at which the wiring graph is the graph the generation will
  // publish. Failure is recorded in `errors` and never fails the run.
  let ranksChanged = false;
  if (shouldRefreshRanks(store, { changedFiles, force })) {
    ranksChanged = runGraphRankPass(store, errors).computed;
  }
  const completeProjectScope =
    !opts.files && (!langs || langs.length === 0) && (!opts.ignore || opts.ignore.length === 0);
  if (completeProjectScope && discoverySnapshotKey !== undefined && cleanBlobs && discoveredFiles) {
    // Every file Git reports clean now has rows built from its staged blob.
    // Record that per file; a failed file keeps whatever it had (its rows are
    // an older copy).
    const blobUpdates = new Map<string, string>();
    const previousStamps = new Map<string, string>();
    let blesses = false;
    for (const file of discoveredFiles) {
      if (failed.has(file)) continue;
      const wasRewritten = rewrittenHashes.has(file);
      const previous = existingMeta.get(file);
      const hash = wasRewritten ? rewrittenHashes.get(file) : previous?.contentHash;
      if (hash === undefined) continue;
      const blob = cleanBlobs.get(file);
      const desired = blob === undefined ? '' : gitBlobStamp(blob, hash);
      // Rewrites already cleared the column; skipped rows kept theirs.
      const current = wasRewritten ? '' : (previous?.gitBlob ?? '');
      if (desired === current) continue;
      blobUpdates.set(file, desired);
      previousStamps.set(file, current);
      if (desired !== '') blesses = true;
    }
    // A new stamp vouches that a file's rows match its blob, which only holds if
    // that file did not move between discovery and the end of the run — so
    // re-list and check each stamp against its own file. A run that stamps
    // nothing (the steady state: every clean file already trusted) has nothing
    // to vouch for and skips the extra git process.
    //
    // This used to compare one repository-wide snapshot and throw the run away
    // on any difference. In a checkout where agents edit files all the time a
    // full run (minutes on a large tree) always saw some unrelated change, so it
    // was discarded twice, never published and never stamped — and the next run
    // re-read everything again. A file that moved simply gets no stamp; its next
    // run (or the watcher) reads it.
    if (blesses) {
      const now = await currentCleanBlobs(projectRoot, discoveredFiles, signal);
      for (const [file, stamp] of blobUpdates) {
        if (stamp === '' || now?.get(file) === cleanBlobs.get(file)) continue;
        if (previousStamps.get(file) === '') blobUpdates.delete(file);
        else blobUpdates.set(file, '');
      }
    }
    store.setGitBlobs(blobUpdates);
  }
  // Planner refresh belongs to bulk runs that moved real data, not the edit
  // watcher hot path — nor a full scan that found nothing to do.
  // P5.15: gate on actual work (parsed files), not the inflated legacy count.
  if ((!opts.files && changedFiles > 0) || run.filesIndexed >= 50) store.optimize();

  // `graph_stamp` is what content caches key on (the wiring-graph cache): it
  // moves only when rows or edges did. `last_indexed` still records every
  // full scan — it answers "when was this verified" — but a targeted run that
  // changed nothing (the watcher's echo of an edit a tool already indexed)
  // touches neither.
  if (changedFiles > 0 || relationsChanged) {
    store.setMetadata(GRAPH_STAMP_KEY, `${Date.now()}:${changedFiles}`);
  }
  if (changedFiles > 0 || !opts.files) store.setLastIndexed(Date.now());
  if (
    run.prevSymbolsForHeal &&
    run.nextSymbolsForHeal &&
    run.prevSymbolsForHeal.length > 0 &&
    run.nextSymbolsForHeal.length > 0
  ) {
    const toRel = (s: SymbolSnapshotItem): SymbolSnapshotItem => {
      const rel = path.isAbsolute(s.file)
        ? path.relative(projectRoot, s.file).replace(/\\/g, '/')
        : s.file.replace(/\\/g, '/');
      return { ...s, file: rel };
    };
    const moves = detectMovedOrRenamedSymbols(
      run.prevSymbolsForHeal.map(toRel),
      run.nextSymbolsForHeal.map(toRel),
    );
    if (moves.length > 0) {
      remapAnchoredSageMemories(projectRoot, moves);
    }
  }
  const durationMs = Date.now() - startMs;

  return {
    filesIndexed: run.filesIndexed,
    fileOutcomes: {
      parsed: run.filesParsed,
      skipped: run.filesSkipped,
      empty: run.filesEmpty,
      failed: run.filesFailed,
    },
    symbolsIndexed: run.symbolsIndexed,
    langStats: run.langStats,
    durationMs,
    errors,
    changedFiles,
    contentChanged: changedFiles > 0 || relationsChanged || ranksChanged || clearedAll,
  };
}
