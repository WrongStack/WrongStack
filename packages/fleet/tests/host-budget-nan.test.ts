import { describe, expect, it } from 'vitest';
import { budgetView, type HostBudgetHost } from '../src/host-budget.js';

function makeHost(maxSpawns: number, spawnCount: number): HostBudgetHost {
  return {
    fleetManager: undefined,
    opts: { maxSpawns } as HostBudgetHost['opts'],
    director: { maxSpawns, spawnCount } as HostBudgetHost['director'],
    getCoordinator: () =>
      ({ getStatus: () => ({ subagents: [] }) }) as ReturnType<HostBudgetHost['getCoordinator']>,
    getMaxConcurrent: () => 4,
    shadowManager: {} as HostBudgetHost['shadowManager'],
  };
}

describe('budgetView non-finite spawn budget guards', () => {
  it('does not turn NaN maxSpawns into Infinity or propagate NaN usedSpawns', () => {
    const nanMax = budgetView.call(makeHost(Number.NaN, 2));
    expect(nanMax.maxSpawns).toBe(0);
    expect(nanMax.remainingSpawns).toBe(0);

    const nanUsed = budgetView.call(makeHost(10, Number.NaN));
    expect(nanUsed.usedSpawns).toBe(0);
    expect(nanUsed.remainingSpawns).toBe(10);
  });
});
