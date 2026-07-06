import { describe, expect, it, vi } from 'vitest';
import {
  type Capabilities,
  type ModelsDevModel,
  type ModelsDevPayload,
  type Provider,
  DefaultModelsRegistry,
} from '@wrongstack/core';
import { withCatalogCapabilities } from '../src/index.js';
import * as os from 'node:os';
import * as path from 'node:path';

const SAMPLE: ModelsDevPayload = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    env: ['ANTHROPIC_API_KEY'],
    npm: '@ai-sdk/anthropic',
    models: {
      'anthropic-test-model': {
        id: 'anthropic-test-model',
        name: 'Anthropic Catalog Test',
        tool_call: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 200_000, output: 64_000 },
      } satisfies ModelsDevModel,
    },
  },
};

function reg() {
  return new DefaultModelsRegistry({
    cacheFile: path.join(os.tmpdir(), `wstack-wcc-${Date.now()}-${Math.random()}.json`),
    seed: SAMPLE,
  });
}

function fakeProvider(initialCaps: Capabilities): Provider {
  return { id: 'fake', capabilities: initialCaps } as Provider;
}

describe('withCatalogCapabilities', () => {
  it('overlays the catalog-resolved maxOutput on the provider', async () => {
    const baseline: Capabilities = {
      tools: true,
      parallelTools: true,
      vision: true,
      streaming: true,
      promptCache: true,
      systemPrompt: true,
      jsonMode: false,
      reasoning: false,
      maxContext: 200_000,
      cacheControl: 'native',
    };
    const provider = fakeProvider(baseline);

    const out = await withCatalogCapabilities(
      reg(),
      'anthropic',
      provider,
      { type: 'anthropic', model: 'anthropic-test-model' },
    );

    expect(out.capabilities.maxOutput).toBe(64_000);
    // The family baseline still applies for non-catalog fields:
    expect(out.capabilities.cacheControl).toBe('native');
    expect(out.capabilities.maxContext).toBe(200_000);
  });

  it('leaves the provider untouched when capabilitiesFor throws', async () => {
    const baseline: Capabilities = {
      tools: true,
      parallelTools: true,
      vision: true,
      streaming: true,
      promptCache: true,
      systemPrompt: true,
      jsonMode: false,
      reasoning: false,
      maxContext: 8_192,
      cacheControl: 'none',
    };
    const provider = fakeProvider(baseline);
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

    // Force a failure: a registry whose getProvider throws.
    const broken = {
      getProvider: vi.fn().mockRejectedValue(new Error('catalog offline')),
      getModel: vi.fn().mockRejectedValue(new Error('catalog offline')),
      listProviders: vi.fn().mockResolvedValue([]),
    };

    const out = await withCatalogCapabilities(
      broken as never,
      'openai-compatible',
      provider,
      { type: 'openai-compatible', model: 'unknown' },
      log,
    );

    // The original capabilities stand — Chimera's 8192 safety net in
    // agent-response.ts is what covers the undefined maxOutput case.
    expect(out.capabilities).toBe(baseline);
    expect(out.capabilities.maxContext).toBe(8_192);
    expect(out.capabilities.cacheControl).toBe('none');
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining('catalog offline'));
  });

  it('returns the same provider reference it was given', async () => {
    const provider = fakeProvider({
      tools: true,
      parallelTools: true,
      vision: false,
      streaming: true,
      promptCache: false,
      systemPrompt: true,
      jsonMode: false,
      reasoning: false,
      maxContext: 0,
      cacheControl: 'none',
    });

    const out = await withCatalogCapabilities(
      reg(),
      'anthropic',
      provider,
      { type: 'anthropic', model: 'anthropic-test-model' },
    );

    expect(out).toBe(provider);
  });

  it('lets customModels override the catalog value', async () => {
    const baseline: Capabilities = {
      tools: true,
      parallelTools: true,
      vision: true,
      streaming: true,
      promptCache: true,
      systemPrompt: true,
      jsonMode: false,
      reasoning: false,
      maxContext: 200_000,
      cacheControl: 'native',
    };
    const provider = fakeProvider(baseline);

    const out = await withCatalogCapabilities(
      reg(),
      'anthropic',
      provider,
      {
        type: 'anthropic',
        model: 'anthropic-test-model',
        customModels: {
          'anthropic-test-model': { capabilities: { maxOutput: 32_000 } },
        },
      },
    );

    expect(out.capabilities.maxOutput).toBe(32_000);
  });
});
