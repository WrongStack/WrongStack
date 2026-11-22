import type { DatabaseSync } from 'node:sqlite';
import { allRowsAsArrays } from './sqlite-runtime.js';
import type { WriterSymbolGraphRow } from './writer-graph-helpers.js';
import {
  indexedFileMatchArgs,
  indexedFileMatchSql,
  inListChunks,
  padToInBucket,
  placeholders,
} from './writer-helpers.js';

type Statement = ReturnType<DatabaseSync['prepare']>;
export type PrepareStatement = (sql: string) => Statement;

/** Stay under typical SQLite SQLITE_MAX_VARIABLE_NUMBER (often 999). */
export const MAX_SQL_VARS = 900;

/**
 * Run a query that takes a list of IDs, chunking the IDs so the total
 * placeholder count never exceeds SQLite's variable limit.
 *
 * IMPORTANT: the SQL built by `buildSql` MUST NOT include a `LIMIT` clause.
 * Applying LIMIT per-chunk would silently cap results at the chunk boundary
 * rather than the caller's ceiling. Callers must slice the returned array
 * to enforce their own limit after merge.
 *
 * P4.12: chunk sizes and each chunk's placeholder count come from a
 * powers-of-two ladder + padToInBucket, so `buildSql` resolves to a small
 * fixed set of SQL strings instead of one per distinct id count.
 */
export function chunkedIdQuery(
  stmt: PrepareStatement,
  ids: readonly number[],
  buildSql: (placeholders: string) => string,
  extraArgs: readonly (string | number)[] = [],
): unknown[] {
  const results: unknown[] = [];
  let cursor = 0;
  for (const take of inListChunks(ids.length, MAX_SQL_VARS)) {
    const chunk = padToInBucket(ids.slice(cursor, cursor + take));
    cursor += take;
    const sql = buildSql(placeholders(chunk.length));
    // A loop, not `push(...rows)`: a spread of a large chunk's rows is one
    // argument per row and overflows the call stack past ~100k.
    for (const row of stmt(sql).all(...chunk, ...extraArgs) as unknown[]) results.push(row);
  }
  return results;
}

/**
 * {@link chunkedIdQuery} returning positional arrays in SELECT order — for
 * the large aggregate reads where node:sqlite's per-row objects are most of
 * the cost (see `allRowsAsArrays`). Same no-LIMIT contract.
 */
export function chunkedIdRows(
  stmt: PrepareStatement,
  ids: readonly number[],
  buildSql: (placeholders: string) => string,
): unknown[][] {
  const results: unknown[][] = [];
  let cursor = 0;
  for (const take of inListChunks(ids.length, MAX_SQL_VARS)) {
    const chunk = padToInBucket(ids.slice(cursor, cursor + take));
    cursor += take;
    for (const row of allRowsAsArrays(
      stmt(buildSql(placeholders(chunk.length))),
      ...(chunk as never[]),
    )) {
      results.push(row);
    }
  }
  return results;
}

/** {@link chunkedIdQuery} for a list of string keys (file paths). Same no-LIMIT contract. */
export function chunkedValueQuery(
  stmt: PrepareStatement,
  values: readonly string[],
  buildSql: (placeholders: string) => string,
): unknown[] {
  const results: unknown[] = [];
  let cursor = 0;
  for (const take of inListChunks(values.length, MAX_SQL_VARS)) {
    const chunk = padToInBucket(values.slice(cursor, cursor + take));
    cursor += take;
    for (const row of stmt(buildSql(placeholders(chunk.length))).all(...chunk) as unknown[]) {
      results.push(row);
    }
  }
  return results;
}

type RefCountRow = { from_id: number; to_id: number; call_type: string; n: number };

/**
 * Resolved ref counts touching `localIds` (as source OR target), grouped by
 * `(from_id, to_id, call_type)`.
 *
 * The graph readers used to bind every scoped file path — twice — in a single
 * `file IN (…)` statement, which overflowed SQLite's bound-variable limit on a
 * broad package filter in a large repository. Two id-partitioned passes stay
 * under it: every group whose source is local lands in exactly one chunk of
 * the first pass, and the second pass keeps only groups whose source is NOT
 * local, so no group is counted twice. (The symbol graph's former
 * `UNION ALL` counted every file-internal ref twice, doubling its weight.)
 */
export function refCountsTouching(
  stmt: PrepareStatement,
  localIds: readonly number[],
): RefCountRow[] {
  const local = new Set(localIds);
  const out: RefCountRow[] = [];
  // Read as arrays and shaped here: a large package touches tens of
  // thousands of ref groups, and node:sqlite's row objects cost more than
  // the query itself.
  for (const [from_id, to_id, call_type, n] of chunkedIdRows(
    stmt,
    localIds,
    (ph) =>
      `SELECT from_id, to_id, call_type, COUNT(*) AS n FROM refs
        WHERE from_id IN (${ph}) AND to_id IS NOT NULL
        GROUP BY from_id, to_id, call_type`,
  ) as Array<[number, number, string, number]>) {
    out.push({ from_id, to_id, call_type, n });
  }
  for (const [from_id, to_id, call_type, n] of chunkedIdRows(
    stmt,
    localIds,
    (ph) =>
      `SELECT from_id, to_id, call_type, COUNT(*) AS n FROM refs
        WHERE to_id IN (${ph})
        GROUP BY from_id, to_id, call_type`,
  ) as Array<[number, number, string, number]>) {
    if (!local.has(from_id)) out.push({ from_id, to_id, call_type, n });
  }
  return out;
}

/**
 * Hydrate symbol rows for an arbitrary id list.
 *
 * The personalised retrieval walk scores dense graph indices and then needs
 * the declarations behind the winners; this is that lookup. Chunked because
 * the id list is unbounded — the caller decides how many nodes to hydrate.
 */
export function getSymbolsByIdsWithStatement(
  stmt: PrepareStatement,
  ids: readonly number[],
): WriterSymbolGraphRow[] {
  if (ids.length === 0) return [];
  return chunkedIdQuery(
    stmt,
    ids,
    (ph) =>
      `SELECT id, name, kind, lang, file, line, signature, scope FROM symbols WHERE id IN (${ph})`,
  ) as WriterSymbolGraphRow[];
}

export function resolveIndexedFiles(stmt: PrepareStatement, file: string): string[] {
  const rows = stmt(
    `SELECT DISTINCT file FROM symbols WHERE ${indexedFileMatchSql('file')} ORDER BY length(file), file`,
  ).all(...indexedFileMatchArgs(file)) as Array<{ file: string }>;
  return rows.map((row) => row.file);
}
