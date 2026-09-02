import type { DatabaseSync } from 'node:sqlite';

import { normalizeSlashes } from './paths.js';
import { sqliteAnchorNode } from './sqlite-store-anchors.js';
import {
  MEMORY_NODE_GLOB,
  MEMORY_NODE_PREFIX,
  memoryNodeId,
} from './sqlite-store-graph-helpers.js';
import { buildSessionClause, type SessionScopeFilter } from './sqlite-store-search-helpers.js';
import { sqliteCommandFamily, sqliteNormalizeCommand } from './sqlite-store-schema.js';
import type { Sage, SageStatus } from './types.js';

interface SqliteRelatedCandidateContext {
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>;
}

/** Families per statement, so a seed set with many command anchors cannot build an unbounded OR chain. */
const FAMILY_CHUNK = 64;

/**
 * Matches any node containing a character outside printable ASCII.
 *
 * The command-family prefilter below leans on `LIKE` being ASCII
 * case-insensitive, which makes it a superset of the JS predicate — but only
 * for pure-ASCII nodes. Command nodes are stored with their original case and
 * without NFKC folding (`sqliteAnchorNode`), while the family comparison folds
 * both, so a node carrying compatibility characters could match in JS and not
 * in SQL. Admitting every non-ASCII node keeps the prefilter a strict superset
 * instead of silently narrowing recall; printable ASCII is NFKC-stable, so
 * nothing else can diverge.
 */
const NON_ASCII_NODE_CLAUSE = "to_node GLOB '*[^ -~]*'";

/** Escape `%`, `_` and the escape character itself for a LIKE prefix pattern. */
function escapeLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export function collectRelatedSqliteCandidateIds(
  ctx: SqliteRelatedCandidateContext,
  seeds: readonly Sage[],
  graphRelatedIds: ReadonlySet<string>,
  statuses: readonly SageStatus[],
  /**
   * Optional session ownership filter. Applied to the tag-similarity query
   * (the only candidate source that reads `memories` directly) so candidate
   * ids stay session-clean; `findRelatedSqliteSage` additionally backstops
   * the final fetch with the same clause.
   */
  session?: SessionScopeFilter | undefined,
  /**
   * Cap on ids drawn from a single tag. Tag co-occurrence is the weakest
   * relatedness signal `scoreMemoryRelationship` knows (1.5 per shared tag,
   * capped at 4) yet it is the only unbounded candidate source: this
   * repository's live store has one tag on 972 of 2,684 active memories, and
   * every one of them was materialized and JSON-parsed before the caller's
   * `limit` of 20 was applied — ~45ms per call on the per-tool-call retrieval
   * path.
   *
   * Ordering by importance before the cut keeps the cap aligned with the final
   * ranking: candidates matched on tags alone are separated by importance, so
   * the ids dropped here are exactly the ones that would have sorted last. A
   * co-tagged memory that also shares an anchor is collected by the anchor
   * source, and one reachable only through the graph arrives via the
   * (unconditional) traversal, so neither depends on this source.
   *
   * Omitted means unbounded, preserving the previous behaviour for callers
   * that have not opted in.
   */
  tagCandidateLimit?: number | undefined,
): string[] {
  const ids = new Set<string>(graphRelatedIds);
  const statusPlaceholders = statuses.map(() => '?').join(',');

  const targets = new Set<string>();
  const seedNodeIds = seeds.map((s) => memoryNodeId(s.id));
  const ph = seedNodeIds.map(() => '?').join(',');
  const edgeTargets = ctx
    .stmt(
      `SELECT DISTINCT to_node AS n FROM edges
       WHERE from_node IN (${ph}) AND relation GLOB 'about_*'`,
    )
    .all(...seedNodeIds) as Array<{ n: string }>;
  for (const row of edgeTargets) targets.add(row.n);
  for (const seed of seeds) {
    for (const anchor of seed.anchors) {
      const node = sqliteAnchorNode(anchor);
      if (node) targets.add(node);
      if (anchor.path) {
        const normalized = normalizeSlashes(anchor.path);
        const parts = normalized.split('/').filter(Boolean);
        for (let i = 1; i < parts.length; i++) {
          const ancestor = parts.slice(0, i).join('/');
          targets.add(`file:${ancestor}`);
          targets.add(`dir:${ancestor}`);
        }
      }
    }
  }
  if (targets.size > 0) {
    const targetList = [...targets];
    const CHUNK = 400;
    for (let i = 0; i < targetList.length; i += CHUNK) {
      const chunk = targetList.slice(i, i + CHUNK);
      const chunkPlaceholders = chunk.map(() => '?').join(',');
      const froms = ctx
        .stmt(
          `SELECT DISTINCT from_node AS n FROM edges
           WHERE to_node IN (${chunkPlaceholders})
             AND from_node GLOB ?
             AND relation GLOB 'about_*'`,
        )
        .all(...chunk, MEMORY_NODE_GLOB) as Array<{ n: string }>;
      for (const row of froms) {
        ids.add(row.n.slice(MEMORY_NODE_PREFIX.length));
      }
    }
  }

  const tags = new Set(seeds.flatMap((s) => s.tags));
  const tagSession = buildSessionClause(session, 'm.');
  // `EXISTS (json_each …)` rather than a DISTINCT join: it yields one row per
  // memory, which lets the statement carry its own ORDER BY / LIMIT (a
  // DISTINCT join cannot order by a column outside its result set) and drops
  // the de-duplication pass. Verified on the live store to return the same 972
  // ids as the join when uncapped.
  const tagLimit =
    tagCandidateLimit !== undefined && Number.isFinite(tagCandidateLimit)
      ? Math.max(1, Math.floor(tagCandidateLimit))
      : undefined;
  for (const tag of tags) {
    const rows = ctx
      .stmt(
        `SELECT m.id FROM memories m
         WHERE m.status IN (${statusPlaceholders})
           AND json_valid(m.tags)
           AND EXISTS (SELECT 1 FROM json_each(m.tags) je WHERE je.value = ?)
           ${tagSession.clause}
         ORDER BY m.importance DESC, m.updated_at DESC${tagLimit === undefined ? '' : ' LIMIT ?'}`,
      )
      .all(
        ...statuses,
        tag,
        ...tagSession.params,
        ...(tagLimit === undefined ? [] : [tagLimit]),
      ) as Array<{ id: string }>;
    for (const row of rows) ids.add(row.id);
  }

  const families = new Set<string>();
  for (const seed of seeds) {
    for (const anchor of seed.anchors) {
      if (anchor.command) {
        families.add(sqliteCommandFamily(sqliteNormalizeCommand(anchor.command)));
      }
    }
  }
  if (families.size > 0) {
    const familyList = [...families];
    for (let i = 0; i < familyList.length; i += FAMILY_CHUNK) {
      const chunk = familyList.slice(i, i + FAMILY_CHUNK);
      const clauses = chunk.map(() => `to_node LIKE ? ESCAPE '\\'`);
      const cmdEdges = ctx
        .stmt(
          `SELECT DISTINCT from_node AS n, to_node AS t FROM edges
           WHERE relation = 'about_command' AND from_node GLOB ?
             AND (${clauses.join(' OR ')} OR ${NON_ASCII_NODE_CLAUSE})`,
        )
        .all(
          MEMORY_NODE_GLOB,
          ...chunk.map((family) => `command:${escapeLikeLiteral(family)}%`),
        ) as Array<{ n: string; t: string }>;
      for (const edge of cmdEdges) {
        const cmd = edge.t.startsWith('command:') ? edge.t.slice('command:'.length) : '';
        // The SQL clause is a prefilter, not the decision: `LIKE 'pnpm run%'`
        // also admits `pnpm running-x`, whose family is different. The exact
        // family comparison below stays the authority, exactly as before.
        if (cmd && families.has(sqliteCommandFamily(sqliteNormalizeCommand(cmd)))) {
          ids.add(edge.n.slice(MEMORY_NODE_PREFIX.length));
        }
      }
    }
  }

  for (const seed of seeds) ids.delete(seed.id);
  return [...ids];
}
