import type { DatabaseSync } from 'node:sqlite';

import { buildSessionClause } from './sqlite-store-search-helpers.js';
import { sqliteRowsToMemories } from './sqlite-store-search-helpers.js';
import type { MemoryAudienceContext, Sage } from './types.js';

interface SqliteAudienceContext {
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>;
  /**
   * Optional callback fired when the SQL prefilter was saturated: the scan
   * window hit `AUDIENCE_MAX_SCAN` before the corpus ran out, and more
   * audience-matching rows likely exist beyond the scanned range than the
   * caller's limit allowed. Surfaces truncation so a caller can paginate,
   * log, or escalate. Mirrors the `memory.audience_truncated` audit event.
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

/**
 * Maximum rows to scan when paging for rare audience matches. Caps the
 * total work even for very large corpora so the paging loop terminates
 * in bounded time.
 */
const AUDIENCE_MAX_SCAN = 10_000;

export function retrieveSqliteSageForAudience(
  ctx: SqliteAudienceContext,
  context: MemoryAudienceContext,
  opts?: {
    limit?: number | undefined;
    sessionId?: string | undefined;
    includeAllSessions?: boolean | undefined;
  },
): Sage[] {
  const limit = opts?.limit ?? 20;
  const session = buildSessionClause(opts);
  const role = context.role?.toLowerCase() ?? '';
  const taskType = context.taskType?.toLowerCase() ?? '';
  const mode = context.mode?.toLowerCase() ?? '';

  const audienceMatch = (m: Sage): boolean => {
    if (!m.audience) return false;
    const a = m.audience;
    if (a.roles?.length && !a.roles.some((r) => r.toLowerCase() === role)) return false;
    if (a.taskTypes?.length && !a.taskTypes.some((t) => t.toLowerCase() === taskType)) return false;
    if (a.modes?.length && !a.modes.some((m) => m.toLowerCase() === mode)) return false;
    return true;
  };

  // Paging loop: escalate the fetch window until enough matches are found
  // or the maximum scan size is reached. Starts at limit * OVERFETCH_FACTOR,
  // then multiplies by 3 each iteration (factor: 5, 15, 45, ...).
  let offset = 0;
  let windowSize = limit * AUDIENCE_OVERFETCH_FACTOR;
  const matched: Sage[] = [];
  let exhausted = false;
  let totalScanned = 0;

  while (matched.length < limit && offset < AUDIENCE_MAX_SCAN) {
    // Clamp the growing window so AUDIENCE_MAX_SCAN bounds the rows actually
    // scanned — the ×3 growth otherwise lets limit=20 scan ~12k rows and
    // limit=100 scan ~20k rows while the loop guard only caps the offset.
    windowSize = Math.min(windowSize, AUDIENCE_MAX_SCAN - offset);
    if (windowSize <= 0) break;
    const rows = ctx
      .stmt(
        `SELECT data FROM memories
           WHERE status IN ('active','stale')
           AND audience IS NOT NULL${session.clause}
           ORDER BY importance DESC
           LIMIT ? OFFSET ?`,
      )
      // Placeholder order in the SQL above: session clause params come before
      // LIMIT/OFFSET, so bind session params first.
      .all(...session.params, windowSize, offset) as Array<{ data: string }>;

    totalScanned += rows.length;

    // If the SQL returned fewer rows than the window, the corpus is
    // exhausted — no need to page further.
    if (rows.length < windowSize) exhausted = true;

    const pageMatches = sqliteRowsToMemories(rows).filter(audienceMatch);
    matched.push(...pageMatches);

    if (exhausted) break;

    offset += windowSize;
    // Grow the window by 3x each iteration to find rare-role matches
    // without doing a full corpus scan on every call.
    windowSize *= 3;
  }

  const truncated = matched.slice(0, limit);
  // Truncation signal: fire when the corpus was not exhausted (more rows
  // exist beyond what was scanned) AND more matching rows were found than
  // the caller's limit allows. This tells the caller there are additional
  // audience-matching memories beyond what was returned.
  if (!exhausted && totalScanned > 0 && matched.length > truncated.length) {
    ctx.onTruncated?.({ sqlRowsExamined: totalScanned, returned: truncated.length });
  }
  return truncated;
}
