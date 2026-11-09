import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { goalBudgetExceeded, goalUsageTokens, parseGoalBudget } from '../src/goal-budget.js';
import { PhaseGraphBuilder } from '../src/phase-graph-builder.js';
import { PhaseStore } from '../src/phase-store.js';

it('accepts only positive bounded limits', () => {
  expect(parseGoalBudget({ maxTasks: 3.7, maxMinutes: 90 })).toEqual({
    maxTasks: 3,
    maxMinutes: 90,
  });
  for (const value of [undefined, {}, { maxTasks: 0 }, { maxTasks: -1 }, { maxMinutes: 'x' }])
    expect(parseGoalBudget(value)).toBeUndefined();
  expect(parseGoalBudget({ maxTasks: 1e9 })).toBeUndefined();
});

it('reports the first limit reached before the next task starts', () => {
  expect(goalBudgetExceeded(undefined, { tasks: 99, elapsedMs: 1e9 })).toBeUndefined();
  expect(goalBudgetExceeded({ maxTasks: 2 }, { tasks: 1, elapsedMs: 0 })).toBeUndefined();
  expect(goalBudgetExceeded({ maxTasks: 2 }, { tasks: 2, elapsedMs: 0 })).toMatch(/2 of 2 tasks/);
  expect(goalBudgetExceeded({ maxMinutes: 1 }, { tasks: 0, elapsedMs: 60_000 })).toMatch(
    /1 of 1 minutes/,
  );
});

it('keeps the budget and its usage across a save and load', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'goal-budget-'));
  try {
    const store = new PhaseStore({ baseDir: dir });
    const graph = await new PhaseGraphBuilder({
      title: 'Budgeted',
      description: 'd',
      phases: [],
    }).build();
    graph.budget = { maxTasks: 4 };
    graph.budgetUsage = { tasks: 2, elapsedMs: 1234 };
    await store.save(graph);
    const loaded = await store.load(graph.id);
    expect(loaded?.budget).toEqual({ maxTasks: 4 });
    expect(loaded?.budgetUsage).toEqual({ tasks: 2, elapsedMs: 1234 });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it('counts provider tokens against a token budget', () => {
  expect(parseGoalBudget({ maxTokens: 50_000.7 })).toEqual({ maxTokens: 50_000 });
  expect(parseGoalBudget({ maxTokens: -1 })).toBeUndefined();
  expect(parseGoalBudget({ maxTokens: 2e12 })).toBeUndefined();
  expect(goalUsageTokens({ input: 100, output: 20, cacheRead: 300, cacheWrite: 5 })).toBe(425);
  expect(goalUsageTokens({ input: Number.NaN, output: -3 })).toBe(0);
  const budget = { maxTokens: 1_000 };
  expect(goalBudgetExceeded(budget, { tasks: 9, elapsedMs: 0, tokens: 999 })).toBeUndefined();
  expect(goalBudgetExceeded(budget, { tasks: 9, elapsedMs: 0, tokens: 1_000 })).toBe(
    'Budget reached: 1,000 of 1,000 provider tokens used.',
  );
  // Runs saved before token counting have no token usage yet.
  expect(goalBudgetExceeded(budget, { tasks: 9, elapsedMs: 0 })).toBeUndefined();
});

describe('goal cost budget', () => {
  it('parses a positive USD limit', () => {
    expect(parseGoalBudget({ maxCostUsd: 2.5 })).toEqual({ maxCostUsd: 2.5 });
    expect(parseGoalBudget({ maxCostUsd: 0 })).toBeUndefined();
    expect(parseGoalBudget({ maxCostUsd: Number.POSITIVE_INFINITY })).toBeUndefined();
  });
  it('stops at the estimated cost and fails closed on unpriced responses', () => {
    const budget = { maxCostUsd: 1 };
    expect(goalBudgetExceeded(budget, { tasks: 1, elapsedMs: 0, costUsd: 0.5 })).toBeUndefined();
    expect(goalBudgetExceeded(budget, { tasks: 1, elapsedMs: 0, costUsd: 1.2 })).toMatch(
      /^Budget reached: an estimated \$1\.2000 of \$1 spent\.$/,
    );
    expect(
      goalBudgetExceeded(budget, { tasks: 1, elapsedMs: 0, costUsd: 0.1, unpricedResponses: 2 }),
    ).toMatch(/cost of 2 provider responses is unknown/);
    expect(goalBudgetExceeded(undefined, { tasks: 1, elapsedMs: 0, unpricedResponses: 2 })).toBe(
      undefined,
    );
  });
  it('rejects fractional integer limits < 1 and fails closed on NaN usage fields (F123)', () => {
    expect(parseGoalBudget({ maxTasks: 0.5, maxTokens: 0.9 })).toBeUndefined();
    expect(
      goalBudgetExceeded({ maxCostUsd: 10 }, { tasks: 1, elapsedMs: 0, costUsd: Number.NaN }),
    ).toMatch(/Budget reached/);
    expect(
      goalBudgetExceeded({ maxTokens: 100 }, { tasks: 1, elapsedMs: 0, tokens: Number.NaN }),
    ).toMatch(/Budget reached/);
  });
});
