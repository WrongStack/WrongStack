import { expect, it } from 'vitest';
import { goalBudgetPayload, goalBudgetText } from '../src/goal-budget-model';

it('builds the optional budget and refuses values the engine would ignore', () => {
  expect(goalBudgetPayload('', ' ')).toBeUndefined();
  expect(goalBudgetPayload('5', '')).toEqual({ maxTasks: 5 });
  expect(goalBudgetPayload('', '90')).toEqual({ maxMinutes: 90 });
  expect(() => goalBudgetPayload('2.5', '')).toThrow('whole number');
  expect(() => goalBudgetPayload('0', '')).toThrow('from 1');
  expect(() => goalBudgetPayload('', 'soon')).toThrow('run-time limit');
});

it('describes the budget and its usage only when a budget is set', () => {
  expect(goalBudgetText(null, null)).toBe('');
  expect(
    goalBudgetText({ maxTasks: 10, maxMinutes: 60 }, { tasks: 3, elapsedMs: 12.5 * 60_000 }),
  ).toBe('Budget: 3 of 10 tasks · 12 of 60 min');
  expect(goalBudgetText({ maxTasks: 4 }, null)).toBe('Budget: 0 of 4 tasks');
});
