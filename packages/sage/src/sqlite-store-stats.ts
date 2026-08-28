import type { DatabaseSync } from 'node:sqlite';

import { buildSageStats, type SqliteCountRow } from './sqlite-store-search-helpers.js';
import type { SageStats } from './types.js';

interface SqliteStatsContext {
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>;
}

export function getSqliteSageStats(ctx: SqliteStatsContext): SageStats {
  const totalRow = ctx.stmt('SELECT COUNT(*) AS n FROM memories').get() as { n: number };
  const statusRows = ctx
    .stmt('SELECT status, COUNT(*) AS n FROM memories GROUP BY status')
    .all() as SqliteCountRow[];

  const kindRows = ctx
    .stmt('SELECT kind, COUNT(*) AS n FROM memories GROUP BY kind')
    .all() as SqliteCountRow[];

  const edgeRow = ctx.stmt('SELECT COUNT(*) AS n FROM edges').get() as { n: number };

  return buildSageStats({
    total: totalRow.n,
    statusRows,
    kindRows,
    edges: edgeRow.n,
  });
}
