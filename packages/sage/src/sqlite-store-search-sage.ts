import type { DatabaseSync } from 'node:sqlite';

import { escapeLikePattern } from './sqlite-store-pagination.js';
import { ftsPrefixTerms, sqliteRowsToMemories } from './sqlite-store-search-helpers.js';
import type { Sage, SageSearchOptions } from './types.js';

export interface SqliteSearchSageContext {
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>;
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
  const scopeParams = scopeFilter ? [scopeFilter] : [];
  const includeAudienceScoped = opts?.includeAudienceScoped !== false;
  const audienceFilter = (memory: Sage): boolean => includeAudienceScoped || !memory.audience;
  const neverInjectClause = automaticContext
    ? ` AND CASE
            WHEN json_valid(data)
            THEN COALESCE(json_extract(data, '$.contextPolicy') != 'never', 1)
            ELSE 1
          END`
    : '';

  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    const placeholders = statusFilter.map(() => '?').join(',');
    const rows = ctx
      .stmt(
        `SELECT data FROM memories
           WHERE status IN (${placeholders})${scopeClause}${neverInjectClause}
           ORDER BY importance DESC, updated_at DESC
           LIMIT ?`,
      )
      .all(...statusFilter, ...scopeParams, limit) as Array<{ data: string }>;
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
             WHERE m.status IN (${placeholders})${scopeFilter ? ' AND m.scope = ?' : ''}${neverInjectClause}
             AND memories_fts MATCH ?
             ORDER BY bm25(memories_fts) ASC, m.importance DESC
             LIMIT ?`,
        )
        .all(...statusFilter, ...scopeParams, ftsQuery, limit) as Array<{ data: string }>;
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
         WHERE status IN (${placeholders})${scopeClause}${neverInjectClause}
         AND LOWER(json_extract(data, '$.text')) LIKE ? ESCAPE '\\'
         ORDER BY importance DESC
         LIMIT ?`,
    )
    .all(...statusFilter, ...scopeParams, likePattern, limit) as Array<{ data: string }>;
  return sqliteRowsToMemories(rows).filter(audienceFilter);
}
