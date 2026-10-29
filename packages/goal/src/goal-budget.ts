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
}

export interface GoalBudgetUsage {
  tasks: number;
  elapsedMs: number;
}

const MAX_TASKS = 10_000;
const MAX_MINUTES = 7 * 24 * 60;

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
  const budget: GoalBudget = {
    ...(maxTasks !== undefined ? { maxTasks: Math.floor(maxTasks) } : {}),
    ...(maxMinutes !== undefined ? { maxMinutes } : {}),
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
  return undefined;
}
