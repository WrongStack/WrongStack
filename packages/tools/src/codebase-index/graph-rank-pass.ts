/**
 * The index-time centrality pass.
 *
 * Runs inside the indexer's atomic update, immediately after ref resolution
 * and module resolution have settled: `refs.to_id` is only final at that
 * point, and a rank computed from half-resolved refs would describe a graph
 * that never existed.
 *
 * Rank is a property of the whole graph, so this recomputes everything or
 * nothing. That is affordable on a full run and wasteful on a one-file
 * watcher run, which is what {@link shouldRefreshRanks} arbitrates.
 */

import { aggregateFileRank, buildWiringGraph, pageRank, toSymbolRankRows } from './graph-rank.js';
import type { IndexStore } from './writer.js';

/**
 * Data-version marker for the rank layer, in the same spirit as
 * `relation_graph_version`: bumping it forces every index to recompute ranks
 * once without a `SCHEMA_VERSION` bump (which would drop and rebuild the
 * entire database). Older processes sharing the DB cannot downgrade it.
 */
export const RANK_VERSION = '1';
export const RANK_VERSION_KEY = 'rank_version';

/**
 * Above this many files in a targeted run, recompute. A watcher run that
 * touches one file barely moves any score, so leaving ranks one generation
 * stale is the cheaper trade; a bulk targeted run is effectively a full run
 * and should not be served stale ranks.
 */
export const RANK_REFRESH_FILE_THRESHOLD = 25;

export interface RankPassResult {
  /** False when the pass decided the existing ranks were good enough. */
  computed: boolean;
  symbols: number;
  files: number;
  durationMs: number;
}

export function shouldRefreshRanks(
  store: IndexStore,
  opts: { files?: readonly string[] | undefined; force?: boolean | undefined },
): boolean {
  if (opts.force) return true;
  // A full-project run always republishes ranks alongside the generation.
  if (!opts.files) return true;
  if (store.getMetadata(RANK_VERSION_KEY) !== RANK_VERSION) return true;
  if (store.getRankCounts().symbols === 0) return true;
  return opts.files.length >= RANK_REFRESH_FILE_THRESHOLD;
}

/**
 * Recompute and persist both rank tables. Never throws: a failed rank pass
 * leaves the previous (or empty) ranks in place and must not take the index
 * run down with it — every consumer treats a missing rank as "unranked".
 */
export function runGraphRankPass(store: IndexStore, errors: string[]): RankPassResult {
  const startMs = Date.now();
  try {
    const refs = store.getAllResolvedRefs();
    const fileOf = new Map<number, string>();
    for (const symbol of store.getAllSymbols()) fileOf.set(symbol.id, symbol.file);

    // Both weights exist to contain the same defect: ref resolution matches on
    // name alone, so an unguarded walk ranks the Italian locale catalogue above
    // the container. See the module header.
    const graph = buildWiringGraph(refs, {
      candidates: store.getSymbolNameCandidates(),
      fileOf,
      importsOf: store.getImportVisibility(),
    });
    const scores = pageRank(graph);
    const symbolRows = toSymbolRankRows(graph, scores);
    const fileRows = aggregateFileRank(symbolRows, fileOf);

    store.replaceRanks(symbolRows, fileRows);
    store.setMetadata(RANK_VERSION_KEY, RANK_VERSION);
    return {
      computed: true,
      symbols: symbolRows.length,
      files: fileRows.length,
      durationMs: Date.now() - startMs,
    };
  } catch (error) {
    errors.push(`graph rank: ${error instanceof Error ? error.message : String(error)}`);
    return { computed: false, symbols: 0, files: 0, durationMs: Date.now() - startMs };
  }
}
