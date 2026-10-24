import { EventBus } from '@wrongstack/contracts/kernel';
import { describe, expect, it, vi } from 'vitest';
import { parseMaxBudgetUsd, watchSingleShotBudget } from '../src/boot/single-shot-budget.js';

function counterAt(start: number) {
  let total = start;
  return {
    set: (value: number) => {
      total = value;
    },
    estimateCost: () => ({ input: 0, output: 0, total, currency: 'USD' as const }),
  };
}

const usage = { input: 1, output: 1 };
const cost = (total: number) => ({ input: 0, output: 0, total });

describe('parseMaxBudgetUsd', () => {
  it('is undefined when the flag is absent', () => {
    expect(parseMaxBudgetUsd(undefined)).toBeUndefined();
  });

  it('parses a positive dollar amount', () => {
    expect(parseMaxBudgetUsd(' 0.50 ')).toBe(0.5);
  });

  it.each([true, '', 'abc', '0', '-1'])('rejects %j', (value) => {
    expect(() => parseMaxBudgetUsd(value)).toThrow(/positive dollar amount/);
  });
});

describe('watchSingleShotBudget', () => {
  it('counts only spend since the run started', () => {
    const events = new EventBus();
    const counter = counterAt(5);
    const onExceeded = vi.fn();
    const budget = watchSingleShotBudget({
      limitUsd: 1,
      tokenCounter: counter,
      events,
      onExceeded,
    });

    counter.set(5.8);
    events.emit('token.accounted', { usage, cost: cost(5.8) } as never);
    expect(budget.spent()).toBeCloseTo(0.8);
    expect(onExceeded).not.toHaveBeenCalled();

    counter.set(6.2);
    events.emit('token.accounted', { usage, cost: cost(6.2) } as never);
    expect(onExceeded).toHaveBeenCalledOnce();
    expect(budget.exceeded).toBe(true);
    budget.dispose();
  });

  it('adds each subagent’s cumulative cost, keyed so repeats are not double-counted', () => {
    const events = new EventBus();
    const counter = counterAt(0);
    const onExceeded = vi.fn();
    const budget = watchSingleShotBudget({
      limitUsd: 1,
      tokenCounter: counter,
      events,
      onExceeded,
    });

    const sub = (subagentId: string, total: number) =>
      events.emit('subagent.token_accounted', { subagentId, usage, cost: cost(total) });
    sub('a', 0.3);
    sub('a', 0.4);
    sub('b', 0.5);
    expect(budget.spent()).toBeCloseTo(0.9);
    expect(onExceeded).not.toHaveBeenCalled();

    sub('b', 0.7);
    expect(onExceeded).toHaveBeenCalledOnce();
    sub('b', 0.9);
    expect(onExceeded).toHaveBeenCalledOnce();
    budget.dispose();
  });

  it('stops listening after dispose', () => {
    const events = new EventBus();
    const counter = counterAt(0);
    const onExceeded = vi.fn();
    const budget = watchSingleShotBudget({
      limitUsd: 1,
      tokenCounter: counter,
      events,
      onExceeded,
    });
    budget.dispose();
    counter.set(10);
    events.emit('token.accounted', { usage, cost: cost(10) } as never);
    expect(onExceeded).not.toHaveBeenCalled();
  });
});
