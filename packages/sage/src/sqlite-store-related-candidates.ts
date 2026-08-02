import type { DatabaseSync } from 'node:sqlite';

import { normalizeSlashes } from './paths.js';
import { sqliteAnchorNode } from './sqlite-store-anchors.js';
import {
  MEMORY_NODE_GLOB,
  MEMORY_NODE_PREFIX,
  memoryNodeId,
} from './sqlite-store-graph-helpers.js';
import {
  buildSessionClause,
  type SessionScopeFilter,
} from './sqlite-store-search-helpers.js';
import { sqliteCommandFamily, sqliteNormalizeCommand } from './sqlite-store-schema.js';
import type { Sage, SageStatus } from './types.js';

export interface SqliteRelatedCandidateContext {
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>;
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
  for (const tag of tags) {
    const rows = ctx
      .stmt(
        `SELECT DISTINCT m.id FROM memories m, json_each(m.tags) AS je
         WHERE m.status IN (${statusPlaceholders})
           AND json_valid(m.tags)
           AND je.value = ?${tagSession.clause}`,
      )
      .all(...statuses, tag, ...tagSession.params) as Array<{ id: string }>;
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
    const cmdEdges = ctx
      .stmt(
        `SELECT DISTINCT from_node AS n, to_node AS t FROM edges
         WHERE relation = 'about_command' AND from_node GLOB ?`,
      )
      .all(MEMORY_NODE_GLOB) as Array<{ n: string; t: string }>;
    for (const edge of cmdEdges) {
      const cmd = edge.t.startsWith('command:') ? edge.t.slice('command:'.length) : '';
      if (cmd && families.has(sqliteCommandFamily(sqliteNormalizeCommand(cmd)))) {
        ids.add(edge.n.slice(MEMORY_NODE_PREFIX.length));
      }
    }
  }

  for (const seed of seeds) ids.delete(seed.id);
  return [...ids];
}
