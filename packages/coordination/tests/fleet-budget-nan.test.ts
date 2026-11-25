import { describe, expect, it } from 'vitest';
import { fleetBudgetFromDirector } from '../src/fleet-budget.js';

describe('fleetBudgetFromDirector non-finite guards', () => {
  it('handles NaN spawnCount and maxSpawns without returning NaN or false Infinity', () => {
    const nanUsed = fleetBudgetFromDirector({
      maxSpawns: 10,
      spawnCount: Number.NaN,
      status: () => ({ subagents: [] }),
    });
    expect(nanUsed?.usedSpawns).toBe(0);
    expect(nanUsed?.remainingSpawns).toBe(10);

    const nanMax = fleetBudgetFromDirector({
      maxSpawns: Number.NaN,
      spawnCount: 3,
      status: () => ({ subagents: [] }),
    });
    expect(nanMax?.maxSpawns).toBe(0);
    expect(nanMax?.remainingSpawns).toBe(0);

    const infMax = fleetBudgetFromDirector({
      maxSpawns: Number.POSITIVE_INFINITY,
      spawnCount: 3,
      status: () => ({ subagents: [] }),
    });
    expect(infMax?.remainingSpawns).toBe(Number.POSITIVE_INFINITY);
  });
});
