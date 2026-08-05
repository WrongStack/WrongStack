import { describe, expect, it } from 'vitest';
import { resolveFleetBudgetSources } from '../src/fleet/budget-source.js';

describe('resolveFleetBudgetSources', () => {
  it('prefers CLI flag over env and profile', () => {
    const r = resolveFleetBudgetSources({
      flags: { 'max-concurrent': '12', 'max-spawns': '200' },
      env: { WRONGSTACK_MAX_CONCURRENT: '8', WRONGSTACK_MAX_SPAWNS: '96' },
      config: { maxConcurrent: 4, fleet: { budget: { maxSpawns: 64 } } } as never,
    });
    expect(r).toMatchObject({
      maxConcurrent: 12,
      maxConcurrentSource: 'cli-flag',
      maxSpawns: 200,
      maxSpawnsSource: 'cli-flag',
    });
  });

  it('falls back to env then profile then default', () => {
    expect(
      resolveFleetBudgetSources({
        flags: {},
        env: { WRONGSTACK_MAX_SPAWNS: '96' },
        config: { maxConcurrent: 7 } as never,
      }),
    ).toMatchObject({
      maxConcurrent: 7,
      maxConcurrentSource: 'profile',
      maxSpawns: 96,
      maxSpawnsSource: 'env',
    });

    expect(
      resolveFleetBudgetSources({
        flags: {},
        env: {},
        config: {} as never,
        defaultMaxConcurrent: 4,
        defaultMaxSpawns: 64,
      }),
    ).toMatchObject({
      maxConcurrent: 4,
      maxConcurrentSource: 'default',
      maxSpawns: 64,
      maxSpawnsSource: 'default',
    });
  });
});
