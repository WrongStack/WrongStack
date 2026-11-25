import { describe, expect, it } from 'vitest';
import { goalBudgetExceeded } from '../src/goal-budget.js';

describe('goalBudgetExceeded non-finite limit guard', () => {
  it('fails closed when a configured budget limit is NaN', () => {
    expect(
      goalBudgetExceeded({ maxCostUsd: Number.NaN }, { tasks: 0, elapsedMs: 0, costUsd: 999999 }),
    ).toBeDefined();
    expect(
      goalBudgetExceeded({ maxCostUsd: 10 }, { tasks: 0, elapsedMs: 0, costUsd: 5 }),
    ).toBeUndefined();
  });
});
