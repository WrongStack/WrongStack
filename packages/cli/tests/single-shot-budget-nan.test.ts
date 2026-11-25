import { describe, expect, it } from 'vitest';
import { watchSingleShotBudget } from '../src/boot/single-shot-budget.js';

describe('watchSingleShotBudget non-finite cost guard', () => {
  it('ignores NaN subagent costs instead of poisoning spent() and triggering onExceeded', () => {
    const listeners = new Map<string, (p: unknown) => void>();
    let exceeded = false;
    const budget = watchSingleShotBudget({
      limitUsd: 1.0,
      tokenCounter: { estimateCost: () => ({ total: 0 }) } as never,
      events: {
        on: (e: string, fn: (p: unknown) => void) => {
          listeners.set(e, fn);
          return () => {};
        },
      } as never,
      onExceeded: () => {
        exceeded = true;
      },
    });
    listeners.get('subagent.token_accounted')?.({ subagentId: 's1', cost: { total: 0.2 } });
    listeners.get('subagent.token_accounted')?.({ subagentId: 's2', cost: { total: Number.NaN } });
    expect(budget.spent()).toBe(0.2);
    expect(exceeded).toBe(false);
  });
});
