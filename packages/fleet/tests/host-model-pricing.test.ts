import type { Config, ModelsRegistry } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
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
});
