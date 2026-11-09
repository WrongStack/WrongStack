import type { Config, ModelsRegistry } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import { runWithQuotaHold } from '../src/acp-quota-hold.js';
import { resolveFleetBudgetSources } from '../src/budget-source.js';
import { resolveHostModelPrice } from '../src/host-model-pricing.js';

describe('configured worker model pricing', () => {
  function deps(
    cost: Record<string, unknown> | undefined,
    custom: Record<string, unknown> | undefined,
  ) {
    const config = {
      providers: { local: { customModels: { worker: { modelsDev: { cost: custom } } } } },
    } as unknown as Config;
    return {
      configStore: { get: () => config } as Parameters<
        typeof resolveHostModelPrice
      >[0]['configStore'],
      modelsRegistry: {
        getModel: async () => (cost ? { cost } : undefined),
      } as unknown as ModelsRegistry,
    };
  }

  it('prices a configured custom worker absent from the registry', async () => {
    expect(
      await resolveHostModelPrice(deps(undefined, { input: 1, output: 2 }), 'local', 'worker'),
    ).toEqual({ input: 1, output: 2, cacheRead: 1, cacheWrite: 1 });
  });

  it('overlays custom fields while retaining the other catalog rates', async () => {
    expect(
      await resolveHostModelPrice(
        deps({ input: 3, output: 5, cache_read: 0.3 }, { output: 2 }),
        'local',
        'worker',
      ),
    ).toEqual({ input: 3, output: 2, cacheRead: 0.3, cacheWrite: 3 });
  });

  it('keeps configured pricing and unknown estimates when the optional catalog fails', async () => {
    for (const custom of [{ input: 1, output: 2 }, undefined]) {
      const input = deps(undefined, custom);
      input.modelsRegistry = {
        getModel: async () => {
          throw new Error('catalog unavailable');
        },
      } as unknown as ModelsRegistry;
      const price = await resolveHostModelPrice(input, 'local', 'worker');
      if (custom) expect(price).toEqual({ input: 1, output: 2, cacheRead: 1, cacheWrite: 1 });
      else expect(price).toBeUndefined();
    }
  });

  it('keeps catalog pricing when the config has no provider section', async () => {
    const input = deps({ input: 1, output: 2 }, undefined);
    input.configStore = { get: () => ({}) as Config } as typeof input.configStore;
    expect(await resolveHostModelPrice(input, 'local', 'worker')).toEqual({
      input: 1,
      output: 2,
      cacheRead: 1,
      cacheWrite: 1,
    });
  });

  it('preserves explicitly free models and rejects invalid rates', async () => {
    expect(
      await resolveHostModelPrice(deps(undefined, { input: 0, output: 0 }), 'local', 'worker'),
    ).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(
      await resolveHostModelPrice(
        deps(undefined, { input: -1, output: Number.NaN }),
        'local',
        'worker',
      ),
    ).toBeUndefined();
    expect(
      await resolveHostModelPrice(deps(undefined, undefined), 'local', 'worker'),
    ).toBeUndefined();
  });

  it('retains valid catalog rates when custom overrides are invalid, rejects <1 fractional budgets, and holds quota on 0/NaN backoffMs (F122)', async () => {
    expect(
      await resolveHostModelPrice(
        deps(
          { input: 3, output: 10, cache_read: 0.5 },
          { input: 'bad', output: 4, cache_read: -1 },
        ),
        'local',
        'worker',
      ),
    ).toEqual({ input: 3, output: 4, cacheRead: 0.5, cacheWrite: 3 });

    const budget = resolveFleetBudgetSources({
      config: { maxConcurrent: 0.5 } as Config,
      env: {},
      defaultMaxConcurrent: 4,
    });
    expect(budget.maxConcurrent).toBe(4);
    expect(budget.maxConcurrentSource).toBe('default');

    let starts = 0;
    const now = () => 5_000_000;
    for (let i = 0; i < 2; i++) {
      await expect(
        runWithQuotaHold(
          'agent-f122-zero',
          async () => {
            starts += 1;
            throw { kind: 'provider_quota', message: 'Quota hit', backoffMs: 0 };
          },
          now,
        ),
      ).rejects.toMatchObject({ kind: 'provider_quota' });
    }
    expect(starts).toBe(1);
  });
});
