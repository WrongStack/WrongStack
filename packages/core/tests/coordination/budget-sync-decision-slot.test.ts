import { EventBus } from '@wrongstack/contracts/kernel/events';
import { describe, expect, it } from 'vitest';
import { BudgetThresholdSignal, SubagentBudget } from '../../src/coordination/subagent-budget.js';

/**
 * `_negotiateExtension` is async but returns without awaiting for a synchronous
 * handler decision, so its own `finally` runs before the caller records the
 * promise in `_pendingNegotiations`. The slot for that budget kind therefore
 * has to be released by the caller, or the kind is never negotiated again.
 */

function overrun(budget: SubagentBudget): BudgetThresholdSignal | undefined {
  try {
    budget.recordIteration();
  } catch (error) {
    if (error instanceof BudgetThresholdSignal) return error;
    throw error;
  }
  return undefined;
}

const pendingKinds = (budget: SubagentBudget): string[] => [
  ...(
    budget as never as { _pendingNegotiations: Map<string, unknown> }
  )._pendingNegotiations.keys(),
];

type Handler = NonNullable<SubagentBudget['onThreshold']>;

function make(handler: Handler): SubagentBudget {
  const bus = new EventBus();
  bus.onPattern('*', () => {});
  const budget = new SubagentBudget({ maxIterations: 1 });
  budget._events = bus;
  budget.onThreshold = handler;
  return budget;
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('budget negotiation slot release', () => {
  it('releases the slot after an async decision', async () => {
    let calls = 0;
    const budget = make(async (): Promise<'stop'> => {
      calls++;
      await Promise.resolve();
      return 'stop';
    });
    budget.recordIteration();
    await overrun(budget)?.decision;
    await settle();
    expect(pendingKinds(budget)).toEqual([]);
    await overrun(budget)?.decision;
    expect(calls).toBe(2);
  });

  it("releases the slot after a synchronous 'continue' decision", async () => {
    let calls = 0;
    const budget = make(() => {
      calls++;
      return 'continue';
    });
    budget.recordIteration();
    const first = overrun(budget);
    expect(first).toBeInstanceOf(BudgetThresholdSignal);
    await expect(first?.decision).resolves.toEqual({ extend: {} });
    await settle();
    expect(pendingKinds(budget)).toEqual([]);
    // A genuinely fresh overrun negotiates again instead of replaying the first.
    await overrun(budget)?.decision;
    expect(calls).toBe(2);
  });

  it("releases the slot after a synchronous 'throw' decision", async () => {
    let calls = 0;
    const budget = make(() => {
      calls++;
      return 'throw';
    });
    budget.recordIteration();
    await expect(overrun(budget)?.decision).resolves.toBe('stop');
    await settle();
    expect(pendingKinds(budget)).toEqual([]);
    await overrun(budget)?.decision;
    expect(calls).toBe(2);
  });

  it('still dedups a second overrun of the same kind while a decision is in flight', async () => {
    let calls = 0;
    let release: () => void = () => {};
    const budget = make(
      () =>
        new Promise((resolve) => {
          calls++;
          release = () => resolve('stop');
        }),
    );
    budget.recordIteration();
    const first = overrun(budget);
    const second = overrun(budget);
    expect(pendingKinds(budget)).toEqual(['iterations']);
    expect(calls).toBe(1);
    release();
    await first?.decision;
    await second?.decision;
    await settle();
    expect(pendingKinds(budget)).toEqual([]);
  });
});
