import type { DatabaseSync } from 'node:sqlite';

import { sqliteRowsToMemories } from './sqlite-store-search-helpers.js';
import type { MemoryAudienceContext, Sage } from './types.js';

export interface SqliteAudienceContext {
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>;
}

export function retrieveSqliteSageForAudience(
  ctx: SqliteAudienceContext,
  context: MemoryAudienceContext,
  opts?: { limit?: number },
): Sage[] {
  const limit = opts?.limit ?? 20;
  const role = context.role?.toLowerCase() ?? '';
  const taskType = context.taskType?.toLowerCase() ?? '';
  const mode = context.mode?.toLowerCase() ?? '';

  const rows = ctx
    .stmt(
      `SELECT data FROM memories
         WHERE status IN ('active','stale')
         AND audience IS NOT NULL
         ORDER BY importance DESC
         LIMIT ?`,
    )
    .all(1000) as Array<{ data: string }>;

  return sqliteRowsToMemories(rows)
    .filter((m) => {
      if (!m.audience) return false;
      const a = m.audience;
      if (a.roles?.length && !a.roles.some((r) => r.toLowerCase() === role)) return false;
      if (a.taskTypes?.length && !a.taskTypes.some((t) => t.toLowerCase() === taskType))
        return false;
      if (a.modes?.length && !a.modes.some((m) => m.toLowerCase() === mode)) return false;
      return true;
    })
    .slice(0, limit);
}
