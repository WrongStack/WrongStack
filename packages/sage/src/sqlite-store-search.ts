/**
 * MVP implementation of `unifiedSearchService` for the SAGE IPC op `unifiedSearch`.
 *
 * Wired 2026-07-28 (commit 1.5). See `packages/sage/docs/search-and-suggest.md`
 * for the design contract.
 *
 * MVP scope: text prefix-match (FTS5), kinds/scopes/status/importance
 * filters, hybrid ranking (bm25 ASC, importance DESC, updated_at DESC),
 * deterministic count via separate COUNT(*) query. No suggestions yet
 * (returns empty array; spec says lexical-adjacency top-N is the v1
 * suggestion method, deferred). No anchor / audience / freshness /
 * cursor / paths filters.
 *
 * Single-owner-of-state invariant preserved — this is read-only and
 * composes against FTS5 + the existing memories join. No new writer
 * logic. SQLite single-writer remains governed by `SqliteSageStore`'s
 * existing write methods.
 */
import type { SQLInputValue } from 'node:sqlite';
import type { SearchQuery, SearchResult, SearchHit, SearchMatchReason } from './service-contract.js';
import type { SqliteAdminHost } from './sqlite-store-admin.js';
import { ftsPrefixTerms, sqliteRowsToMemories } from './sqlite-store-search-helpers.js';

const MVP_LIMIT = 50;

export function executeUnifiedSearch(
  host: SqliteAdminHost,
  query: SearchQuery,
): SearchResult {
  // Match clause: build a safe FTS5 MATCH expression from the query text.
  // Empty / whitespace / non-alphanumeric-only text → undefined, which
  // means "no FTS5 constraint" — subsequent ORDER BY bm25 will produce a
  // stable ordering on importance/updated_at, deterministic for tests.
  const matchExpr = buildMatchExpr(query);

  // WHERE filters — every conditional clause builds its own parameter.
  // `params` is typed `SQLInputValue[]` to satisfy `StatementSync.bind`'s
  // strict signature; runtime accepts string | number | null | bigint.
  // WHERE filters — every conditional clause builds its own parameter.
  // `params` is typed `SQLInputValue[]` to satisfy `StatementSync.bind`'s
  // strict signature; runtime accepts string | number | null | bigint.
  const sharedWhere: string[] = ["status = ?"];
  const params: SQLInputValue[] = ['active'];

  if (query.kinds && query.kinds.length > 0) {
    sharedWhere.push(`kind IN (${query.kinds.map(() => '?').join(',')})`);
    params.push(...query.kinds);
  }

  if (query.scopes && query.scopes.length > 0) {
    sharedWhere.push(`scope IN (${query.scopes.map(() => '?').join(',')})`);
    params.push(...query.scopes);
  }

  if (query.importanceAtLeast !== undefined) {
    sharedWhere.push('importance >= ?');
    params.push(query.importanceAtLeast);
  }

  const sharedWhereSql = sharedWhere.length > 0
    ? ' WHERE ' + sharedWhere.join(' AND ')
    : '';

  // Two query paths, mirroring `searchSqliteSage` exactly. FTS5 requires
  // MATCH + bm25 to *both* be present, otherwise its query planner emits
  // internal references (e.g. `T.text`) that don't resolve against the
  // content table. Split paths avoid that and let both code paths be tested
  // independently.
  let dataRows: Array<{ data: string }>;
  let totalRow: { n: number };
  let matchReason: SearchMatchReason;

  if (matchExpr !== undefined) {
    // FTS path — JOIN memories_fts, MATCH, ORDER BY bm25 ASC.
    // The JOIN + MATCH are coupled; do not split them or FTS5 errors.
    // Build the WHERE clause inline: status (m.column), MATCH (FTS),
    // then the optional kind/scope/importance filter columns (m.column).
    const ftsFilterClauses: string[] = ['m.status = ?', 'memories_fts MATCH ?'];
    if (query.kinds && query.kinds.length > 0) {
      ftsFilterClauses.push(`m.kind IN (${query.kinds.map(() => '?').join(',')})`);
    }
    if (query.scopes && query.scopes.length > 0) {
      ftsFilterClauses.push(`m.scope IN (${query.scopes.map(() => '?').join(',')})`);
    }
    if (query.importanceAtLeast !== undefined) {
      ftsFilterClauses.push('m.importance >= ?');
    }
    const ftsParams: SQLInputValue[] = ['active', matchExpr];
    if (query.kinds && query.kinds.length > 0) ftsParams.push(...query.kinds);
    if (query.scopes && query.scopes.length > 0) ftsParams.push(...query.scopes);
    if (query.importanceAtLeast !== undefined) ftsParams.push(query.importanceAtLeast);

    const ftsWhereSql = ' WHERE ' + ftsFilterClauses.join(' AND ');
    const ftsDataSql =
      `SELECT m.data FROM memories m JOIN memories_fts f ON m.rowid = f.rowid` +
      ftsWhereSql +
      ` ORDER BY bm25(memories_fts) ASC, m.importance DESC, m.updated_at DESC` +
      ` LIMIT ${MVP_LIMIT}`;
    const ftsCountSql =
      `SELECT COUNT(*) AS n FROM memories m JOIN memories_fts f ON m.rowid = f.rowid` +
      ftsWhereSql;

    dataRows = host.stmt(ftsDataSql).all(...ftsParams) as Array<{ data: string }>;
    totalRow = host.stmt(ftsCountSql).get(...ftsParams) as unknown as { n: number };
    matchReason = 'lexical';
  } else {
    // Non-FTS path — plain SELECT on memories, ORDER BY importance/updated_at
    // DESC. Same filter columns (without `m.` prefix), no FTS involvement.
    const dataSql =
      `SELECT data FROM memories` +
      sharedWhereSql +
      ` ORDER BY importance DESC, updated_at DESC` +
      ` LIMIT ${MVP_LIMIT}`;
    const countSql = `SELECT COUNT(*) AS n FROM memories` + sharedWhereSql;

    dataRows = host.stmt(dataSql).all(...params) as Array<{ data: string }>;
    totalRow = host.stmt(countSql).get(...params) as unknown as { n: number };
    matchReason = 'recency';
  }

  const memories = sqliteRowsToMemories(dataRows);

  const hits: SearchHit[] = memories.map((memory) => ({
    id: memory.id,
    kind: memory.kind,
    scope: memory.scope,
    tags: memory.tags,
    text: memory.text,
    importance: memory.importance,
    confidence: memory.confidence,
    status: memory.status,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    score: 1.0,
    matchReason,
    // anchors/audience/verifiedAt intentionally omitted in MVP — the
    // SearchHit type declares them as optional; SQLite rows carry the
    // fields but we don't project them yet. Future commit adds anchor
    // materialization alongside the anchor filter (§10 commit-1.5).
  }));

  // Echo the parsed query back so callers can confirm input parsing.
  // Empty filters echo nothing; only non-empty arrays echo.
  const queryEcho: SearchResult['queryEcho'] = {};
  if (query.text !== undefined) queryEcho.text = query.text;
  if (query.kinds !== undefined) queryEcho.kinds = query.kinds;
  if (query.scopes !== undefined) queryEcho.scopes = query.scopes;

  return {
    hits,
    suggestions: [],
    totalCandidates: totalRow.n,
    rankingApplied: 'hybrid',
    queryEcho,
  };
}

/**
 * Build a safe FTS5 MATCH expression from the query text. The terms
 * emitted by `ftsPrefixTerms` are pre-sanitized — non-alphanumeric
 * characters stripped, no FTS5 operators leak through. Joining with
 * `AND` ensures all terms must match (a "tighter" semantic than FTS5's
 * default OR-with-rank, which matches the §5 hybrid-ranking intent).
 *
 * Returns `undefined` for empty / whitespace / sanitized-to-empty
 * queries, signalling "no FTS constraint" to the caller.
 */
function buildMatchExpr(query: SearchQuery): string | undefined {
  if (query.text === undefined || query.text === null) return undefined;
  const trimmed = query.text.trim();
  if (trimmed.length === 0) return undefined;
  const terms = ftsPrefixTerms(trimmed);
  if (terms.length === 0) return undefined;
  return terms.join(' AND ');
}
