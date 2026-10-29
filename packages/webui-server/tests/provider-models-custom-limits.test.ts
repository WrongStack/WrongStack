import type { ProviderConfig } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import { createCatalogHandlers } from '../src/server/provider/catalog.js';
import { createProviderServiceContext } from '../src/server/provider/mutations.js';

const registry = {
  getProvider: async () => undefined,
  getModel: async () => undefined,
  listProviders: async () => [],
};

async function listedModels(config: ProviderConfig) {
  const frames: Array<{ type: string; payload?: unknown }> = [];
  const context = createProviderServiceContext({
    providerStore: { load: async () => ({ saved: config }), save: async () => {} },
    broadcast: () => {},
    send: (_ws, frame) => frames.push(frame),
    modelsRegistry: registry as never,
  });
  await createCatalogHandlers(context).handleProviderModels({} as never, 'saved', {
    includeDisabled: true,
  });
  const frame = frames.find((item) => item.type === 'provider.models');
  expect(frame).toBeDefined();
  return (
    frame!.payload as {
      models: Array<{ id: string; contextWindow?: number; maxOutput?: number }>;
    }
  ).models;
}

describe('provider.models limits for saved custom models', () => {
  it('lists the saved output limit next to the saved context window', async () => {
    const models = await listedModels({
      type: 'openai-compatible',
      models: ['custom'],
      customModels: {
        custom: { name: 'Custom', capabilities: { maxContext: 128_000, maxOutput: 16_000 } },
      },
    });
    expect(models.find((model) => model.id === 'custom')).toMatchObject({
      contextWindow: 128_000,
      maxOutput: 16_000,
    });
  });
  it('leaves an unknown output limit out instead of inventing one', async () => {
    const models = await listedModels({
      type: 'openai-compatible',
      models: ['custom'],
      customModels: { custom: { name: 'Custom', capabilities: { maxContext: 128_000 } } },
    });
    expect(models.find((model) => model.id === 'custom')?.maxOutput).toBeUndefined();
  });
});
