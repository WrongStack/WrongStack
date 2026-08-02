import type { DatabaseSync } from 'node:sqlite';

import { escapeLikePattern } from './sqlite-store-pagination.js';
import { ftsPrefixTerms, sqliteRowsToMemories } from './sqlite-store-search-helpers.js';
import type { Sage, SageSearchOptions } from './types.js';

export interface SqliteSearchSageContext {
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>;
}

/**
 * Build the SQL clause + params that enforce session isolation.
 *
 * Returns `{ clause: '', params: [] }` (no-op) when `includeAllSessions` is
 * true — administrative surfaces opt into cross-session visibility.
 *
 * When `sessionId` is provided:
 *   `(scope != 'session' OR owner_session_id = ?)`
 * Non-session scopes pass; session-scoped memories must match the caller.
 *
 * When neither is set (unscoped call):
 *   `(scope != 'session' OR owner_session_id IS NULL)`
 * Unowned session memories remain visible for backward compatibility; owned
 * session memories are hidden from callers that did not identify themselves.
 *
 * @param prefix - SQL table alias prefix for FTS join queries (e.g. `'m.'`);
 *   omit for non-aliased queries. Parameterized instead of string-replaced
 *   so both variants come from one function and cannot diverge.
 */
function buildSessionClause(
  opts?: SageSearchOptions,
  prefix = '',
): {
  clause: string;
  params: string[];
} {
  const scopeCol = `${prefix}scope`;
  const ownerCol = `${prefix}owner_session_id`;
  if (opts?.includeAllSessions) return { clause: '', params: [] };
  if (opts?.sessionId) {
    return {
      clause: ` AND (${scopeCol} != 'session' OR ${ownerCol} = ?)`,
      params: [opts.sessionId],
    };
  }
  return {
    clause: ` AND (${scopeCol} != 'session' OR ${ownerCol} IS NULL)`,
    params: [],
  };
}

export function searchSqliteSage(
  ctx: SqliteSearchSageContext,
  query: string,
  opts?: SageSearchOptions,
): Sage[] {
  const limit = opts?.limit ?? 20;
  const automaticContext = opts?.includeStatuses === undefined;
  const statusFilter = opts?.includeStatuses ?? ['active'];
  if (statusFilter.length === 0) return [];
  const scopeFilter = opts?.scope;
  const scopeClause = scopeFilter ? ' AND scope = ?' : '';
  const ftsScopeClause = scopeFilter ? ' AND m.scope = ?' : '';
  const scopeParams = scopeFilter ? [scopeFilter] : [];
  const includeAudienceScoped = opts?.includeAudienceScoped !== false;
  // SQL-level audience filter: when includeAudienceScoped is false, exclude
  // audience-scoped rows BEFORE LIMIT so a general memory at position N+1
  // is not hidden behind N audience-scoped rows that the JS filter would
  // strip anyway. The JS filter remains as a secondary safety net.
  const audienceSqlClause = includeAudienceScoped ? '' : ' AND audience IS NULL';
  const ftsAudienceClause = includeAudienceScoped ? '' : ' AND m.audience IS NULL';
  const audienceFilter = (memory: Sage): boolean => includeAudienceScoped || !memory.audience;
  const neverInjectClause = automaticContext
    ? ` AND CASE
            WHEN json_valid(data)
            THEN COALESCE(json_extract(data, '$.contextPolicy') != 'never', 1)
            ELSE 1
          END`
    : '';
  const session = buildSessionClause(opts);
  const ftsSession = buildSessionClause(opts, 'm.');

  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    const placeholders = statusFilter.map(() => '?').join(',');
    const rows = ctx
      .stmt(
        `SELECT data FROM memories
           WHERE status IN (${placeholders})${scopeClause}${session.clause}${audienceSqlClause}${neverInjectClause}
           ORDER BY importance DESC, updated_at DESC
           LIMIT ?`,
      )
      .all(...statusFilter, ...scopeParams, ...session.params, limit) as Array<{
      data: string;
    }>;
    return sqliteRowsToMemories(rows).filter(audienceFilter);
  }

  try {
    const placeholders = statusFilter.map(() => '?').join(',');
    const terms = ftsPrefixTerms(query);
    if (terms.length === 0) throw new Error('FTS_SKIP');
    const runFts = (ftsQuery: string): Array<{ data: string }> =>
      ctx
        .stmt(
          `SELECT m.data FROM memories m
             JOIN memories_fts f ON m.rowid = f.rowid
             WHERE m.status IN (${placeholders})${ftsScopeClause}${ftsSession.clause}${ftsAudienceClause}${neverInjectClause}
             AND memories_fts MATCH ?
             ORDER BY bm25(memories_fts) ASC, m.importance DESC
             LIMIT ?`,
        )
        .all(...statusFilter, ...scopeParams, ...ftsSession.params, ftsQuery, limit) as Array<{
        data: string;
      }>;
    let rows = runFts(terms.join(' '));
    if (rows.length === 0 && terms.length > 1 && !opts?.requireAllTerms) {
      rows = runFts(terms.join(' OR '));
    }
    return sqliteRowsToMemories(rows).filter(audienceFilter);
  } catch {
    // FTS5 unavailable; use LIKE fallback below.
  }

  const likePattern = `%${escapeLikePattern(query.toLowerCase())}%`;
  const placeholders = statusFilter.map(() => '?').join(',');
  const rows = ctx
    .stmt(
      `SELECT data FROM memories
         WHERE status IN (${placeholders})${scopeClause}${session.clause}${audienceSqlClause}${neverInjectClause}
         AND LOWER(json_extract(data, '$.text')) LIKE ? ESCAPE '\\'
         ORDER BY importance DESC
         LIMIT ?`,
    )
    .all(...statusFilter, ...scopeParams, ...session.params, likePattern, limit) as Array<{
    data: string;
  }>;
  return sqliteRowsToMemories(rows).filter(audienceFilter);
}
