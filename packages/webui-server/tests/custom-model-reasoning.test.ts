import type { ProviderConfig } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import {
  configuredModelReasoning,
  resolveProviderModelMetadata,
} from '../src/server/model-catalog.js';
import { createCatalogHandlers } from '../src/server/provider/catalog.js';
import { createProviderServiceContext } from '../src/server/provider/mutations.js';

const customConfig: ProviderConfig = {
  type: 'openai-compatible',
  models: ['reviewed'],
  customModels: {
    reviewed: {
      name: 'Reviewed',
      capabilities: { reasoning: true, maxContext: 65536 },
      modelsDev: {
        name: 'Reviewed',
        reasoning: true,
        reasoning_options: [
          { type: 'effort', values: ['low', 'high'] },
          { type: 'budget_tokens', min: 1024, max: 32768 },
        ],
      },
    },
  },
};
const registry = {
  getProvider: async () => undefined,
  getModel: async () => undefined,
  listProviders: async () => [],
};
describe('saved custom model reasoning on real metadata and catalog paths', () => {
  it('keeps upstream policy for unrelated edits and honors explicit empty controls and saved runtime policy', () => {
    const fallback = {
      default: 'always_on' as const,
      disableSupported: false,
      effortSupported: true,
      effortLevels: ['max' as const],
      preserveThinking: 'always_on' as const,
    };
    const config = structuredClone(customConfig);
    config.customModels!.reviewed!.modelsDev = { name: 'Renamed only' };
    expect(configuredModelReasoning(config, 'reviewed', fallback)).toEqual(fallback);
    config.customModels!.reviewed!.modelsDev.reasoning_options = [];
    expect(configuredModelReasoning(config, 'reviewed', fallback)).toMatchObject({
      effortSupported: false,
      effortLevels: [],
      preserveThinking: 'always_on',
    });
    config.customModels!.reviewed!.modelsDev.reasoningConfig = fallback;
    expect(configuredModelReasoning(config, 'reviewed', fallback)).toEqual(fallback);
    delete config.customModels!.reviewed!.modelsDev.reasoningConfig;
    delete config.customModels!.reviewed!.modelsDev.reasoning_options;
    config.customModels!.reviewed!.modelsDev.reasoning = false;
    expect(configuredModelReasoning(config, 'reviewed', fallback)).toBeUndefined();
  });
  it('exposes the saved effort vocabulary in model metadata', async () => {
    const result = await resolveProviderModelMetadata(
      registry,
      'saved-alias',
      'reviewed',
      customConfig,
    );
    expect(result?.capabilities.reasoningConfig).toMatchObject({
      effortSupported: true,
      effortLevels: ['low', 'high'],
    });
  });
  it('exposes the same saved vocabulary through provider.models', async () => {
    const frames: Array<{ type: string; payload?: unknown }> = [];
    const context = createProviderServiceContext({
      providerStore: { load: async () => ({ 'saved-alias': customConfig }), save: async () => {} },
      broadcast: () => {},
      send: (_ws, frame) => frames.push(frame),
      modelsRegistry: registry as never,
    });
    await createCatalogHandlers(context).handleProviderModels({} as never, 'saved-alias', {
      includeDisabled: true,
    });
    const payload = frames.find((frame) => frame.type === 'provider.models')?.payload as {
      models: Array<{ id: string; effortSupported?: boolean; reasoningEffortLevels?: string[] }>;
    };
    expect(payload.models.find((model) => model.id === 'reviewed')).toMatchObject({
      effortSupported: true,
      reasoningEffortLevels: ['low', 'high'],
      reasoningControls: { disableSupported: expect.any(Boolean), preserveThinking: 'unsupported' },
    });
  });
});
