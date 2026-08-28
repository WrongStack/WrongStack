import type { DatabaseSync } from 'node:sqlite';

import { boundedLimit, MAX_PAGE_LIMIT } from './shared/pagination.js';
import { sqliteRowsToMemories } from './sqlite-store-search-helpers.js';
import type { Sage, SageStatus } from './types.js';

interface SqliteListMemoriesContext {
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>;
}

interface SqliteListMemoriesOptions {
  status?: SageStatus | 'all';
  kind?: string;
  limit?: number;
  offset?: number;
}

export function listSqliteMemories(
  ctx: SqliteListMemoriesContext,
  opts?: SqliteListMemoriesOptions,
): Sage[] {
  const limit = boundedLimit(opts?.limit, 100, MAX_PAGE_LIMIT);
  const offset = opts?.offset ?? 0;
  const status = opts?.status ?? 'all';
  const kind = opts?.kind;

  let sql = 'SELECT data FROM memories WHERE 1=1';
  const params: unknown[] = [];
  if (status !== 'all') {
    sql += ' AND status = ?';
    params.push(status);
  }
  if (kind && kind !== 'all') {
    sql += ' AND kind = ?';
    params.push(kind);
  }
  sql += ' ORDER BY updated_at DESC';
  if (limit > 0) {
    sql += ' LIMIT ? OFFSET ?';
    params.push(limit, offset);
  }

  const rows = ctx.stmt(sql).all(...(params as (string | number)[])) as Array<{
    data: string;
  }>;
  return sqliteRowsToMemories(rows);
}
