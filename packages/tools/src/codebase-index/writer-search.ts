import { expectDefined } from '@wrongstack/core/utils';
import { type Bm25Index, tokenise } from './bm25.js';
import { lspKindToInternalKind } from './lsp-kind.js';
import type { SearchResult, SymbolKind } from './schema.js';
import {
  cosineSimilarity,
  decodeVector,
  embedText,
  reciprocalRankFusion,
} from './vector-search.js';
import { escapeLike } from './writer-helpers.js';
import {
  buildWriterSearchWhere,
  mapWriterSearchRow,
  normalizeSearchLimit,
  SEARCH_CANDIDATE_SCAN_CAP,
  type WriterSearchFilter,
  type WriterSearchRow,
} from './writer-search-helpers.js';

export function searchWithStatement(
  stmtFn: (sql: string) => { all: (...args: (string | number)[]) => unknown[] },
  query: string,
  filter?: WriterSearchFilter,
  opts?: { limit?: number | undefined },
): SearchResult[] {
  const built = buildWriterSearchWhere(query, filter);
  if (built === null) return [];

  const { where, values } = built;
  const limit = normalizeSearchLimit(opts?.limit);
  const limitSql = limit !== undefined ? ' LIMIT ?' : '';
  const sql = `SELECT id, lang, kind, name, file, line, col, signature, doc_comment FROM symbols ${where}${limitSql}`;

  const binds = limit !== undefined ? [...values, limit] : values;
  const rows = stmtFn(sql).all(...(binds as (string | number)[])) as unknown as WriterSearchRow[];

  return rows.map((row) => mapWriterSearchRow(row, filter?.lspKind));
}

export function countSearchWithStatement(
  stmtFn: (sql: string) => { get: (...args: (string | number)[]) => unknown },
  query: string,
  filter?: WriterSearchFilter | undefined,
): number {
  const built = buildWriterSearchWhere(query, filter);
  if (built === null) return 0;
  const row = stmtFn(`SELECT COUNT(*) AS n FROM symbols ${built.where}`).get(
    ...(built.values as (string | number)[]),
  ) as { n?: number } | undefined;
  return Number(row?.n ?? 0);
}

export function searchRankedWithStatement(
  stmtFn: (sql: string) => {
    all: (...args: (string | number)[]) => unknown[];
    get: (...args: (string | number)[]) => unknown;
  },
  searchFn: (
    query: string,
    filter?: WriterSearchFilter,
    opts?: { limit?: number | undefined },
  ) => SearchResult[],
  ftsAvailable: boolean,
  vectorsAvailable: boolean,
  getOrBuildBm25: () => Bm25Index,
  query: string,
  filter: WriterSearchFilter | undefined,
  limit: number,
): { results: SearchResult[]; total: number } {
  const rawLimit = Number.isFinite(limit) ? Math.trunc(limit) : 20;
  const safeLimit = Math.max(1, Math.min(rawLimit, 100));
  const tokens = tokenise(query);

  if (tokens.length === 0 || !ftsAvailable) {
    return searchRankedFallbackWithStatement(
      stmtFn,
      searchFn,
      getOrBuildBm25,
      query,
      filter,
      safeLimit,
    );
  }

  let effectiveKind: SymbolKind | undefined = filter?.kind;
  // `!= null` (not `!== undefined`): a MessagePack wire client encodes a
  // missing lspKind as nil, which arrives here as null. Absent and null mean
  // the same thing — no LSP-kind filter.
  if (filter?.lspKind != null) {
    const mapped = lspKindToInternalKind(filter.lspKind);
    if (mapped === null) return { results: [], total: 0 };
    effectiveKind = mapped;
  }

  const longTokens = tokens.filter((t) => t.length >= 3);
  const shortTokens = tokens.filter((t) => t.length < 3);

  if (longTokens.length === 0) {
    return searchRankedFallbackWithStatement(
      stmtFn,
      searchFn,
      getOrBuildBm25,
      query,
      filter,
      safeLimit,
    );
  }

  const match = longTokens.map((t) => `"${t.replaceAll('"', '')}"`).join(' OR ');

  const conditions: string[] = ['symbols_fts MATCH ?'];
  const values: (string | number)[] = [match];
  for (const shortTok of shortTokens) {
    conditions.push("s.text LIKE ? ESCAPE '\\'");
    values.push(`%${escapeLike(shortTok)}%`);
  }
  if (effectiveKind) {
    conditions.push('s.kind = ?');
    values.push(effectiveKind);
  }
  if (filter?.lang) {
    conditions.push('s.lang = ?');
    values.push(filter.lang);
  }
  if (filter?.file) {
    conditions.push("replace(s.file, '\\', '/') LIKE ? ESCAPE '\\'");
    values.push(`%${escapeLike(filter.file.replace(/\\/g, '/'))}%`);
  }
  const where = conditions.join(' AND ');

  // P2.5: one statement, not two. The total rides in an uncorrelated scalar
  // subquery — SQLite evaluates it once per statement — so there is no second
  // prepared/execute round trip and the count can never disagree with the
  // fetched page. (A `COUNT(*) OVER()` window column is NOT usable here: the
  // window forces a separate evaluation pass and FTS5 auxiliary functions
  // like bm25()/snippet() are rejected there — "unable to use function bm25
  // in the requested context". The inner `s` alias shadows the outer one, so
  // the same WHERE fragment binds in both contexts.)
  const bm25Rows = stmtFn(
    `SELECT s.id, s.lang, s.kind, s.name, s.file, s.line, s.col, s.signature, s.doc_comment,
            -bm25(symbols_fts) AS score,
            snippet(symbols_fts, 0, '', '', '…', 12) AS snippet,
            -- Keep this uncorrelated: referencing outer columns turns it into
            -- a per-row subquery and defeats the one-count-per-statement win.
            (SELECT COUNT(*) FROM symbols_fts JOIN symbols s ON s.id = symbols_fts.rowid
              WHERE ${where}) AS total_count
     FROM symbols_fts JOIN symbols s ON s.id = symbols_fts.rowid
     WHERE ${where}
     ORDER BY
       CASE WHEN lower(s.name) = lower(?) THEN 0
            WHEN lower(s.name) LIKE lower(?) ESCAPE '\\' THEN 1
            ELSE 2 END,
       bm25(symbols_fts), lower(s.name), s.file, s.line, s.col, s.id
     LIMIT ?`,
  ).all(...values, ...values, query.trim(), `${escapeLike(query.trim())}%`, safeLimit) as {
    id: number;
    lang: string;
    kind: string;
    name: string;
    file: string;
    line: number;
    col: number;
    signature: string;
    doc_comment: string;
    score: number;
    snippet: string;
    total_count: number;
  }[];

  if (bm25Rows.length === 0) return { results: [], total: 0 };
  const total = Number(bm25Rows[0]?.total_count ?? 0);

  if (vectorsAvailable) {
    const queryVec = embedText(query);
    const candidateIds = bm25Rows.map((r) => r.id);
    const placeholders = candidateIds.map(() => '?').join(',');
    const vecRows = stmtFn(
      `SELECT sv.symbol_id, sv.vector FROM symbol_vectors sv WHERE sv.symbol_id IN (${placeholders})`,
    ).all(...candidateIds) as { symbol_id: number; vector: Buffer }[];

    const vecScores: Array<{ id: number; sim: number }> = vecRows
      .map((r) => ({
        id: r.symbol_id,
        sim: cosineSimilarity(queryVec, decodeVector(r.vector)),
      }))
      .sort((a, b) => b.sim - a.sim);

    const bm25Rank = new Map<number, number>();
    bm25Rows.forEach((r, i) => {
      bm25Rank.set(r.id, i);
    });
    const vecRank = new Map<number, number>();
    vecScores.forEach((r, i) => {
      vecRank.set(r.id, i);
    });

    const fused = reciprocalRankFusion(bm25Rank, vecRank, 60);
    const fusedScore = new Map(fused);

    const sorted = [...bm25Rows].sort(
      (a, b) => (fusedScore.get(b.id) ?? 0) - (fusedScore.get(a.id) ?? 0),
    );

    return {
      results: sorted.map((row) =>
        mapWriterSearchRow(row, filter?.lspKind, Math.max(0.0001, row.score), row.snippet),
      ),
      total,
    };
  }

  return {
    results: bm25Rows.map((row) =>
      mapWriterSearchRow(row, filter?.lspKind, Math.max(0.0001, row.score), row.snippet),
    ),
    total,
  };
}

export function searchRankedFallbackWithStatement(
  stmtFn: (sql: string) => {
    all: (...args: (string | number)[]) => unknown[];
    get: (...args: (string | number)[]) => unknown;
  },
  searchFn: (
    query: string,
    filter?: WriterSearchFilter,
    opts?: { limit?: number | undefined },
  ) => SearchResult[],
  getOrBuildBm25: () => Bm25Index,
  query: string,
  filter: WriterSearchFilter | undefined,
  limit: number,
): { results: SearchResult[]; total: number } {
  if (!query.trim()) {
    const total = countSearchWithStatement(stmtFn, query, filter);
    if (total === 0) return { results: [], total: 0 };
    return { results: searchFn(query, filter, { limit }), total };
  }

  const total = countSearchWithStatement(stmtFn, query, filter);
  if (total === 0) return { results: [], total: 0 };

  const candidates = searchFn(query, filter, {
    limit: SEARCH_CANDIDATE_SCAN_CAP,
  });
  if (candidates.length === 0) return { results: [], total: 0 };

  const candidateById = new Map(candidates.map((c) => [c.id, c]));
  const bm25 = getOrBuildBm25();
  const scored = bm25.score(query, (id) => candidateById.has(id));
  const q = query.trim().toLowerCase();
  const rank = (id: number): number => {
    const name = candidateById.get(id)?.name.toLowerCase() ?? '';
    if (name === q) return 0;
    if (name.startsWith(q)) return 1;
    return 2;
  };
  scored.sort((a, b) => {
    const rankDiff = rank(a.id) - rank(b.id);
    if (rankDiff !== 0) return rankDiff;
    const scoreDiff = b.score - a.score;
    if (scoreDiff !== 0) return scoreDiff;
    const left = expectDefined(candidateById.get(a.id));
    const right = expectDefined(candidateById.get(b.id));
    return (
      left.name.localeCompare(right.name) ||
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.col - right.col ||
      left.id - right.id
    );
  });
  const qTokens = tokenise(query);

  const results = scored.slice(0, limit).map(({ id, score }) => {
    const c = expectDefined(candidateById.get(id));
    return { ...c, score, snippet: bm25.extractSnippet(id, qTokens) };
  });
  return { results, total };
}
