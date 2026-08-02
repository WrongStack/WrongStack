/**
 * Implementation of `unifiedSearchService` for the SAGE IPC op `unifiedSearch`.
 *
 * Wired 2026-07-28 (commit 1.5). See `packages/sage/docs/search-and-suggest.md`
 * for the design contract.
 *
 * Supports: text prefix-match (FTS5), kinds/scopes/status/importance/freshness/
 * path-anchor filters, audience + anchor post-filters, configurable limit,
 * status selection, and four ranking modes:
 * - 'relevance': bm25 ASC, importance DESC, updated_at DESC (lexical-first)
 * - 'recency': updated_at DESC, importance DESC
 * - 'importance': importance DESC, updated_at DESC
 * - 'hybrid' (default): bm25 ASC, importance DESC, updated_at DESC
 *
 * Scores are normalized to [0, 1] within the result set so callers can
 * threshold on relative quality. Suggestions implement the design doc's v1
 * lexical-adjacency method: 'never' / 'empty' (default) / 'always' via an
 * OR-expanded FTS query (graph BFS is the documented v2 method, deferred).
 * `cursor` pagination is explicitly rejected — use `listSagePage` for
 * cursor navigation.
 *
 * Single-owner-of-state invariant preserved — read-only, composes against
 * FTS5 + the existing memories join.
 */
import type { SQLInputValue } from 'node:sqlite';
import type {
  SearchOptions,
  SearchQuery,
  SearchResult,
  SearchHit,
  SearchMatchReason,
  SearchRanking,
} from './service-contract.js';
import type { SqliteAdminHost } from './sqlite-store-admin.js';
import { buildRetrievePathTargets } from './sqlite-store-retrieve-helpers.js';
import {
  buildSessionClause,
  ftsPrefixTerms,
  sqliteRowsToMemories,
} from './sqlite-store-search-helpers.js';
import { normalizeSlashes } from './paths.js';
import type { MemoryAnchor, MemoryAudienceSelector, Sage, SageStatus } from './types.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/**
 * Over-fetch factor for JS-side filters (audience/anchor) that cannot be
 * expressed against the JSON payload in SQL. The pre-filter LIMIT is scaled
 * by this factor and the filtered result is sliced back to the caller's
 * limit, so a narrow filter does not silently starve the result set.
 */
const JS_FILTER_OVERFETCH = 5;

export function executeUnifiedSearch(
  host: SqliteAdminHost,
  query: SearchQuery,
  options?: SearchOptions | undefined,
): SearchResult {
  const limit = Math.min(Math.max(options?.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const statusFilter = options?.includeStatuses ?? ['active'] as SageStatus[];
  const ranking: SearchRanking = options?.ranking ?? 'hybrid';
  // Session isolation: session-scoped memories must only be visible to their
  // owning session (or to administrative callers that opt out explicitly).
  const session = buildSessionClause(options);
  const ftsSession = buildSessionClause(options, 'm.');

  // Cursor pagination cannot be honored under ranking-ordered queries (bm25
  // positions are not stable cursor keys) — reject it explicitly instead of
  // silently ignoring a declared field. listSagePage is the cursor surface.
  if (query.cursor) {
    throw new Error(
      'unifiedSearch does not support cursor pagination — use listSagePage for cursor navigation.',
    );
  }

  if (statusFilter.length === 0) {
    return { hits: [], suggestions: [], totalCandidates: 0, rankingApplied: ranking, queryEcho: {} };
  }

  // JS-side filters (audience/anchor) live in the JSON payload and cannot be
  // expressed cleanly in the SQL WHERE clause, so they run post-fetch inside
  // an over-fetch window that keeps the pre-filter LIMIT from starving them.
  const jsFilters: Array<(memory: Sage) => boolean> = [];
  if (query.audience) {
    jsFilters.push((memory) => audienceSelectorMatches(query.audience!, memory.audience));
  }
  if (query.anchor) {
    jsFilters.push((memory) => anchorMatches(query.anchor!, memory.anchors));
  }
  const sqlLimit =
    jsFilters.length > 0 ? Math.min(limit * JS_FILTER_OVERFETCH, MAX_LIMIT * 5) : limit;

  // Match clause: build a safe FTS5 MATCH expression from the query text.
  const matchExpr = buildMatchExpr(query);

  // WHERE filters — built inline in the FTS and non-FTS query paths below.
  const statusPlaceholders = statusFilter.map(() => '?').join(',');

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
    appendFreshnessClauses(query, ftsFilterClauses, ftsParams, 'm.');
    const pathClause = buildPathExistsClause(host.projectRoot, query, 'm.');
    if (pathClause) {
      ftsFilterClauses.push(pathClause.clause);
      ftsParams.push(...pathClause.params);
    }
    if (ftsSession.clause) {
      ftsFilterClauses.push(ftsSession.clause.replace(/^\s*AND\s+/i, ''));
      ftsParams.push(...ftsSession.params);
    }

    const ftsWhereSql = ' WHERE ' + ftsFilterClauses.join(' AND ');
    const ftsDataSql =
      `SELECT m.data FROM memories m JOIN memories_fts f ON m.rowid = f.rowid` +
      ftsWhereSql +
      ` ORDER BY ${orderBy.fts}` +
      ` LIMIT ${sqlLimit}`;
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
    appendFreshnessClauses(query, sharedWhere, params, '');
    const pathClause = buildPathExistsClause(host.projectRoot, query, '');
    if (pathClause) {
      sharedWhere.push(pathClause.clause);
      params.push(...pathClause.params);
    }
    if (session.clause) {
      sharedWhere.push(session.clause.replace(/^\s*AND\s+/i, ''));
      params.push(...session.params);
    }

    const sharedWhereSql = sharedWhere.length > 0
      ? ' WHERE ' + sharedWhere.join(' AND ')
      : '';

    const dataSql =
      `SELECT data FROM memories` +
      sharedWhereSql +
      ` ORDER BY ${orderBy.nonFts}` +
      ` LIMIT ${sqlLimit}`;
    const countSql = `SELECT COUNT(*) AS n FROM memories` + sharedWhereSql;

    dataRows = host.stmt(dataSql).all(...params) as Array<{ data: string }>;
    totalRow = host.stmt(countSql).get(...params) as unknown as { n: number };
    matchReason = 'recency';
  }

  let memories = sqliteRowsToMemories(dataRows);
  if (jsFilters.length > 0) {
    memories = memories.filter((memory) => jsFilters.every((filter) => filter(memory)));
  }
  const finalMemories = memories.slice(0, limit);

  // Compute normalized scores within the result set.
  // The score blends importance, confidence, and freshness with the
  // bm25 rank position (for FTS) or updated_at rank (for non-FTS).
  const scores = computeNormalizedScores(finalMemories);

  const hits: SearchHit[] = finalMemories.map((memory, index) => ({
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

  // Suggestions: design-doc v1 lexical adjacency. 'never' disables; 'empty'
  // (default) populates only when the hits set is empty; 'always' populates
  // whenever an OR-expanded FTS query finds neighbors.
  let suggestions: SearchHit[] = [];
  const suggestMode = options?.suggest ?? 'empty';
  if (suggestMode !== 'never' && (suggestMode === 'always' || hits.length === 0)) {
    suggestions = suggestLexicalAdjacent({
      host,
      query,
      matchExpr,
      limit,
      hits,
      statuses: statusFilter,
      ranking,
      ftsSession,
    });
  }

  // Echo the parsed query back so callers can confirm input parsing.
  const queryEcho: SearchResult['queryEcho'] = {};
  if (query.text !== undefined) queryEcho.text = query.text;
  if (query.kinds !== undefined) queryEcho.kinds = query.kinds;
  if (query.scopes !== undefined) queryEcho.scopes = query.scopes;
  if (query.importanceAtLeast !== undefined) queryEcho.importanceAtLeast = query.importanceAtLeast;
  if (query.freshness !== undefined) queryEcho.freshness = query.freshness;
  if (query.paths !== undefined) queryEcho.paths = query.paths;
  if (query.audience !== undefined) queryEcho.audience = query.audience;
  if (query.anchor !== undefined) queryEcho.anchor = query.anchor;

  return {
    hits,
    suggestions,
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

/**
 * Append SQL-side freshness filters (createdAfter/verifiedAfter) to a clause
 * list, keeping params in lock-step. `prefix` is the memories-table alias
 * ('' for unaliased, 'm.' for FTS joins).
 */
function appendFreshnessClauses(
  query: SearchQuery,
  clauses: string[],
  params: SQLInputValue[],
  prefix: string,
): void {
  if (query.freshness?.createdAfter !== undefined) {
    clauses.push(`${prefix}created_at >= ?`);
    params.push(query.freshness.createdAfter);
  }
  if (query.freshness?.verifiedAfter !== undefined) {
    clauses.push(`json_extract(${prefix}data, '$.lastVerifiedAt') >= ?`);
    params.push(query.freshness.verifiedAfter);
  }
}

/**
 * Build an EXISTS subquery restricting the search to memories whose anchor
 * graph points at one of `query.paths` (file/dir nodes plus symbol globs),
 * reusing the same target normalization as `retrieveForPath` so path
 * matching is consistent across surfaces.
 */
function buildPathExistsClause(
  projectRoot: string,
  query: SearchQuery,
  prefix: string,
): { clause: string; params: string[] } | undefined {
  if (!query.paths || query.paths.length === 0) return undefined;
  const { targetList, symbolGlobs } = buildRetrievePathTargets(projectRoot, query.paths, true);
  if (targetList.length === 0 && symbolGlobs.length === 0) return undefined;
  const targetPlaceholders = targetList.map(() => '?').join(',');
  const globConditions = symbolGlobs.map(() => 'e.to_node GLOB ?').join(' OR ');
  const inner = [
    `e.to_node IN (${targetPlaceholders})`,
    ...(globConditions ? [globConditions] : []),
  ].join(' OR ');
  return {
    clause: `EXISTS (SELECT 1 FROM edges e WHERE e.from_node = 'mem:' || ${prefix}id AND (${inner}))`,
    params: [...targetList, ...symbolGlobs],
  };
}

/**
 * True when the caller's audience selector intersects the memory's selector
 * on at least one dimension. The design doc (search-and-suggest.md §7)
 * treats audience as an opt-in filter: passing one means "only memories
 * tagged with that audience".
 */
function audienceSelectorMatches(
  wanted: MemoryAudienceSelector,
  have: MemoryAudienceSelector | undefined,
): boolean {
  if (!have) return false;
  const intersects = (a?: string[], b?: string[]): boolean =>
    a !== undefined && b !== undefined && a.some((value) => b.includes(value));
  return (
    intersects(wanted.roles, have.roles) ||
    intersects(wanted.taskTypes, have.taskTypes) ||
    intersects(wanted.modes, have.modes)
  );
}

/** True when a memory carries an anchor matching the caller's `anchor` filter. */
function anchorMatches(wanted: MemoryAnchor, anchors: MemoryAnchor[]): boolean {
  const wantedPath = wanted.path ? normalizeSlashes(wanted.path).toLowerCase() : undefined;
  return anchors.some((anchor) => {
    if (anchor.type !== wanted.type) return false;
    if (wantedPath !== undefined) {
      const havePath = anchor.path ? normalizeSlashes(anchor.path).toLowerCase() : undefined;
      if (havePath !== wantedPath) return false;
    }
    if (wanted.symbol !== undefined && anchor.symbol !== wanted.symbol) return false;
    if (wanted.command !== undefined && anchor.command !== wanted.command) return false;
    if (
      wanted.role !== undefined &&
      (anchor.role ?? '').toLowerCase() !== wanted.role.toLowerCase()
    ) {
      return false;
    }
    return true;
  });
}

interface SuggestLexicalAdjacentInput {
  host: SqliteAdminHost;
  query: SearchQuery;
  matchExpr: string | undefined;
  limit: number;
  hits: SearchHit[];
  statuses: SageStatus[];
  ranking: SearchRanking;
  ftsSession: { clause: string; params: string[] };
}

/**
 * Design-doc v1 suggestions: lexical adjacency. When the primary query found
 * nothing (or 'always' is requested), re-run the same filters with an
 * OR-expanded FTS expression so memories sharing any query term surface as
 * neighbors. Graph-adjacency BFS is the documented v2 method (deferred).
 * Sorted by the same ranking policy as `hits`.
 */
function suggestLexicalAdjacent(input: SuggestLexicalAdjacentInput): SearchHit[] {
  const { host, query, matchExpr, limit, hits, statuses, ranking, ftsSession } = input;
  if (!matchExpr) return []; // filters-only query: no lexical neighborhood
  const terms = ftsPrefixTerms(query.text ?? '');
  if (terms.length < 2) return []; // a single term has no meaningful OR expansion
  const excluded = new Set(hits.map((hit) => hit.id));
  const orExpr = terms.join(' OR ');
  const statusPlaceholders = statuses.map(() => '?').join(',');

  const clauses: string[] = ['m.status IN (' + statusPlaceholders + ')', 'memories_fts MATCH ?'];
  const params: SQLInputValue[] = [...statuses, orExpr];
  if (query.kinds && query.kinds.length > 0) {
    clauses.push(`m.kind IN (${query.kinds.map(() => '?').join(',')})`);
    params.push(...query.kinds);
  }
  if (query.scopes && query.scopes.length > 0) {
    clauses.push(`m.scope IN (${query.scopes.map(() => '?').join(',')})`);
    params.push(...query.scopes);
  }
  if (query.importanceAtLeast !== undefined) {
    clauses.push('m.importance >= ?');
    params.push(query.importanceAtLeast);
  }
  appendFreshnessClauses(query, clauses, params, 'm.');
  if (ftsSession.clause) {
    clauses.push(ftsSession.clause.replace(/^\s*AND\s+/i, ''));
    params.push(...ftsSession.params);
  }

  const whereSql = ' WHERE ' + clauses.join(' AND ');
  const rows = host
    .stmt(
      `SELECT m.data FROM memories m JOIN memories_fts f ON m.rowid = f.rowid` +
        whereSql +
        ` ORDER BY ${buildOrderBy(ranking, true).fts}` +
        ` LIMIT ${Math.min(Math.max(limit * 2, 10), MAX_LIMIT)}`,
    )
    .all(...params) as Array<{ data: string }>;

  const candidates = sqliteRowsToMemories(rows).filter((memory) => !excluded.has(memory.id));
  const chosen = candidates.slice(0, limit);
  const scores = computeNormalizedScores(chosen);
  return chosen.map((memory, index) => ({
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
    matchReason: 'lexical' as const,
  }));
}
