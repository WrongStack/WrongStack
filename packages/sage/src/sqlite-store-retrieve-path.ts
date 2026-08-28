import type { DatabaseSync } from 'node:sqlite';

import { sqliteRowToMemory } from './sqlite-store-codec.js';
import { MEMORY_NODE_GLOB, MEMORY_NODE_PREFIX_LEN } from './sqlite-store-graph-helpers.js';
import {
  buildRetrieveFallbackQuery,
  buildRetrievePathTargets,
} from './sqlite-store-retrieve-helpers.js';
import { buildSessionClause as buildSharedSessionClause } from './sqlite-store-search-helpers.js';
import { sqliteRowsToMemories } from './sqlite-store-search-helpers.js';
import type { Sage, SageForPathOptions } from './types.js';

interface SqliteRetrieveForPathContext {
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
  return buildSharedSessionClause({
    sessionId: opts?.sessionId,
    includeAllSessions: opts?.includeAllSessions,
  });
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
      // The SUBSTR strips a fixed `mem:` prefix, so the subquery must only see
      // memory-origin edges. Every writer today emits `mem:` on from_node
      // (anchor sync, hygiene supersedes, admin link, JSONL replay), but the
      // edges table also stores file:/dir:/symbol: nodes and nothing in the
      // schema enforces the side they land on — without this guard a future
      // non-memory from_node would be silently mis-sliced into a garbage id.
      // GLOB (not LIKE) so the comparison stays case-sensitive and index-usable.
      `SELECT DISTINCT m.data
       FROM memories m
       WHERE m.id IN (
           SELECT SUBSTR(e.from_node, ${MEMORY_NODE_PREFIX_LEN + 1})
           FROM edges e
           WHERE e.from_node GLOB '${MEMORY_NODE_GLOB}'
             AND (
               e.to_node IN (${targetPlaceholders})
               ${globClause}
             )
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
