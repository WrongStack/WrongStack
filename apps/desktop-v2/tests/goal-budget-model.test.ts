import { expect, it } from 'vitest';
import { goalBudgetPayload, goalBudgetText } from '../src/goal-budget-model';

it('builds the optional budget and refuses values the engine would ignore', () => {
  expect(goalBudgetPayload('', ' ')).toBeUndefined();
  expect(goalBudgetPayload('5', '')).toEqual({ maxTasks: 5 });
  expect(goalBudgetPayload('', '90')).toEqual({ maxMinutes: 90 });
  expect(() => goalBudgetPayload('2.5', '')).toThrow('whole number');
  expect(() => goalBudgetPayload('0', '')).toThrow('from 1');
  expect(() => goalBudgetPayload('', 'soon')).toThrow('run-time limit');
  expect(() => goalBudgetPayload('', '0')).toThrow('above 0');
});

it('describes the budget and its usage only when a budget is set', () => {
  expect(goalBudgetText(null, null)).toBe('');
  expect(
    goalBudgetText({ maxTasks: 10, maxMinutes: 60 }, { tasks: 3, elapsedMs: 12.5 * 60_000 }),
  ).toBe('Budget: 3 of 10 tasks · 12 of 60 min');
  expect(goalBudgetText({ maxTasks: 4 }, null)).toBe('Budget: 0 of 4 tasks');
});

it('carries a token limit and shows token usage', () => {
  expect(goalBudgetPayload('', '', '50000')).toEqual({ maxTokens: 50_000 });
  expect(() => goalBudgetPayload('', '', '10.5')).toThrow('whole number');
  expect(goalBudgetText({ maxTokens: 50_000 }, { tasks: 2, elapsedMs: 0, tokens: 9_000 })).toBe(
    'Budget: 9,000 of 50,000 tokens',
  );
  // A run saved before token counting reports no token usage yet.
  expect(goalBudgetText({ maxTokens: 1_000 }, { tasks: 0, elapsedMs: 0 })).toBe(
    'Budget: 0 of 1,000 tokens',
  );
});

it('carries a cost limit and shows the estimate with unpriced responses', () => {
  expect(goalBudgetPayload('', '', '', '2.5')).toEqual({ maxCostUsd: 2.5 });
  expect(() => goalBudgetPayload('', '', '', '-1')).toThrow('cost limit');
  expect(goalBudgetText({ maxCostUsd: 2.5 }, { tasks: 1, elapsedMs: 0, costUsd: 0.4567 })).toBe(
    'Budget: ~$0.46 of $2.5 estimated',
  );
  expect(
    goalBudgetText({ maxCostUsd: 1 }, { tasks: 1, elapsedMs: 0, costUsd: 0, unpricedResponses: 2 }),
  ).toBe('Budget: ~$0.00 of $1 estimated (2 unpriced responses)');
});
