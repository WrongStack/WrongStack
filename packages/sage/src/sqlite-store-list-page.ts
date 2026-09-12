import type { DatabaseSync } from 'node:sqlite';

import {
  clampPageLimit,
  DEFAULT_PAGE_STATUSES,
  VALID_MEMORY_STATUSES,
} from './shared/pagination.js';
import { decodePageCursor, escapeLikePattern } from './sqlite-store-pagination.js';
import {
  buildSessionClause,
  countRowsByField,
  finalizeListSagePage,
  type SqliteCountRow,
  type SqlitePageRow,
} from './sqlite-store-search-helpers.js';
import type { ListSagePageOptions, ListSagePageResult } from './types.js';

interface SqliteListSagePageContext {
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>;
}

export function listSqliteSagePage(
  ctx: SqliteListSagePageContext,
  options: ListSagePageOptions = {},
): ListSagePageResult {
  const session = buildSessionClause(options);
  const sessionPredicate = session.clause.replace(/^\s*AND\s+/i, '');
  const statusVisibility = sessionPredicate ? ` WHERE ${sessionPredicate}` : '';
  const statusRows = ctx
    .stmt(`SELECT status, COUNT(*) AS n FROM memories${statusVisibility} GROUP BY status`)
    .all(...session.params) as SqliteCountRow[];
  const statusCounts = countRowsByField(statusRows, 'status');

  const requested =
    options.statuses && options.statuses.length > 0
      ? options.statuses.filter((s) => VALID_MEMORY_STATUSES.has(s))
      : DEFAULT_PAGE_STATUSES;
  const statuses = requested.length > 0 ? requested : DEFAULT_PAGE_STATUSES;
  const kind = options.kind && options.kind !== 'all' ? options.kind : undefined;
  const query = options.query?.trim().normalize('NFKC').toLowerCase();
  const limit = clampPageLimit(options.limit);

  const where: string[] = [];
  const params: unknown[] = [];

  where.push(`status IN (${statuses.map(() => '?').join(',')})`);
  params.push(...statuses);
  if (kind) {
    where.push('kind = ?');
    params.push(kind);
  }
  if (query) {
    where.push("sage_unicode_lower(json_extract(data, '$.text')) LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLikePattern(query)}%`);
  }
  // Session isolation, the same rule every other retrieval surface applies.
  // This is the bulk enumerator — up to 500 rows a page, cursor-paged across
  // the whole corpus — so without it one session can page through every other
  // session's private memories.
  if (sessionPredicate) {
    where.push(sessionPredicate);
    params.push(...session.params);
  }

  const whereClause = `WHERE ${where.join(' AND ')}`;
  const totalRow = ctx
    .stmt(`SELECT COUNT(*) AS n FROM memories ${whereClause}`)
    .get(...(params as (string | number)[])) as { n: number };
  const total = totalRow.n;

  const cursor = decodePageCursor(options.cursor);
  const pageParams = [...params];
  let cursorClause = '';
  if (cursor) {
    cursorClause = ' AND (updated_at < ? OR (updated_at = ? AND id < ?))';
    pageParams.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
  }

  const rows = ctx
    .stmt(
      `SELECT data, updated_at, id FROM memories ${whereClause}${cursorClause}
         ORDER BY updated_at DESC, id DESC
         LIMIT ?`,
    )
    .all(...(pageParams as (string | number)[]), limit + 1) as SqlitePageRow[];

  return finalizeListSagePage(rows, limit, total, statusCounts);
}
