/**
 * Implementation of `unifiedSearchService` for the SAGE IPC op `unifiedSearch`.
 *
 * Wired 2026-07-28 (commit 1.5). See `packages/sage/docs/search-and-suggest.md`
 * for the design contract.
 *
 * Supports: text prefix-match (FTS5), kinds/scopes/status/importance filters,
 * configurable limit, status selection, and four ranking modes:
 * - 'relevance': bm25 ASC, importance DESC, updated_at DESC (lexical-first)
 * - 'recency': updated_at DESC, importance DESC
 * - 'importance': importance DESC, updated_at DESC
 * - 'hybrid' (default): bm25 ASC, importance DESC, updated_at DESC
 *
 * Scores are normalized to [0, 1] within the result set so callers can
 * threshold on relative quality. No suggestions yet (returns empty array;
 * spec says lexical-adjacency top-N is the v1 suggestion method, deferred).
 *
 * Single-owner-of-state invariant preserved — read-only, composes against
 * FTS5 + the existing memories join.
 */
import type { SQLInputValue } from 'node:sqlite';
import type { SearchQuery, SearchResult, SearchHit, SearchMatchReason, SearchRanking } from './service-contract.js';
import type { SqliteAdminHost } from './sqlite-store-admin.js';
import { ftsPrefixTerms, sqliteRowsToMemories } from './sqlite-store-search-helpers.js';
import type { SageStatus } from './types.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function executeUnifiedSearch(
  host: SqliteAdminHost,
  query: SearchQuery,
  options?: { limit?: number | undefined; includeStatuses?: SageStatus[] | undefined; ranking?: SearchRanking | undefined },
): SearchResult {
  const limit = Math.min(Math.max(options?.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const statusFilter = options?.includeStatuses ?? ['active'] as SageStatus[];
  const ranking: SearchRanking = options?.ranking ?? 'hybrid';
  if (statusFilter.length === 0) {
    return { hits: [], suggestions: [], totalCandidates: 0, rankingApplied: ranking, queryEcho: {} };
  }

  // Match clause: build a safe FTS5 MATCH expression from the query text.
  const matchExpr = buildMatchExpr(query);

  // WHERE filters — every conditional clause builds its own parameter.
  const statusPlaceholders = statusFilter.map(() => '?').join(',');

  // Kind filter
  const kindClauses: string[] = [];
  const kindParams: SQLInputValue[] = [];
  if (query.kinds && query.kinds.length > 0) {
    kindClauses.push(`kind IN (${query.kinds.map(() => '?').join(',')})`);
    kindParams.push(...query.kinds);
  }

  // Scope filter
  const scopeClauses: string[] = [];
  const scopeParams: SQLInputValue[] = [];
  if (query.scopes && query.scopes.length > 0) {
    scopeClauses.push(`scope IN (${query.scopes.map(() => '?').join(',')})`);
    scopeParams.push(...query.scopes);
  }

  // Importance filter (applied in the WHERE clause construction below)
  // No standalone clause needed here — it's added inline.

  // ORDER BY clause per ranking mode
  const orderBy = buildOrderBy(ranking, matchExpr !== undefined);

  // Two query paths, mirroring `searchSqliteSage`. FTS5 requires
  // MATCH + bm25 to both be present. Split paths let both be tested
  // independently.
  let dataRows: Array<{ data: string }>;
  let totalRow: { n: number };
  let matchReason: SearchMatchReason;

  if (matchExpr !== undefined) {
    // FTS path — JOIN memories_fts, MATCH, ORDER BY ranking.
    const ftsFilterClauses: string[] = [
      'm.status IN (' + statusPlaceholders + ')',
      'memories_fts MATCH ?',
    ];
    const ftsParams: SQLInputValue[] = [...statusFilter, matchExpr];
    if (query.kinds && query.kinds.length > 0) {
      ftsFilterClauses.push(`m.kind IN (${query.kinds.map(() => '?').join(',')})`);
      ftsParams.push(...query.kinds);
    }
    if (query.scopes && query.scopes.length > 0) {
      ftsFilterClauses.push(`m.scope IN (${query.scopes.map(() => '?').join(',')})`);
      ftsParams.push(...query.scopes);
    }
    if (query.importanceAtLeast !== undefined) {
      ftsFilterClauses.push('m.importance >= ?');
      ftsParams.push(query.importanceAtLeast);
    }

    const ftsWhereSql = ' WHERE ' + ftsFilterClauses.join(' AND ');
    const ftsDataSql =
      `SELECT m.data FROM memories m JOIN memories_fts f ON m.rowid = f.rowid` +
      ftsWhereSql +
      ` ORDER BY ${orderBy.fts}` +
      ` LIMIT ${limit}`;
    const ftsCountSql =
      `SELECT COUNT(*) AS n FROM memories m JOIN memories_fts f ON m.rowid = f.rowid` +
      ftsWhereSql;

    dataRows = host.stmt(ftsDataSql).all(...ftsParams) as Array<{ data: string }>;
    totalRow = host.stmt(ftsCountSql).get(...ftsParams) as unknown as { n: number };
    matchReason = 'lexical';
  } else {
    // Non-FTS path — plain SELECT on memories, ORDER BY ranking.
    const sharedWhere: string[] = [`status IN (${statusPlaceholders})`];
    const params: SQLInputValue[] = [...statusFilter];
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

    const dataSql =
      `SELECT data FROM memories` +
      sharedWhereSql +
      ` ORDER BY ${orderBy.nonFts}` +
      ` LIMIT ${limit}`;
    const countSql = `SELECT COUNT(*) AS n FROM memories` + sharedWhereSql;

    dataRows = host.stmt(dataSql).all(...params) as Array<{ data: string }>;
    totalRow = host.stmt(countSql).get(...params) as unknown as { n: number };
    matchReason = 'recency';
  }

  const memories = sqliteRowsToMemories(dataRows);

  // Compute normalized scores within the result set.
  // The score blends importance, confidence, and freshness with the
  // bm25 rank position (for FTS) or updated_at rank (for non-FTS).
  const scores = computeNormalizedScores(memories);

  const hits: SearchHit[] = memories.map((memory, index) => ({
    id: memory.id,
    kind: memory.kind,
    scope: memory.scope,
    tags: memory.tags,
    anchors: memory.anchors,
    audience: memory.audience,
    text: memory.text,
    importance: memory.importance,
    confidence: memory.confidence,
    status: memory.status,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    verifiedAt: memory.lastVerifiedAt,
    score: scores[index]!,
    matchReason,
  }));

  // Echo the parsed query back so callers can confirm input parsing.
  const queryEcho: SearchResult['queryEcho'] = {};
  if (query.text !== undefined) queryEcho.text = query.text;
  if (query.kinds !== undefined) queryEcho.kinds = query.kinds;
  if (query.scopes !== undefined) queryEcho.scopes = query.scopes;
  if (query.importanceAtLeast !== undefined) queryEcho.importanceAtLeast = query.importanceAtLeast;

  return {
    hits,
    suggestions: [],
    totalCandidates: totalRow.n,
    rankingApplied: ranking,
    queryEcho,
  };
}

/**
 * Build a safe FTS5 MATCH expression from the query text. The terms
 * emitted by `ftsPrefixTerms` are pre-sanitized. Joining with `AND`
 * ensures all terms must match.
 *
 * Returns `undefined` for empty / whitespace / sanitized-to-empty
 * queries, signalling "no FTS constraint".
 */
function buildMatchExpr(query: SearchQuery): string | undefined {
  if (query.text === undefined || query.text === null) return undefined;
  const trimmed = query.text.trim();
  if (trimmed.length === 0) return undefined;
  const terms = ftsPrefixTerms(trimmed);
  if (terms.length === 0) return undefined;
  return terms.join(' AND ');
}

/**
 * Build the ORDER BY clause for the given ranking mode.
 * Returns separate clauses for FTS (aliased `m.`) and non-FTS paths
 * because the FTS join requires the `m.` prefix on some columns.
 */
function buildOrderBy(
  ranking: SearchRanking,
  hasFts: boolean,
): { fts: string; nonFts: string } {
  switch (ranking) {
    case 'recency':
      return {
        fts: 'm.updated_at DESC, m.importance DESC',
        nonFts: 'updated_at DESC, importance DESC',
      };
    case 'importance':
      return {
        fts: 'm.importance DESC, m.updated_at DESC',
        nonFts: 'importance DESC, updated_at DESC',
      };
    case 'relevance':
      // Lexical-first: bm25 ASC (lower = better match), then importance DESC
      return {
        fts: hasFts
          ? 'bm25(memories_fts) ASC, m.importance DESC, m.updated_at DESC'
          : 'm.importance DESC, m.updated_at DESC',
        nonFts: 'importance DESC, updated_at DESC',
      };
    case 'hybrid':
    default:
      // Same as relevance for FTS; importance-first for non-FTS
      return {
        fts: hasFts
          ? 'bm25(memories_fts) ASC, m.importance DESC, m.updated_at DESC'
          : 'm.importance DESC, m.updated_at DESC',
        nonFts: 'importance DESC, updated_at DESC',
      };
  }
}

/**
 * Compute normalized scores for a result set. Each score is in [0, 1]
 * where 1.0 is the best-scoring memory in the set.
 *
 * The score is position-weighted: items earlier in the result set
 * (better FTS bm25 match, higher importance, or more recent depending
 * on ranking mode) get higher scores via a linear decay. A small
 * metadata bonus (importance * 0.15) breaks ties toward higher-quality
 * memories without overriding the ranking position.
 */
function computeNormalizedScores(memories: { importance: number }[]): number[] {
  if (memories.length === 0) return [];
  const len = memories.length;
  return memories.map((m, index) => {
    const positionScore = 1 - index / Math.max(len, 1);
    const metadataBonus = m.importance * 0.15;
    return Math.min(1, Math.max(0, positionScore * 0.85 + metadataBonus));
  });
}
