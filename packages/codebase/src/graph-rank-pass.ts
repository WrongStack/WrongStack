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

import * as path from 'node:path';
import {
  aggregateFileRank,
  buildWiringGraph,
  pageRank,
  toSymbolRankRows,
  type WiringGraph,
} from './graph-rank.js';
import { detectLang, languageFamily } from './languages.js';
import type { IndexStore } from './writer.js';

/**
 * Families whose files see every declaration of their own directory without
 * an import: a Go package, a Java/Kotlin package, a C# namespace folder, a
 * Swift module.
 */
const DIRECTORY_SCOPED_FAMILIES: ReadonlySet<string> = new Set(['go', 'jvm', 'dotnet', 'swift']);

/** Families whose import names a directory, resolved to one representative file. */
const DIRECTORY_IMPORT_FAMILIES: ReadonlySet<string> = new Set(['go', 'jvm']);

function familyOf(file: string): string | undefined {
  const lang = detectLang(file);
  return lang ? languageFamily(lang) : undefined;
}

/**
 * Build the `implicitlyVisible` predicate for one rank pass.
 *
 * Without it every same-package Go/Java/C# reference — code that needs no
 * import by the language's own rules — was scored as a contradicted
 * misresolution (weight 0.02), as was every call into a Go package other than
 * the one file the resolver picked to represent it. Centrality for those
 * languages was computed on a graph with its package-internal wiring erased.
 */
export function createImplicitVisibility(): (
  sourceFile: string,
  targetFile: string,
  imports: ReadonlySet<string> | undefined,
) => boolean {
  const importedDirs = new WeakMap<ReadonlySet<string>, Set<string>>();
  // Called once per cross-file edge (~180k here) over a few thousand distinct
  // files: language detection and dirname are memoised per file, which took
  // the graph build from ~750 ms to a fraction of it.
  const families = new Map<string, string | undefined>();
  const dirs = new Map<string, string>();
  const family = (file: string): string | undefined => {
    if (families.has(file)) return families.get(file);
    const value = familyOf(file);
    families.set(file, value);
    return value;
  };
  const dirOf = (file: string): string => {
    let dir = dirs.get(file);
    if (dir === undefined) {
      dir = path.dirname(file);
      dirs.set(file, dir);
    }
    return dir;
  };
  return (sourceFile, targetFile, imports) => {
    const targetFamily = family(targetFile);
    if (targetFamily === undefined) return false;
    const targetDir = dirOf(targetFile);
    if (
      DIRECTORY_SCOPED_FAMILIES.has(targetFamily) &&
      dirOf(sourceFile) === targetDir &&
      family(sourceFile) === targetFamily
    ) {
      return true;
    }
    if (imports === undefined || !DIRECTORY_IMPORT_FAMILIES.has(targetFamily)) return false;
    let imported = importedDirs.get(imports);
    if (imported === undefined) {
      imported = new Set([...imports].map((file) => dirOf(file)));
      importedDirs.set(imports, imported);
    }
    return imported.has(targetDir);
  };
}

/**
 * Load everything the wiring graph is built from and build it — the one path
 * shared by the index-time rank pass and the query-time retrieval cache, so
 * the two can never weigh the same edge differently.
 */
export function loadWiringGraph(store: IndexStore): {
  graph: WiringGraph;
  fileOf: Map<number, string>;
} {
  const { fileOf, candidates, shadowedModules } = store.getSymbolGraphFacts();
  // Both weights exist to contain the same defect: ref resolution matches on
  // name alone, so an unguarded walk ranks the Italian locale catalogue above
  // the container. See the module header.
  const refs = store.getAllResolvedRefs();
  const graph = buildWiringGraph(
    shadowedModules.size > 0 ? refs.filter((ref) => !shadowedModules.has(ref.fromId)) : refs,
    {
      candidates,
      fileOf,
      importsOf: store.getImportVisibility(),
      implicitlyVisible: createImplicitVisibility(),
    },
  );
  return { graph, fileOf };
}

/**
 * Data-version marker for the rank layer, in the same spirit as
 * `relation_graph_version`: bumping it forces every index to recompute ranks
 * once without a `SCHEMA_VERSION` bump (which would drop and rebuild the
 * entire database). Older processes sharing the DB cannot downgrade it.
 */
export const RANK_VERSION = '1';
export const RANK_VERSION_KEY = 'rank_version';

/**
 * Recompute once this many files have changed since the last rank pass. One
 * edited file barely moves any score, so leaving ranks a few edits stale is
 * the cheaper trade — but the drift is counted across runs
 * ({@link RANK_STALE_FILES_KEY}), so a long editing session converges instead
 * of serving ranks that describe the morning's graph until the next restart.
 */
export const RANK_REFRESH_FILE_THRESHOLD = 25;
/** Files changed since ranks were last computed, accumulated across runs. */
export const RANK_STALE_FILES_KEY = 'rank_stale_files';

export interface RankPassResult {
  /** False when the pass decided the existing ranks were good enough. */
  computed: boolean;
  symbols: number;
  files: number;
  durationMs: number;
}

/**
 * Decide whether this run recomputes ranks, and record the drift when it
 * does not. `changedFiles` counts rows rewritten, added or removed — a full
 * scan over an unchanged checkout used to recompute the whole graph (~2 s on
 * a 10k-file index) to arrive at the scores it already had.
 */
export function shouldRefreshRanks(
  store: IndexStore,
  opts: { changedFiles: number; force?: boolean | undefined },
): boolean {
  if (opts.force) return true;
  if (store.getMetadata(RANK_VERSION_KEY) !== RANK_VERSION) return true;
  if (opts.changedFiles <= 0) return false;
  // The version marker is only written by a completed pass, so empty tables
  // here are a legitimate answer (no resolved refs yet) — recomputed as soon
  // as anything changes, never for a run that changed nothing. Recomputing
  // them unconditionally made every no-op run on such an index report a
  // content change and publish a new generation.
  if (store.getRankCounts().symbols === 0) return true;
  const stale = (Number(store.getMetadata(RANK_STALE_FILES_KEY)) || 0) + opts.changedFiles;
  if (stale >= RANK_REFRESH_FILE_THRESHOLD) return true;
  store.setMetadata(RANK_STALE_FILES_KEY, String(stale));
  return false;
}

/**
 * Recompute and persist both rank tables. Never throws: a failed rank pass
 * leaves the previous (or empty) ranks in place and must not take the index
 * run down with it — every consumer treats a missing rank as "unranked".
 */
export function runGraphRankPass(store: IndexStore, errors: string[]): RankPassResult {
  const startMs = Date.now();
  try {
    const { graph, fileOf } = loadWiringGraph(store);
    const scores = pageRank(graph);
    const symbolRows = toSymbolRankRows(graph, scores);
    const fileRows = aggregateFileRank(symbolRows, fileOf);

    store.replaceRanks(symbolRows, fileRows);
    store.setMetadata(RANK_VERSION_KEY, RANK_VERSION);
    store.setMetadata(RANK_STALE_FILES_KEY, '0');
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
