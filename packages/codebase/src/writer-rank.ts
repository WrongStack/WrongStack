/**
 * Persistence for the graph centrality layer (`symbol_rank`, `file_rank`).
 *
 * Ranks are always written as a whole: the score is a property of the entire
 * graph, so a partial update would leave the table describing a graph that no
 * longer exists. Both writers therefore delete and re-insert rather than
 * upserting row by row — at ~66k symbols that is a single fast statement plus
 * a ladder-chunked bulk insert, well inside the index run's existing budget.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { FileRankRow, SymbolRankRow } from './graph-rank.js';
import { LANG_FAMILY_ENTRIES } from './languages.js';
import { MODULE_OWNER_NAME } from './schema.js';
import { allRowsAsArrays } from './sqlite-runtime.js';
import { ladderChunkSizes } from './writer-helpers.js';
import { LANG_FAMILY_WILDCARD } from './writer-schema.js';

type Statement = ReturnType<DatabaseSync['prepare']>;
type PrepareStatement = (sql: string) => Statement;

const ROW_PLACEHOLDERS_CACHE = new Map<string, string>();

function getRowPlaceholders(rowTemplate: string, count: number): string {
  const key = `${rowTemplate}\u0000${count}`;
  let result = ROW_PLACEHOLDERS_CACHE.get(key);
  if (result === undefined) {
    result = Array.from({ length: count }, () => rowTemplate).join(', ');
    ROW_PLACEHOLDERS_CACHE.set(key, result);
  }
  return result;
}

/** Replace the whole `symbol_rank` table with `rows`. */
export function replaceSymbolRanksWithStatement(
  stmt: PrepareStatement,
  maxSqlVars: number,
  rows: readonly SymbolRankRow[],
): void {
  stmt('DELETE FROM symbol_rank').run();
  if (rows.length === 0) return;
  const ladder = ladderChunkSizes(rows.length, Math.max(1, Math.floor(maxSqlVars / 4)));
  let cursor = 0;
  for (const take of ladder) {
    const chunk = rows.slice(cursor, cursor + take);
    cursor += take;
    const placeholders = getRowPlaceholders('(?, ?, ?, ?)', chunk.length);
    const insert = stmt(
      `INSERT INTO symbol_rank(symbol_id, rank, in_deg, out_deg) VALUES ${placeholders}`,
    );
    const binds: number[] = [];
    for (const row of chunk) binds.push(row.symbolId, row.rank, row.inDeg, row.outDeg);
    insert.run(...binds);
  }
}

/** Replace the whole `file_rank` table with `rows`. */
export function replaceFileRanksWithStatement(
  stmt: PrepareStatement,
  maxSqlVars: number,
  rows: readonly FileRankRow[],
): void {
  stmt('DELETE FROM file_rank').run();
  if (rows.length === 0) return;
  const ladder = ladderChunkSizes(rows.length, Math.max(1, Math.floor(maxSqlVars / 4)));
  let cursor = 0;
  for (const take of ladder) {
    const chunk = rows.slice(cursor, cursor + take);
    cursor += take;
    const placeholders = getRowPlaceholders('(?, ?, ?, ?)', chunk.length);
    const insert = stmt(
      `INSERT INTO file_rank(file, rank, in_deg, out_deg) VALUES ${placeholders}`,
    );
    const binds: (string | number)[] = [];
    for (const row of chunk) binds.push(row.file, row.rank, row.inDeg, row.outDeg);
    insert.run(...binds);
  }
}

/**
 * Highest-ranked files, most central first.
 *
 * `limit` is applied in SQL — this is a plain single-table read, so none of
 * the chunked-query constraints that forbid `LIMIT` elsewhere apply here.
 */
export function getTopFileRanksWithStatement(stmt: PrepareStatement, limit: number): FileRankRow[] {
  if (limit <= 0) return [];
  return stmt(
    'SELECT file, rank, in_deg AS inDeg, out_deg AS outDeg FROM file_rank ORDER BY rank DESC, file ASC LIMIT ?',
  ).all(limit) as unknown as FileRankRow[];
}

/** A ranked file joined with the metadata the repo map needs to group it. */
export interface RankedFileRow extends FileRankRow {
  /** Code Atlas grouping label from `files.package` — '' when unlabelled. */
  package: string;
  lang: string;
  symbolCount: number;
}

/**
 * Highest-ranked files with their package label, for repo-map clustering.
 *
 * Joined here rather than in two round trips because the repo map always
 * needs both, and `file_rank` is keyed by the same absolute path as `files`.
 */
export function getRankedFilesWithStatement(
  stmt: PrepareStatement,
  limit: number,
): RankedFileRow[] {
  if (limit <= 0) return [];
  return stmt(`
    SELECT fr.file AS file, fr.rank AS rank, fr.in_deg AS inDeg, fr.out_deg AS outDeg,
           f.package AS package, f.lang AS lang, f.symbol_count AS symbolCount
    FROM file_rank fr
    JOIN files f ON f.file = fr.file
    ORDER BY fr.rank DESC, fr.file ASC
    LIMIT ?
  `).all(limit) as unknown as RankedFileRow[];
}

/**
 * True indexed-file count per package label.
 *
 * The repo map only fetches its top few hundred ranked files, so counting
 * cluster membership from that slice would report "core has 154 files" for a
 * package with thousands. The count has to come from `files` itself.
 */
export function getPackageFileCountsWithStatement(stmt: PrepareStatement): Map<string, number> {
  const rows = stmt('SELECT package, COUNT(*) AS n FROM files GROUP BY package').all() as Array<{
    package: string;
    n: number;
  }>;
  const map = new Map<string, number>();
  for (const row of rows) map.set(row.package, row.n);
  return map;
}

/** Highest-ranked symbols, most central first. */
export function getTopSymbolRanksWithStatement(
  stmt: PrepareStatement,
  limit: number,
): SymbolRankRow[] {
  if (limit <= 0) return [];
  return stmt(
    'SELECT symbol_id AS symbolId, rank, in_deg AS inDeg, out_deg AS outDeg FROM symbol_rank ORDER BY rank DESC, symbol_id ASC LIMIT ?',
  ).all(limit) as unknown as SymbolRankRow[];
}

/**
 * How many symbols declare each ambiguous symbol's name, keyed by symbol id.
 *
 * Counted per `(name, language family)` because that is exactly the scope ref
 * resolution matches within (`FAMILY_MATCH_SQL`) — a Go `Read` and a
 * TypeScript `Read` never compete for the same ref, so counting them together
 * would understate the confidence of both.
 *
 * Only names with more than one declaration are returned: on this repo that
 * is roughly a seventh of all names, so the map stays small and every absent
 * id means "unambiguous, full weight".
 */
export function getSymbolNameCandidatesWithStatement(stmt: PrepareStatement): Map<number, number> {
  const rows = stmt(`
    SELECT s.id AS symbolId, g.c AS candidates
    FROM symbols s
    JOIN lang_family lf ON lf.lang = s.lang
    JOIN (
      SELECT s2.name AS name, lf2.family AS family, COUNT(*) AS c
      FROM symbols s2
      JOIN lang_family lf2 ON lf2.lang = s2.lang
      GROUP BY s2.name, lf2.family
      HAVING COUNT(*) > 1
    ) g ON g.name = s.name AND g.family = lf.family
  `).all() as Array<{ symbolId: number; candidates: number }>;
  const map = new Map<number, number>();
  for (const row of rows) map.set(row.symbolId, row.candidates);
  return map;
}

/** `lang → family` exactly as the seeded `lang_family` table maps it. */
const FAMILY_BY_LANG: ReadonlyMap<string, string> = new Map<string, string>([
  ...LANG_FAMILY_ENTRIES,
  ['', LANG_FAMILY_WILDCARD],
]);

/**
 * Both per-symbol inputs of the wiring graph from ONE scan of `symbols`:
 * the declaring file of every symbol, and the homonym counts of
 * {@link getSymbolNameCandidatesWithStatement} (same `(name, family)` scope,
 * same "only ambiguous names" rule). The rank pass used to load every column
 * of every symbol just for its file (~650 ms here) and then run a grouped
 * self-join for the counts (~480 ms); four narrow columns and one Map pass do
 * both in a fraction of that.
 */
export function getSymbolGraphFactsWithStatement(stmt: PrepareStatement): {
  fileOf: Map<number, string>;
  candidates: Map<number, number>;
  shadowedModules: Set<number>;
} {
  const rows = allRowsAsArrays(stmt('SELECT id, file, name, lang FROM symbols')) as Array<
    [number, string, string, string]
  >;
  const fileOf = new Map<number, string>();
  const groups = new Map<string, number[]>();
  const moduleOf = new Map<string, number>();
  const declaring = new Set<string>();
  for (const [id, file, name, lang] of rows) {
    fileOf.set(id, file);
    if (name === MODULE_OWNER_NAME) moduleOf.set(file, id);
    else declaring.add(file);
    // The SQL form inner-joins lang_family: an unmapped language takes no part.
    const family = FAMILY_BY_LANG.get(lang);
    if (family === undefined) continue;
    const key = `${family}\u0000${name}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [id]);
    else group.push(id);
  }
  const candidates = new Map<number, number>();
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    for (const id of ids) candidates.set(id, ids.length);
  }
  // A file that declares symbols also owns its imports through `<module>`;
  // as a rank node it would split the file's mass across an extra symbol and
  // double-count each import its declarations already use.
  const shadowedModules = new Set<number>();
  for (const [file, id] of moduleOf) if (declaring.has(file)) shadowedModules.add(id);
  return { fileOf, candidates, shadowedModules };
}

/**
 * File-to-file import edges, as `source file → set of imported files`.
 *
 * Built from the import refs the module resolver managed to resolve to a real
 * path (`refs.to_file`). Used by the rank pass to tell a cross-file reference
 * that is genuinely visible from one the resolver merely guessed at.
 */
export function getImportVisibilityWithStatement(stmt: PrepareStatement): Map<string, Set<string>> {
  const rows = allRowsAsArrays(
    stmt(`
    SELECT DISTINCT s.file AS src, r.to_file AS dst
    FROM refs r
    JOIN symbols s ON s.id = r.from_id
    WHERE r.call_type = 'import' AND r.to_file IS NOT NULL AND r.to_file <> ''
  `),
  ) as Array<[string, string]>;
  const map = new Map<string, Set<string>>();
  for (const [src, dst] of rows) {
    let targets = map.get(src);
    if (targets === undefined) {
      targets = new Set<string>();
      map.set(src, targets);
    }
    targets.add(dst);
  }
  return map;
}

/** Whole-table `file → rank` lookup, for joining ranks onto graph reads. */
export function getFileRankMapWithStatement(stmt: PrepareStatement): Map<string, number> {
  const rows = stmt('SELECT file, rank FROM file_rank').all() as Array<{
    file: string;
    rank: number;
  }>;
  const map = new Map<string, number>();
  for (const row of rows) map.set(row.file, row.rank);
  return map;
}

/** Row counts, for index stats and for deciding whether the layer is populated. */
export function getRankCountsWithStatement(stmt: PrepareStatement): {
  symbols: number;
  files: number;
} {
  const symbols = Number(
    (stmt('SELECT COUNT(*) AS n FROM symbol_rank').get() as { n?: number } | undefined)?.n ?? 0,
  );
  const files = Number(
    (stmt('SELECT COUNT(*) AS n FROM file_rank').get() as { n?: number } | undefined)?.n ?? 0,
  );
  return { symbols, files };
}
