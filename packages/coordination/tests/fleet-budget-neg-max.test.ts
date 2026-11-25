import { describe, expect, it } from 'vitest';
import { fleetBudgetFromDirector } from '../src/fleet-budget.js';

describe('fleetBudgetFromDirector (F2164)', () => {
  it('clamps negative maxSpawns to 0 while preserving +Infinity', () => {
    const neg = fleetBudgetFromDirector({
      maxSpawns: -5,
      spawnCount: 0,
      status: () => ({ subagents: [] }),
    });
    expect(neg?.maxSpawns).toBe(0);
    expect(neg?.remainingSpawns).toBe(0);

    const inf = fleetBudgetFromDirector({
      maxSpawns: Number.POSITIVE_INFINITY,
      spawnCount: 2,
      status: () => ({ subagents: [] }),
    });
    expect(inf?.maxSpawns).toBe(Number.POSITIVE_INFINITY);
  });
});
