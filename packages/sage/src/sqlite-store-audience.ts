import type { DatabaseSync } from 'node:sqlite';

import { sqliteRowsToMemories } from './sqlite-store-search-helpers.js';
import type { MemoryAudienceContext, Sage } from './types.js';

export interface SqliteAudienceContext {
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>;
  /**
   * Optional callback fired when the SQL prefilter is fully exhausted
   * but more matching rows likely exist beyond the over-fetch factor.
   * Surfaces truncation so a caller can paginate, log, or escalate.
   */
  onTruncated?: ((info: { sqlRowsExamined: number; returned: number }) => void) | undefined;
}

/**
 * Audience retrieval over-fetch factor. The SQL prefilter pulls this
 * many rows beyond the requested limit to compensate for rows that
 * fail the JS-side audience match. With factor=5 and limit=20 the
 * prefilter pulls 100 rows, leaving headroom even for narrow role/task
 * filters without losing ordering by importance.
 */
const AUDIENCE_OVERFETCH_FACTOR = 5;

export function retrieveSqliteSageForAudience(
  ctx: SqliteAudienceContext,
  context: MemoryAudienceContext,
  opts?: { limit?: number },
): Sage[] {
  const limit = opts?.limit ?? 20;
  const role = context.role?.toLowerCase() ?? '';
  const taskType = context.taskType?.toLowerCase() ?? '';
  const mode = context.mode?.toLowerCase() ?? '';

  // Over-fetch by AUDIENCE_OVERFETCH_FACTOR x the requested limit instead
  // of the previous hard-coded 1000. The old value was both arbitrary
  // (silently truncating large corpora) and uncorrelated with the
  // caller's requested limit (a small `limit` could over-fetch by 50x).
  const prefilterSize = limit * AUDIENCE_OVERFETCH_FACTOR;
  const rows = ctx
    .stmt(
      `SELECT data FROM memories
         WHERE status IN ('active','stale')
         AND audience IS NOT NULL
         ORDER BY importance DESC
         LIMIT ?`,
    )
    .all(prefilterSize) as Array<{ data: string }>;

  const matched = sqliteRowsToMemories(rows).filter((m) => {
    if (!m.audience) return false;
    const a = m.audience;
    if (a.roles?.length && !a.roles.some((r) => r.toLowerCase() === role)) return false;
    if (a.taskTypes?.length && !a.taskTypes.some((t) => t.toLowerCase() === taskType))
      return false;
    if (a.modes?.length && !a.modes.some((m) => m.toLowerCase() === mode)) return false;
    return true;
  });
  const truncated = matched.slice(0, limit);
  // Truncation signal: only fire when the SQL prefilter was fully
  // exhausted AND more matching rows likely live past it. With the
  // 5x over-fetch factor this fires mostly for narrow filters (e.g.
  // a single role match out of thousands) — exactly the case where
  // the caller should know.
  if (rows.length >= prefilterSize && matched.length > truncated.length) {
    ctx.onTruncated?.({ sqlRowsExamined: rows.length, returned: truncated.length });
  }
  return truncated;
}
