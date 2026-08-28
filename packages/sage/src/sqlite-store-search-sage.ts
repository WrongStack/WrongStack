import type { DatabaseSync } from 'node:sqlite';

import { hybridRerankMemories } from './retrieval/hybrid-rerank.js';
import { sqliteRowToMemory } from './sqlite-store-codec.js';
import { escapeLikePattern } from './sqlite-store-pagination.js';
import {
  buildSessionClause as buildSharedSessionClause,
  ftsPrefixTerms,
  sqliteRowsToMemories,
} from './sqlite-store-search-helpers.js';
import type { Sage, SageSearchOptions } from './types.js';

interface SqliteSearchSageContext {
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
  return buildSharedSessionClause(
    { sessionId: opts?.sessionId, includeAllSessions: opts?.includeAllSessions },
    prefix,
  );
}

function maybeRerank(query: string, memories: Sage[], opts?: SageSearchOptions): Sage[] {
  if (opts?.semanticRerank === false) return memories;
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || memories.length <= 1) return memories;
  return hybridRerankMemories(query, memories, 0.25);
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
    return maybeRerank(query, sqliteRowsToMemories(rows).filter(audienceFilter), opts);
  } catch (err) {
    // Fall back to LIKE only for FTS-unavailable errors, not for
    // corruption or SQL defects. The known FTS-unavailable patterns are:
    // - "no such table: memories_fts" (FTS5 not compiled / table missing)
    // - "no such function: bm25" (FTS5 extension missing)
    // - "FTS_SKIP" (no queryable terms — internal signal)
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg === 'FTS_SKIP' ||
      msg.includes('no such table') ||
      msg.includes('no such function') ||
      msg.includes('memories_fts')
    ) {
      // FTS5 unavailable or no terms; fall through to LIKE fallback below.
    } else {
      // Re-surface unexpected errors (corruption, SQL defects) instead
      // of silently falling back to LIKE and hiding the real problem.
      throw err;
    }
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
  return maybeRerank(query, sqliteRowsToMemories(rows).filter(audienceFilter), opts);
}

interface MaterializeSageContext {
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>;
}

/**
 * Build the vector-only materializer for `augmentLexicalWithVectorRecall`.
 *
 * Resolves a SAGE memory by id for the vector channel's semantic-only hits —
 * the recall path the lexical (FTS/BM25) channel missed. Every visibility
 * rule of `searchSqliteSage` is mirrored exactly, so a vector-only hit can
 * never admit a memory the lexical channel would have been forbidden to
 * return:
 *  - status filter: `includeStatuses ?? ['active']`
 *  - audience: excluded when `includeAudienceScoped === false` (SQL level,
 *    same `audience IS NULL` clause)
 *  - contextPolicy `never`: excluded for automatic-context calls (same JSON
 *    clause — the lexical channel applies it, so the materializer must too)
 *  - session ownership: same `buildSessionClause`, same precedence
 *    (`includeAllSessions` wins, then `sessionId`, then unowned-only)
 *  - scope filter, when the caller pinned one
 *
 * Returns `undefined` for unknown ids, ids filtered out of visibility, and
 * corrupt rows (decode failures are swallowed like search's row decoding) —
 * the fusion treats all of these as a plain drop.
 *
 * Deliberately NOT mirrored: `searchSqliteSage`'s FTS-unavailable LIKE
 * fallback. That fallback only changes how the lexical CHANNEL dispatches
 * its text match; this materializer resolves by primary key (`id = ?`), so
 * FTS availability cannot affect it and mirroring the dispatch would be
 * meaningless. Every VISIBILITY rule above is mirrored; the recall-path
 * dispatch difference is intentional.
 *
 * Kept beside `searchSqliteSage` (same module, same clause vocabulary) so the
 * two visibility implementations cannot drift apart unnoticed.
 */
export function materializeSageByIdFactory(
  ctx: MaterializeSageContext,
  opts?: SageSearchOptions,
): (sageId: string) => Sage | undefined {
  const statusFilter = opts?.includeStatuses ?? ['active'];
  const placeholders = statusFilter.map(() => '?').join(',');
  const scopeFilter = opts?.scope;
  const scopeClause = scopeFilter ? ' AND scope = ?' : '';
  const scopeParams = scopeFilter ? [scopeFilter] : [];
  const includeAudienceScoped = opts?.includeAudienceScoped !== false;
  const audienceSqlClause = includeAudienceScoped ? '' : ' AND audience IS NULL';
  const session = buildSessionClause(opts);
  // `includeStatuses === undefined` means "automatic context" in
  // searchSqliteSage — the same call shape that excludes contextPolicy
  // 'never' rows there must exclude them here.
  const neverInjectClause =
    opts?.includeStatuses === undefined
      ? ` AND CASE
            WHEN json_valid(data)
            THEN COALESCE(json_extract(data, '$.contextPolicy') != 'never', 1)
            ELSE 1
          END`
      : '';
  const sql = `SELECT data FROM memories
         WHERE id = ? AND status IN (${placeholders})${scopeClause}${session.clause}${audienceSqlClause}${neverInjectClause}
         LIMIT 1`;
  const params = [...scopeParams, ...session.params];

  return (sageId: string): Sage | undefined => {
    const row = ctx.stmt(sql).get(sageId, ...statusFilter, ...params) as
      | { data: string }
      | undefined;
    if (!row) return undefined;
    try {
      return sqliteRowToMemory(row);
    } catch {
      // Corrupt row: same advisory contract as sqliteRowsToMemories —
      // the hit is dropped rather than crashing the fusion.
      return undefined;
    }
  };
}
