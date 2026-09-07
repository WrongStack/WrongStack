/**
 * Atlas enrichment for the CodeMap graph.
 *
 * The three graph getters build their nodes from `symbols` and `files`. Rank,
 * concept summaries and subsystem membership live in tables those queries know
 * nothing about, and each getter reaches its nodes by a different route — one
 * groups by package, one by file, one by symbol id.
 *
 * Rather than thread four more joins through three query shapes and their node
 * builders, this decorates the finished nodes in one pass. That keeps the
 * enrichment strictly additive: an index where no rank or concept pass has run
 * produces exactly the graph it produced before, because every lookup misses
 * and every field stays absent.
 *
 * It also sidesteps `chunkedIdQuery`'s documented rule that `buildSql` may not
 * contain a `LIMIT` — there is no limit to express here.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { GraphNode } from './schema.js';

type Statement = ReturnType<DatabaseSync['prepare']>;
type PrepareStatement = (sql: string) => Statement;

/** SQLite's bound-parameter ceiling, matching `writer-graph-reader.ts`. */
const MAX_SQL_VARS = 900;

/**
 * Re-normalise rank to a 0..1 scale for the scope being rendered.
 *
 * Two things make the raw score unusable as-is. A package's rank is the sum of
 * its files', so package and file nodes live on different scales. And a
 * drill-down response deliberately carries neighbours from *outside* the scope
 * so cross-scope edges have somewhere to land — on this repository, drilling
 * into `@wrongstack/tools` returns 388 local files and 1266 external ones.
 *
 * So the divisor is the highest rank among the **local** nodes, not among all
 * of them. Normalising over everything handed the 1.0 slot to a hub in another
 * package and left the package's own most-central file reading 0.67 — a view
 * of a package in which nothing in that package looks central.
 *
 * External nodes are divided by the same number and clamped: one that outranks
 * the scope's own hub sits at the top of the scale, which is all this view has
 * to say about it. Its absolute standing belongs to the level above.
 */
function normaliseInPlace(nodes: GraphNode[]): void {
  let localMax = 0;
  let anyMax = 0;
  for (const node of nodes) {
    const rank = node.rank;
    if (rank === undefined) continue;
    if (rank > anyMax) anyMax = rank;
    if (node.external !== true && rank > localMax) localMax = rank;
  }
  // A scope with no local nodes at all (every node pulled in from outside)
  // still needs a scale, so fall back to the full set.
  const max = localMax > 0 ? localMax : anyMax;
  if (max <= 0) return;
  for (const node of nodes) {
    if (node.rank !== undefined) node.rank = Math.min(1, node.rank / max);
  }
}

type ConceptRow = {
  file: string;
  summary: string;
  crux_start: number | null;
  crux_end: number | null;
};

/**
 * Stamp rank, concept, crux, subsystem and mtime onto graph nodes.
 *
 * `packageOf` is supplied by the caller because the package labeller already
 * exists at every call site, and rebuilding it here would read `files` twice.
 */
export function decorateGraphNodes(
  stmt: PrepareStatement,
  nodes: GraphNode[],
  packageOf: (file: string) => string,
): void {
  if (nodes.length === 0) return;

  const fileRank = new Map<string, number>();
  for (const row of stmt('SELECT file, rank FROM file_rank').all() as Array<{
    file: string;
    rank: number;
  }>) {
    fileRank.set(row.file, row.rank);
  }

  const mtime = new Map<string, number>();
  for (const row of stmt('SELECT file, mtime_ms FROM files').all() as Array<{
    file: string;
    mtime_ms: number;
  }>) {
    mtime.set(row.file, row.mtime_ms);
  }

  const concepts = new Map<string, ConceptRow>();
  for (const row of stmt(
    "SELECT file, summary, crux_start, crux_end FROM file_concepts WHERE state = 'ready' AND summary != ''",
  ).all() as ConceptRow[]) {
    concepts.set(row.file, row);
  }

  const subsystems = new Map<string, { name: string; summary: string }>();
  for (const row of stmt('SELECT id, name, summary FROM subsystems').all() as Array<{
    id: string;
    name: string;
    summary: string;
  }>) {
    subsystems.set(row.id, { name: row.name, summary: row.summary });
  }

  // Symbol ranks are the one table too large to read whole (66k rows on this
  // repository against at most a few hundred nodes), so it is queried by id.
  const symbolRank = new Map<number, number>();
  const symbolIds = nodes
    .map((node) => node.symbolId)
    .filter((id): id is number => typeof id === 'number');
  for (let start = 0; start < symbolIds.length; start += MAX_SQL_VARS) {
    const chunk = symbolIds.slice(start, start + MAX_SQL_VARS);
    const placeholders = chunk.map(() => '?').join(',');
    for (const row of stmt(
      `SELECT symbol_id, rank FROM symbol_rank WHERE symbol_id IN (${placeholders})`,
    ).all(...chunk) as Array<{ symbol_id: number; rank: number }>) {
      symbolRank.set(row.symbol_id, row.rank);
    }
  }

  // A package's centrality is what its files carry, summed — the same
  // aggregation `aggregateFileRank` performs one level down.
  const packageRank = new Map<string, number>();
  if (nodes.some((node) => node.kind === 'package')) {
    for (const [file, rank] of fileRank) {
      const pkg = packageOf(file);
      packageRank.set(pkg, (packageRank.get(pkg) ?? 0) + rank);
    }
  }

  for (const node of nodes) {
    if (node.kind === 'package') {
      const pkg = node.package;
      if (pkg === undefined) continue;
      const rank = packageRank.get(pkg);
      if (rank !== undefined) node.rank = rank;
      const subsystem = subsystems.get(pkg);
      if (subsystem !== undefined) {
        node.subsystem = subsystem.name;
        if (subsystem.summary !== '') node.concept = subsystem.summary;
      }
      continue;
    }

    const file = node.file;
    if (file === undefined) continue;

    const modified = mtime.get(file);
    if (modified !== undefined) node.lastModifiedMs = modified;

    const subsystem = subsystems.get(packageOf(file));
    if (subsystem !== undefined) node.subsystem = subsystem.name;

    if (node.kind === 'file') {
      const rank = fileRank.get(file);
      if (rank !== undefined) node.rank = rank;
      // A file's concept describes the file; a symbol inside it does not
      // inherit that description, which would repeat the same sentence on
      // every node in the drill-down.
      const concept = concepts.get(file);
      if (concept !== undefined) {
        node.concept = concept.summary;
        if (concept.crux_start !== null && concept.crux_end !== null) {
          node.crux = { start: concept.crux_start, end: concept.crux_end };
        }
      }
      continue;
    }

    const symbolId = node.symbolId;
    if (symbolId !== undefined) {
      const rank = symbolRank.get(symbolId);
      if (rank !== undefined) node.rank = rank;
    }
  }

  normaliseInPlace(nodes);
}
