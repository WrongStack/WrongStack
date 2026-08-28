import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_PAGE_STATUSES, VALID_MEMORY_STATUSES } from './shared/pagination.js';
import { sqliteRowsToMemories } from './sqlite-store-search-helpers.js';
import type { Sage, SageStatus } from './types.js';

interface SqliteCompatContext {
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>;
  nowIso: () => string;
  rowToMemory: (row: { data: string }) => Sage;
}

export function listCompatSage(
  ctx: Pick<SqliteCompatContext, 'stmt'>,
  statuses?: SageStatus[],
): Sage[] {
  const effective = statuses && statuses.length > 0 ? statuses : DEFAULT_PAGE_STATUSES;
  const valid = effective.filter((status) => VALID_MEMORY_STATUSES.has(status));
  if (valid.length === 0) return [];
  const placeholders = valid.map(() => '?').join(',');
  const rows = ctx
    .stmt(`SELECT data FROM memories WHERE status IN (${placeholders}) ORDER BY updated_at DESC`)
    .all(...valid) as Array<{ data: string }>;
  return sqliteRowsToMemories(rows);
}

export function getCompatSage(
  ctx: SqliteCompatContext,
  id: string,
): Sage | null {
  const row = ctx.stmt('SELECT data FROM memories WHERE id = ?').get(id) as
    | { data: string }
    | undefined;
  if (!row) return null;
  try {
    return ctx.rowToMemory(row);
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'sage.row_parse_failed',
        id,
        message: err instanceof Error ? err.message : String(err),
        timestamp: ctx.nowIso(),
      }),
    );
    return null;
  }
}
