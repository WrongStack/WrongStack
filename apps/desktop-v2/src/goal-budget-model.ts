import { record } from './engine-values';

/**
 * The `budget` of a Goal start or resume from the form's optional limits; undefined when all
 * are empty. Values the engine would ignore are refused here so the user sees why.
 */
export function goalBudgetPayload(
  maxTasks: string,
  maxMinutes: string,
  maxTokens = '',
  maxCostUsd = '',
): { maxTasks?: number; maxMinutes?: number; maxTokens?: number; maxCostUsd?: number } | undefined {
  const parse = (value: string, label: string, max: number, whole: boolean) => {
    if (!value.trim()) return undefined;
    const number = Number(value);
    if (
      !Number.isFinite(number) ||
      number <= 0 ||
      number > max ||
      (whole && !Number.isInteger(number))
    )
      throw Error(
        whole
          ? `${label} must be a whole number from 1 to ${max}.`
          : `${label} must be a number above 0 and at most ${max}.`,
      );
    return number;
  };
  const tasks = parse(maxTasks, 'The task limit', 10_000, true);
  const minutes = parse(maxMinutes, 'The run-time limit', 7 * 24 * 60, false);
  const tokens = parse(maxTokens, 'The token limit', 1_000_000_000_000, true);
  const cost = parse(maxCostUsd, 'The cost limit', 1_000_000, false);
  if (tasks === undefined && minutes === undefined && tokens === undefined && cost === undefined)
    return undefined;
  return {
    ...(tasks !== undefined ? { maxTasks: tasks } : {}),
    ...(minutes !== undefined ? { maxMinutes: minutes } : {}),
    ...(tokens !== undefined ? { maxTokens: tokens } : {}),
    ...(cost !== undefined ? { maxCostUsd: cost } : {}),
  };
}

/** "Budget: 3 of 10 tasks · 12 of 60 min · 9,000 of 50,000 tokens"; empty without a budget. */
export function goalBudgetText(budget: unknown, usage: unknown): string {
  const limits = record(budget);
  const used = record(usage);
  const tasks = typeof used['tasks'] === 'number' ? used['tasks'] : 0;
  const minutes =
    typeof used['elapsedMs'] === 'number' ? Math.floor(used['elapsedMs'] / 60_000) : 0;
  const parts = [
    typeof limits['maxTasks'] === 'number' ? `${tasks} of ${limits['maxTasks']} tasks` : '',
    typeof limits['maxMinutes'] === 'number' ? `${minutes} of ${limits['maxMinutes']} min` : '',
    typeof limits['maxTokens'] === 'number'
      ? `${(typeof used['tokens'] === 'number' ? used['tokens'] : 0).toLocaleString('en-US')} of ${limits['maxTokens'].toLocaleString('en-US')} tokens`
      : '',
    typeof limits['maxCostUsd'] === 'number'
      ? `~$${(typeof used['costUsd'] === 'number' ? used['costUsd'] : 0).toFixed(2)} of $${limits['maxCostUsd']} estimated${
          typeof used['unpricedResponses'] === 'number' && used['unpricedResponses'] > 0
            ? ` (${used['unpricedResponses']} unpriced responses)`
            : ''
        }`
      : '',
  ].filter(Boolean);
  return parts.length ? `Budget: ${parts.join(' · ')}` : '';
}
