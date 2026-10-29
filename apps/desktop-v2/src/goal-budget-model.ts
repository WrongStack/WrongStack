import { record } from './engine-values';

/**
 * The `budget` of a Goal start or resume from the form's optional limits; undefined when both
 * are empty. Values the engine would ignore are refused here so the user sees why.
 */
export function goalBudgetPayload(
  maxTasks: string,
  maxMinutes: string,
): { maxTasks?: number; maxMinutes?: number } | undefined {
  const parse = (value: string, label: string, max: number, whole: boolean) => {
    if (!value.trim()) return undefined;
    const number = Number(value);
    if (
      !Number.isFinite(number) ||
      number <= 0 ||
      number > max ||
      (whole && !Number.isInteger(number))
    )
      throw Error(`${label} must be ${whole ? 'a whole number' : 'a number'} from 1 to ${max}.`);
    return number;
  };
  const tasks = parse(maxTasks, 'The task limit', 10_000, true);
  const minutes = parse(maxMinutes, 'The run-time limit', 7 * 24 * 60, false);
  if (tasks === undefined && minutes === undefined) return undefined;
  return {
    ...(tasks !== undefined ? { maxTasks: tasks } : {}),
    ...(minutes !== undefined ? { maxMinutes: minutes } : {}),
  };
}

/** "Budget: 3 of 10 tasks · 12 of 60 min" from a Goal state; empty without a budget. */
export function goalBudgetText(budget: unknown, usage: unknown): string {
  const limits = record(budget);
  const used = record(usage);
  const tasks = typeof used['tasks'] === 'number' ? used['tasks'] : 0;
  const minutes =
    typeof used['elapsedMs'] === 'number' ? Math.floor(used['elapsedMs'] / 60_000) : 0;
  const parts = [
    typeof limits['maxTasks'] === 'number' ? `${tasks} of ${limits['maxTasks']} tasks` : '',
    typeof limits['maxMinutes'] === 'number' ? `${minutes} of ${limits['maxMinutes']} min` : '',
  ].filter(Boolean);
  return parts.length ? `Budget: ${parts.join(' · ')}` : '';
}
