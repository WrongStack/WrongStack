import { record } from './engine-values';

export type GoalLimit = 'tasks' | 'minutes' | 'tokens' | 'cost';

/** How budget limits and usage are worded; English by default. */
export interface GoalBudgetWords {
  tasks: (used: number, max: number) => string;
  minutes: (used: number, max: number) => string;
  tokens: (used: string, max: string) => string;
  /** `unpriced` counts responses whose model had no price; 0 when every response was priced. */
  cost: (used: string, max: number, unpriced: number) => string;
  budget: (parts: string) => string;
  /** Why a typed limit is refused. */
  invalid: (limit: GoalLimit, max: number) => string;
}

const limitNames: Record<GoalLimit, string> = {
  tasks: 'The task limit',
  minutes: 'The run-time limit',
  tokens: 'The token limit',
  cost: 'The cost limit',
};
const englishGoalBudgetWords: GoalBudgetWords = {
  tasks: (used, max) => `${used} of ${max} tasks`,
  minutes: (used, max) => `${used} of ${max} min`,
  tokens: (used, max) => `${used} of ${max} tokens`,
  cost: (used, max, unpriced) =>
    `~$${used} of $${max} estimated${unpriced > 0 ? ` (${unpriced} unpriced responses)` : ''}`,
  budget: (parts) => `Budget: ${parts}`,
  invalid: (limit, max) =>
    limit === 'tasks' || limit === 'tokens'
      ? `${limitNames[limit]} must be a whole number from 1 to ${max}.`
      : `${limitNames[limit]} must be a number above 0 and at most ${max}.`,
};

/**
 * The `budget` of a Goal start or resume from the form's optional limits; undefined when all
 * are empty. Values the engine would ignore are refused here so the user sees why.
 */
export function goalBudgetPayload(
  maxTasks: string,
  maxMinutes: string,
  maxTokens = '',
  maxCostUsd = '',
  words: GoalBudgetWords = englishGoalBudgetWords,
): { maxTasks?: number; maxMinutes?: number; maxTokens?: number; maxCostUsd?: number } | undefined {
  const parse = (value: string, limit: GoalLimit, max: number, whole: boolean) => {
    if (!value.trim()) return undefined;
    const number = Number(value);
    if (
      !Number.isFinite(number) ||
      number <= 0 ||
      number > max ||
      (whole && !Number.isInteger(number))
    )
      throw Error(words.invalid(limit, max));
    return number;
  };
  const tasks = parse(maxTasks, 'tasks', 10_000, true);
  const minutes = parse(maxMinutes, 'minutes', 7 * 24 * 60, false);
  const tokens = parse(maxTokens, 'tokens', 1_000_000_000_000, true);
  const cost = parse(maxCostUsd, 'cost', 1_000_000, false);
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
export function goalBudgetText(
  budget: unknown,
  usage: unknown,
  words: GoalBudgetWords = englishGoalBudgetWords,
): string {
  const limits = record(budget);
  const used = record(usage);
  const tasks = typeof used['tasks'] === 'number' ? used['tasks'] : 0;
  const minutes =
    typeof used['elapsedMs'] === 'number' ? Math.floor(used['elapsedMs'] / 60_000) : 0;
  const parts = [
    typeof limits['maxTasks'] === 'number' ? words.tasks(tasks, limits['maxTasks']) : '',
    typeof limits['maxMinutes'] === 'number' ? words.minutes(minutes, limits['maxMinutes']) : '',
    typeof limits['maxTokens'] === 'number'
      ? words.tokens(
          (typeof used['tokens'] === 'number' ? used['tokens'] : 0).toLocaleString('en-US'),
          limits['maxTokens'].toLocaleString('en-US'),
        )
      : '',
    typeof limits['maxCostUsd'] === 'number'
      ? words.cost(
          (typeof used['costUsd'] === 'number' ? used['costUsd'] : 0).toFixed(2),
          limits['maxCostUsd'],
          typeof used['unpricedResponses'] === 'number' ? used['unpricedResponses'] : 0,
        )
      : '',
  ].filter(Boolean);
  return parts.length ? words.budget(parts.join(' · ')) : '';
}
