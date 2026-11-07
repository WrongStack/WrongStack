import type { ResolvedModel } from '@wrongstack/contracts/types';
import { CONFIG_BEHAVIOR_DEFAULTS } from '@wrongstack/core/storage';
import { describe, expect, it } from 'vitest';
import { createGoalUsagePricer } from '../src/server/goal-usage-pricer.js';

function pricer(cost: ResolvedModel['cost']) {
  const model: ResolvedModel = {
    providerId: 'catalog',
    modelId: 'worker',
    capabilities: { tools: true, vision: false, reasoning: false, maxContext: 32_000 },
    ...(cost === undefined ? {} : { cost }),
  };
  return createGoalUsagePricer({
    modelsRegistry: {
      getModel: async () => model,
      getProvider: async () => undefined,
      load: async () => {
        throw Error('Unexpected registry load in pricing fixture');
      },
      refresh: async () => {
        throw Error('Unexpected registry refresh in pricing fixture');
      },
      listProviders: async () => [],
      suggestModel: async () => undefined,
      ageSeconds: async () => Infinity,
    },
    config: {
      ...structuredClone(CONFIG_BEHAVIOR_DEFAULTS),
      provider: 'catalog',
      model: 'worker',
      providers: {},
    },
  });
}

describe('goal usage pricer', () => {
  const source = { providerId: 'catalog', model: 'worker' };

  it('returns null when consumed output has no rate', async () => {
    const price = pricer({ input: 2 });
    await expect(price({ input: 0, output: 1_000_000 }, source)).resolves.toBeNull();
    await expect(price({ input: 1_000_000, output: 0 }, source)).resolves.toBe(2);
  });

  it('keeps an explicit zero rate distinct from a missing rate', async () => {
    await expect(
      pricer({ input: 0, output: 0 })({ input: 0, output: 1_000_000 }, source),
    ).resolves.toBe(0);
    await expect(
      pricer(undefined)({ input: 1_000_000, output: 1_000_000 }, source),
    ).resolves.toBeNull();
  });
});
