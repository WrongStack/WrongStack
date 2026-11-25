import { describe, expect, it } from 'vitest';
import { evaluateBudgets } from '../src/alert-budgets.js';

describe('evaluateBudgets non-finite spend guard', () => {
  it('ignores Infinity spend instead of emitting $Infinity alerts', () => {
    const firings = evaluateBudgets(
      null,
      {
        dailyBudgetUsd: 10,
        projectDailyBudgetsUsd: { p1: 5 },
        machineDailyBudgetsUsd: { 'host:m1': 5 },
      },
      {
        windowMs: 86_400_000,
        totalUsd: Number.POSITIVE_INFINITY,
        byProject: new Map([['p1', Number.POSITIVE_INFINITY]]),
        byMachine: new Map([['host:m1', Number.POSITIVE_INFINITY]]),
      },
    );
    expect(firings).toEqual([]);
  });
});
