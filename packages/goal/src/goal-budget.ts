/**
 * Operator limits for a Goal run. They are checked before each task starts: a run that has
 * reached a limit stops cleanly (the next task stays pending and resumable) instead of failing.
 * Run time is counted while the run is active and carried across resumes.
 */

export interface GoalBudget {
  /** Tasks the run may start, counted across resumes. */
  maxTasks?: number | undefined;
  /** Minutes of active run time, counted across resumes. */
  maxMinutes?: number | undefined;
  /**
   * Provider tokens reported by the task agents (fresh input, cache reads and writes, and
   * output), counted across resumes. Checked before each task, so the task that crosses the
   * limit finishes.
   */
  maxTokens?: number | undefined;
}

export interface GoalBudgetUsage {
  tasks: number;
  elapsedMs: number;
  /** Absent on runs saved before token counting. */
  tokens?: number | undefined;
}

/** Tokens one provider response counts against a Goal budget. */
export function goalUsageTokens(usage: {
  input?: number | undefined;
  output?: number | undefined;
  cacheRead?: number | undefined;
  cacheWrite?: number | undefined;
}): number {
  return [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].reduce<number>(
    (sum, value) =>
      sum + (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0),
    0,
  );
}

const MAX_TASKS = 10_000;
const MAX_MINUTES = 7 * 24 * 60;
const MAX_TOKENS = 1_000_000_000_000;

/** A budget from untrusted input; undefined when it sets no valid limit. */
export function parseGoalBudget(value: unknown): GoalBudget | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const limit = (field: unknown, max: number) =>
    typeof field === 'number' && Number.isFinite(field) && field > 0 && field <= max
      ? field
      : undefined;
  const maxTasks = limit(raw['maxTasks'], MAX_TASKS);
  const maxMinutes = limit(raw['maxMinutes'], MAX_MINUTES);
  const maxTokens = limit(raw['maxTokens'], MAX_TOKENS);
  const budget: GoalBudget = {
    ...(maxTasks !== undefined ? { maxTasks: Math.floor(maxTasks) } : {}),
    ...(maxMinutes !== undefined ? { maxMinutes } : {}),
    ...(maxTokens !== undefined ? { maxTokens: Math.floor(maxTokens) } : {}),
  };
  return Object.keys(budget).length ? budget : undefined;
}

/** Why the next task may not start, or undefined while the run is within its budget. */
export function goalBudgetExceeded(
  budget: GoalBudget | undefined,
  usage: GoalBudgetUsage,
): string | undefined {
  if (budget?.maxTasks !== undefined && usage.tasks >= budget.maxTasks)
    return `Budget reached: ${usage.tasks} of ${budget.maxTasks} tasks started.`;
  if (budget?.maxMinutes !== undefined && usage.elapsedMs >= budget.maxMinutes * 60_000)
    return `Budget reached: ${Math.floor(usage.elapsedMs / 60_000)} of ${budget.maxMinutes} minutes of run time used.`;
  if (budget?.maxTokens !== undefined && (usage.tokens ?? 0) >= budget.maxTokens)
    return `Budget reached: ${(usage.tokens ?? 0).toLocaleString('en-US')} of ${budget.maxTokens.toLocaleString('en-US')} provider tokens used.`;
  return undefined;
}
