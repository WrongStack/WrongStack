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

/**
 * Build the SQL clause + params that enforce session isolation for path
 * retrieval. Mirrors the logic in `buildSessionClause` from
 * `sqlite-store-search-sage.ts` but operates on `SageForPathOptions`.
 */
function buildPathSessionClause(opts?: SageForPathOptions): {
  clause: string;
  params: string[];
} {
  if (opts?.includeAllSessions) return { clause: '', params: [] };
  if (opts?.sessionId) {
    return {
      clause: " AND (scope != 'session' OR owner_session_id = ?)",
      params: [opts.sessionId],
    };
  }
  return {
    clause: " AND (scope != 'session' OR owner_session_id IS NULL)",
    params: [],
  };
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
  // SQL-level audience filter: exclude audience-scoped rows BEFORE LIMIT
  // so a general memory at position N+1 is not hidden behind N audience-
  // scoped rows. The JS filter remains as a secondary safety net.
  const audienceEdgeClause = includeAudienceScoped ? '' : ' AND m.audience IS NULL';
  const audienceFallbackClause = includeAudienceScoped ? '' : ' AND audience IS NULL';
  const audienceFilter = (memory: Sage): boolean => includeAudienceScoped || !memory.audience;
  const session = buildPathSessionClause(opts);
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
       ${session.clause}
       ${audienceEdgeClause}
       ORDER BY m.importance DESC, m.updated_at DESC
       LIMIT ?`,
    )
    .all(...targetList, ...symbolGlobs, ...session.params, limit) as Array<{ data: string }>;

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
       ${session.clause}
       ${audienceFallbackClause}
       ORDER BY importance DESC, updated_at DESC
       LIMIT ?`,
    )
    .all(...params, ...session.params, limit) as Array<{ data: string }>;
  return sqliteRowsToMemories(rows).filter(audienceFilter);
}
