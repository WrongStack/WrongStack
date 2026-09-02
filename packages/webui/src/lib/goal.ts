// ── Goal types + parsing ─────────────────────────────────────────────────────
// Pure, dependency-free module shared by the GoalPanel component and the goal
// store. Kept out of GoalPanel.tsx so non-React consumers (stores, tests under
// the root vitest config which has no `@` alias) don't pull in React/lucide.

export interface GoalDeliverable {
  id: string;
  text: string;
  status: 'pending' | 'done';
}

export interface GoalJournalEntry {
  iteration: number;
  task?: string | undefined;
  status?: string | undefined;
  progress?: number | undefined;
  progressNote?: string | undefined;
  timestamp?: string | undefined;
}

export interface GoalState {
  goal: string;
  refinedGoal?: string | undefined;
  goalState: 'active' | 'paused' | 'completed' | 'failed' | 'abandoned';
  iterations: number;
  progress: number;
  progressNote?: string | undefined;
  progressTrend?: 'up' | 'down' | 'stable' | undefined;
  deliverables?: GoalDeliverable[] | undefined;
  journal?: GoalJournalEntry[] | undefined;
  lastTask?: string | undefined;
  lastStatus?: string | undefined;
}

/**
 * Type guard for a journal entry. The server sends journal rows on every
 * iteration, and GoalPanel renders `entry.iteration` as both the React
 * `key` and the row label (`#{entry.iteration}`). If a malformed row
 * slips through with `iteration === undefined` or a non-number, React
 * warns about non-unique keys and the UI shows `#{undefined}`.
 *
 * Drop the entry rather than guess. The required `iteration` field is
 * validated strictly; optional string/number fields are accepted only
 * when their type matches the `GoalJournalEntry` contract.
 */
function isGoalJournalEntry(x: unknown): x is GoalJournalEntry {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
  const e = x as Record<string, unknown>;
  if (typeof e.iteration !== 'number' || !Number.isFinite(e.iteration)) return false;
  if (e.task !== undefined && typeof e.task !== 'string') return false;
  if (e.status !== undefined && typeof e.status !== 'string') return false;
  if (e.progress !== undefined && (typeof e.progress !== 'number' || !Number.isFinite(e.progress)))
    return false;
  if (e.progressNote !== undefined && typeof e.progressNote !== 'string') return false;
  if (e.timestamp !== undefined && typeof e.timestamp !== 'string') return false;
  return true;
}

/**
 * Formats raw goal JSON from the server into a GoalState.
 * Gracefully handles missing / partial data.
 */
export function parseGoalState(raw: Record<string, unknown> | null): GoalState | null {
  if (!raw || typeof raw.goal !== 'string' || !raw.goal.trim()) return null;
  return {
    goal: raw.goal as string,
    refinedGoal: typeof raw.refinedGoal === 'string' ? raw.refinedGoal : undefined,
    goalState: (['active', 'paused', 'completed', 'failed', 'abandoned'].includes(
      raw.goalState as string,
    )
      ? (raw.goalState as GoalState['goalState'])
      : 'active') as GoalState['goalState'],
    iterations: typeof raw.iterations === 'number' ? raw.iterations : 0,
    progress: typeof raw.progress === 'number' ? raw.progress : 0,
    progressNote: typeof raw.progressNote === 'string' ? raw.progressNote : undefined,
    progressTrend:
      raw.progressTrend === 'accelerating'
        ? 'up'
        : raw.progressTrend === 'stalling'
          ? 'down'
          : raw.progressTrend === 'steady'
            ? 'stable'
            : undefined,
    deliverables: Array.isArray(raw.deliverables)
      ? (raw.deliverables as unknown[]).map((d, i) =>
          typeof d === 'string'
            ? {
                id: `d${i}`,
                text: d,
                status: /^\[[x✓]\]|✅|\(done\)/i.test(d) ? ('done' as const) : ('pending' as const),
              }
            : (d as GoalDeliverable),
        )
      : undefined,
    journal: Array.isArray(raw.journal)
      ? (raw.journal as unknown[]).filter(isGoalJournalEntry)
      : undefined,
    lastTask: typeof raw.lastTask === 'string' ? raw.lastTask : undefined,
    lastStatus: typeof raw.lastStatus === 'string' ? raw.lastStatus : undefined,
  };
}
