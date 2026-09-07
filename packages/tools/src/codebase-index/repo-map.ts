/**
 * Repository map — a token-budgeted orientation view of the codebase.
 *
 * The map is built from the index's graph centrality (`file_rank`), not from a
 * filesystem walk. Two things follow from that:
 *
 *  - **It ranks by evidence.** The previous implementation never opened the
 *    index at all: it walked the tree and scored files by whether their name
 *    matched `index|main|app|server|…` plus a directory-depth bonus, stopping
 *    after ~500 files. On a repo of 8,412 that produced a map of whichever
 *    directories the walk reached first, ranked by filename. Centrality
 *    instead answers the question the map is actually asked — what does the
 *    rest of this codebase depend on?
 *  - **It can group.** `files.package` gives every file an ecosystem-derived
 *    cluster label, so the map opens with the shape of the repo (clusters and
 *    their hubs, then global hotspots) before descending into signatures.
 *
 * When the index has no ranks — a fresh clone, the first index run, a
 * directory that was never indexed — {@link generateFallbackRepoMap} takes
 * over and the output degrades to the old heuristic rather than to nothing.
 */

import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { generateFallbackRepoMap } from './repo-map-fallback.js';
import { type RepoMapCandidate, renderSkeletonSections } from './repo-map-render.js';
import type { RepoMapOptions, RepoMapResult } from './repo-map-types.js';
import { type IndexStore, indexStorePool } from './writer.js';
import { posixIndexPath, resolveIndexDir } from './writer-helpers.js';
import type { RankedFileRow } from './writer-rank.js';

export { generateFallbackRepoMap } from './repo-map-fallback.js';
export type { RepoMapOptions, RepoMapResult } from './repo-map-types.js';

/**
 * How many ranked files to pull from the index. Far more than the budget can
 * render, so that focus files and skipped (deleted, empty, unparseable) files
 * still leave a deep enough candidate list.
 */
const RANKED_FETCH_LIMIT = 400;

/** Filename `IndexStore` uses inside the resolved index directory. */
const INDEX_DB_FILE = 'index.db';

/** Clusters shown in the header. Graft's `graft_repo_map` defaults to 16. */
const MAX_CLUSTERS = 16;

/** Hotspots shown in the header. */
const MAX_HOTSPOTS = 12;

/**
 * Share of the budget the orientation header may consume. The header is the
 * denser information per token — clusters and hubs describe the whole repo,
 * a skeleton describes one file — but signatures are what the agent navigates
 * by, so the header is capped rather than allowed to crowd them out.
 */
const HEADER_BUDGET_SHARE = 0.4;

/**
 * How many files the body aims to cover. A map's value is breadth — the most
 * central file in a real repo is frequently a large type module that would
 * otherwise consume the whole budget on its own.
 */
const TARGET_BODY_FILES = 6;

/** Floor for a single section, so a tiny budget still yields real signatures. */
const MIN_SECTION_CHARS = 300;

interface Cluster {
  label: string;
  /** True indexed-file count for the label, not the ranked slice's share. */
  fileCount: number;
  /** How many of the ranked files fell into this cluster. */
  rankedCount: number;
  /** Highest-ranked file in the cluster. */
  hub: string;
  hubRank: number;
}

/** Group ranked files by their package label, most central cluster first. */
function buildClusters(
  rows: readonly RankedFileRow[],
  relativeOf: (file: string) => string,
  packageCounts: ReadonlyMap<string, number>,
): Cluster[] {
  const byLabel = new Map<string, Cluster>();
  for (const row of rows) {
    // Unlabelled files (loose scripts, repo-root config) cluster by their top
    // directory, so they still appear somewhere sensible instead of under ''.
    const relative = relativeOf(row.file);
    const label = row.package || relative.split('/')[0] || '(root)';
    const existing = byLabel.get(label);
    if (existing === undefined) {
      byLabel.set(label, {
        label,
        fileCount: packageCounts.get(row.package) ?? 0,
        rankedCount: 1,
        hub: relative,
        hubRank: row.rank,
      });
      continue;
    }
    existing.rankedCount += 1;
    if (row.rank > existing.hubRank) {
      existing.hub = relative;
      existing.hubRank = row.rank;
    }
  }
  return [...byLabel.values()].sort(
    (a, b) => b.hubRank - a.hubRank || a.label.localeCompare(b.label),
  );
}

function renderHeader(
  clusters: readonly Cluster[],
  hotspots: readonly RankedFileRow[],
  relativeOf: (file: string) => string,
  budget: number,
): string {
  const lines: string[] = ['// Repo map — ranked by graph centrality (1.00 = most central).'];

  if (clusters.length > 0) {
    lines.push('', '// Clusters (hub = most central file):');
    for (const cluster of clusters.slice(0, MAX_CLUSTERS)) {
      const size = cluster.fileCount > 0 ? `${cluster.fileCount} files` : 'unlabelled';
      lines.push(`//   ${cluster.label}  (${size})  hub: ${cluster.hub}`);
    }
  }

  if (hotspots.length > 0) {
    lines.push('', '// Hotspots:');
    for (const row of hotspots.slice(0, MAX_HOTSPOTS)) {
      lines.push(
        `//   ${row.rank.toFixed(2)}  in=${row.inDeg} out=${row.outDeg}  ${relativeOf(row.file)}`,
      );
    }
  }

  // Trim from the end rather than truncating mid-line: a half-written cluster
  // row reads as a real path and would send the agent to a file that is not
  // there.
  while (lines.length > 1 && lines.join('\n').length + 2 > budget) lines.pop();
  return lines.join('\n');
}

/**
 * Generate a graph-ranked, token-budgeted repository map.
 *
 * Falls back to the filesystem heuristic whenever the index cannot answer —
 * no ranks yet, or the store could not be opened at all.
 */
export async function generateRepoMap(opts: RepoMapOptions): Promise<RepoMapResult> {
  const projectRoot = opts.projectRoot;
  const charBudget = (opts.maxTokens ?? 1200) * 4;

  let ranked: RankedFileRow[] = [];
  let packageCounts: ReadonlyMap<string, number> = new Map();
  let totalRankedFiles = 0;
  let store: IndexStore | undefined;
  try {
    // Opening a store CREATES the database. Generating a map must never be the
    // thing that indexes a project, so an absent index goes straight to the
    // filesystem fallback instead of leaving an empty db behind.
    if (!existsSync(path.join(resolveIndexDir(projectRoot, opts.indexDir), INDEX_DB_FILE))) {
      return generateFallbackRepoMap(opts);
    }
    store = indexStorePool.acquire(projectRoot, { indexDir: opts.indexDir });
    totalRankedFiles = store.getRankCounts().files;
    if (totalRankedFiles > 0) {
      ranked = store.getRankedFiles(RANKED_FETCH_LIMIT);
      packageCounts = store.getPackageFileCounts();
    }
  } catch {
    // An unopenable or mid-migration index is not an error here; the
    // filesystem fallback below still produces a usable map.
    ranked = [];
  } finally {
    if (store !== undefined) indexStorePool.release(store);
  }

  if (ranked.length === 0) return generateFallbackRepoMap(opts);

  const relativeOf = (file: string): string => {
    const relative = path.relative(projectRoot, file);
    // A file outside the project root (a stale absolute path from another
    // machine) keeps its stored form rather than becoming a ../.. chain.
    if (!relative || relative.startsWith('..')) return posixIndexPath(file);
    return posixIndexPath(relative);
  };

  const clusters = buildClusters(ranked, relativeOf, packageCounts);
  const header = renderHeader(clusters, ranked, relativeOf, charBudget * HEADER_BUDGET_SHARE);

  // Focus files lead, in the order the caller listed them, then everything
  // else by centrality. Resolving both sides to absolute paths keeps the
  // comparison honest across the index's absolute and the caller's relative
  // spellings.
  const focus = (opts.focusFiles ?? []).map((f) => path.resolve(projectRoot, f));
  const focusIndex = new Map(focus.map((file, i) => [file, i]));
  const candidates: RepoMapCandidate[] = ranked
    .map((row) => ({
      row,
      absolute: path.resolve(projectRoot, row.file),
    }))
    .sort((a, b) => {
      const fa = focusIndex.get(a.absolute) ?? Number.POSITIVE_INFINITY;
      const fb = focusIndex.get(b.absolute) ?? Number.POSITIVE_INFINITY;
      if (fa !== fb) return fa - fb;
      return b.row.rank - a.row.rank;
    })
    .map(({ row, absolute }) => ({ absolute, relative: relativeOf(row.file) }));

  // A focus file the index has never seen would otherwise be silently dropped.
  const known = new Set(candidates.map((c) => c.absolute));
  const missingFocus: RepoMapCandidate[] = focus
    .filter((file) => !known.has(file))
    .map((file) => ({ absolute: file, relative: relativeOf(file) }));

  const bodyBudget = Math.max(0, charBudget - header.length - 2);
  const { sections, files } = await renderSkeletonSections(
    [...missingFocus, ...candidates],
    bodyBudget,
    {
      skeleton: opts.options,
      maxSectionChars: Math.max(MIN_SECTION_CHARS, bodyBudget / TARGET_BODY_FILES),
      signaturesOnly: true,
    },
  );

  const map = [header, ...sections].join('\n\n');
  return {
    map,
    filesCount: files.length,
    totalFilesScanned: totalRankedFiles,
    estimatedTokens: Math.ceil(map.length / 4),
    rankedFiles: files,
  };
}
