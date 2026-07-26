import type { DatabaseSync } from 'node:sqlite';

import { sqliteRowToMemory } from './sqlite-store-codec.js';
import { MEMORY_NODE_PREFIX_LEN } from './sqlite-store-graph-helpers.js';
import {
  buildRetrieveFallbackQuery,
  buildRetrievePathTargets,
} from './sqlite-store-retrieve-helpers.js';
import { sqliteRowsToMemories } from './sqlite-store-search-helpers.js';
import type { Sage, SageForPathOptions } from './types.js';

export interface SqliteRetrieveForPathContext {
  projectRoot: string;
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>;
}

export function retrieveSqliteSageForPath(
  ctx: SqliteRetrieveForPathContext,
  paths: string[],
  opts?: SageForPathOptions,
): Sage[] {
  const limit = opts?.limit ?? 20;
  const includeAncestors = opts?.includeAncestors ?? true;
  if (paths.length === 0) return [];

  const { relPaths, targetList, symbolGlobs } = buildRetrievePathTargets(
    ctx.projectRoot,
    paths,
    includeAncestors,
  );
  if (relPaths.length === 0) return [];

  const includeAudienceScoped = opts?.includeAudienceScoped !== false;
  const audienceFilter = (memory: Sage): boolean => includeAudienceScoped || !memory.audience;
  const targetPlaceholders = targetList.map(() => '?').join(',');
  const globClause = `OR ${symbolGlobs.map(() => 'e.to_node GLOB ?').join(' OR ')}`;
  const edgeRows = ctx
    .stmt(
      `SELECT DISTINCT m.data
       FROM memories m
       WHERE m.id IN (
           SELECT SUBSTR(e.from_node, ${MEMORY_NODE_PREFIX_LEN + 1})
           FROM edges e
           WHERE e.to_node IN (${targetPlaceholders})
             ${globClause}
       )
       AND m.status IN ('active', 'stale')
       ORDER BY m.importance DESC, m.updated_at DESC
       LIMIT ?`,
    )
    .all(...targetList, ...symbolGlobs, limit) as Array<{ data: string }>;

  if (edgeRows.length > 0) {
    return edgeRows.map((r) => sqliteRowToMemory(r)).filter(audienceFilter);
  }

  const fallback = buildRetrieveFallbackQuery(relPaths, includeAncestors);
  const params: (string | number)[] = ['active', 'stale', ...fallback.params];
  const rows = ctx
    .stmt(
      `SELECT data FROM memories
       WHERE status IN (?, ?)
       AND (${fallback.conditions.join(' OR ')})
       ORDER BY importance DESC, updated_at DESC
       LIMIT ?`,
    )
    .all(...params, limit) as Array<{ data: string }>;
  return sqliteRowsToMemories(rows).filter(audienceFilter);
}
