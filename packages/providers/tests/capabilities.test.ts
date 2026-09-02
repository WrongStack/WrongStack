import * as os from 'node:os';
import * as path from 'node:path';
import { DefaultModelsRegistry } from '@wrongstack/core/models';
import type {
  CustomModelDefinition,
  ModelsDevPayload,
  ModelsRegistry,
} from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';
import { capabilitiesFor } from '../src/capabilities.js';

const SAMPLE: ModelsDevPayload = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    env: ['ANTHROPIC_API_KEY'],
    npm: '@ai-sdk/anthropic',
    models: {
      'anthropic-test-model': {
        id: 'anthropic-test-model',
        name: 'Anthropic Test Model',
        tool_call: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 200_000, output: 64_000 },
      },
      'claude-text-only': {
        id: 'claude-text-only',
        name: 'Claude Text Only',
        tool_call: false,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 100_000, output: 8_192 },
      },
    },
  },
  google: {
    id: 'google',
    name: 'Google',
    env: ['GEMINI_API_KEY'],
    npm: '@ai-sdk/google',
    models: {
      'gemini-2.5-flash': {
        id: 'gemini-2.5-flash',
        name: 'Gemini',
        tool_call: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 1_000_000, output: 8_192 },
      },
    },
  },
};

function reg() {
  return new DefaultModelsRegistry({
    cacheFile: path.join(os.tmpdir(), `wstack-cap-${Date.now()}.json`),
    seed: SAMPLE,
  });
}

function countingRegistry(): ModelsRegistry & {
  getProvider: ReturnType<typeof vi.fn>;
  getModel: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
} {
  const provider = {
    id: 'anthropic',
    name: 'Anthropic',
    family: 'anthropic',
    envVars: ['ANTHROPIC_API_KEY'],
    models: [SAMPLE.anthropic.models['anthropic-test-model']],
  };
  const model = {
    providerId: 'anthropic',
    modelId: 'anthropic-test-model',
    capabilities: {
      tools: true,
      vision: true,
      reasoning: false,
      maxContext: 200_000,
      maxOutput: 64_000,
    },
  };

  const registry = {
    load: vi.fn(),
    listProviders: vi.fn(),
    suggestModel: vi.fn(),
    ageSeconds: vi.fn(),
    getProvider: vi.fn(async () => provider),
    getModel: vi.fn(async () => model),
    refresh: vi.fn(async () => SAMPLE),
  } satisfies ModelsRegistry;

  return registry as ModelsRegistry & {
    getProvider: ReturnType<typeof vi.fn>;
    getModel: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
  };
}

describe('capabilitiesFor', () => {
  it('anthropic + claude has native cache control', async () => {
    const c = await capabilitiesFor(reg(), 'anthropic', 'anthropic-test-model');
    expect(c.cacheControl).toBe('native');
    expect(c.tools).toBe(true);
    expect(c.vision).toBe(true);
    expect(c.maxContext).toBe(200_000);
  });

  it('google has 1M context default', async () => {
    const c = await capabilitiesFor(reg(), 'google', 'gemini-2.5-flash');
    expect(c.maxContext).toBe(1_000_000);
  });

  it('keeps openai-codex overlay models vision-capable when npm is absent', async () => {
    const registry = new DefaultModelsRegistry({
      cacheFile: path.join(os.tmpdir(), `wstack-cap-codex-${Date.now()}.json`),
      seed: {
        'openai-codex': {
          id: 'openai-codex',
          name: 'OpenAI Codex',
          models: {
            'gpt-5.5': {
              id: 'gpt-5.5',
              name: 'GPT-5.5',
              reasoning: true,
              tool_call: true,
              modalities: { input: ['text', 'image'], output: ['text'] },
              limit: { context: 1_050_000, output: 128_000 },
            },
          },
        },
      },
    });

    const c = await capabilitiesFor(registry, 'openai-codex', 'gpt-5.5');
    expect(c.vision).toBe(true);
    expect(c.tools).toBe(true);
    expect(c.maxContext).toBe(1_050_000);
    expect(c.promptCache).toBe(true);
  });

  it('uses the canonical openai catalog for openai-codex model facts when needed', async () => {
    const registry = new DefaultModelsRegistry({
      cacheFile: path.join(os.tmpdir(), `wstack-cap-codex-sibling-${Date.now()}.json`),
      seed: {
        openai: {
          id: 'openai',
          name: 'OpenAI',
          npm: '@ai-sdk/openai',
          models: {
            'gpt-5.5': {
              id: 'gpt-5.5',
              name: 'GPT-5.5',
              reasoning: true,
              tool_call: true,
              modalities: { input: ['text', 'image'], output: ['text'] },
              limit: { context: 1_050_000, output: 128_000 },
            },
          },
        },
      },
    });

    const c = await capabilitiesFor(registry, 'openai-codex', 'gpt-5.5');
    expect(c.vision).toBe(true);
    expect(c.tools).toBe(true);
    expect(c.maxContext).toBe(1_050_000);
    expect(c.promptCache).toBe(true);
    expect(c.jsonMode).toBe(false);
  });

  it('unknown model still returns family baseline', async () => {
    const c = await capabilitiesFor(reg(), 'anthropic', 'mystery-model');
    expect(c.cacheControl).toBe('native');
  });

  it('unknown provider falls back to unsupported', async () => {
    const c = await capabilitiesFor(reg(), 'nonexistent', 'foo');
    expect(c.tools).toBe(false);
  });

  it('model without explicit capabilities still returns family baseline', async () => {
    const c = await capabilitiesFor(reg(), 'anthropic', 'anthropic-test-model');
    expect(c.tools).toBe(true);
    expect(c.vision).toBe(true);
    expect(c.maxContext).toBe(200_000);
  });

  it('model-level tool and vision limits narrow the family baseline', async () => {
    const c = await capabilitiesFor(reg(), 'anthropic', 'claude-text-only');
    expect(c.tools).toBe(false);
    expect(c.parallelTools).toBe(false);
    expect(c.vision).toBe(false);
    expect(c.cacheControl).toBe('native');
    expect(c.maxContext).toBe(100_000);
  });

  // ---- custom model overrides ----

  it('custom model overrides maxContext on known model', async () => {
    const custom: Record<string, CustomModelDefinition> = {
      'anthropic-test-model': { capabilities: { maxContext: 500_000 } },
    };
    const c = await capabilitiesFor(reg(), 'anthropic', 'anthropic-test-model', custom);
    expect(c.maxContext).toBe(500_000);
    // Non-overridden fields still come from catalog
    expect(c.tools).toBe(true);
    expect(c.vision).toBe(true);
    expect(c.cacheControl).toBe('native');
  });

  it('custom model overrides capabilities flags on known model', async () => {
    const custom: Record<string, CustomModelDefinition> = {
      'anthropic-test-model': { capabilities: { tools: false, vision: false } },
    };
    const c = await capabilitiesFor(reg(), 'anthropic', 'anthropic-test-model', custom);
    expect(c.tools).toBe(false);
    expect(c.vision).toBe(false);
    expect(c.cacheControl).toBe('native');
    expect(c.maxContext).toBe(200_000);
  });

  it('custom model defines capabilities for unknown model', async () => {
    const custom: Record<string, CustomModelDefinition> = {
      'local-llama': { capabilities: { maxContext: 8192, tools: true, vision: false } },
    };
    const c = await capabilitiesFor(reg(), 'anthropic', 'local-llama', custom);
    expect(c.maxContext).toBe(8192);
    expect(c.tools).toBe(true);
    expect(c.vision).toBe(false);
    // Falls back to family baseline for unset fields
    expect(c.cacheControl).toBe('native');
  });

  it('custom model for unknown provider uses custom caps only', async () => {
    const custom: Record<string, CustomModelDefinition> = {
      'my-model': { capabilities: { maxContext: 32_000, tools: true, streaming: true } },
    };
    const c = await capabilitiesFor(reg(), 'ollama', 'my-model', custom);
    expect(c.maxContext).toBe(32_000);
    expect(c.tools).toBe(true);
    expect(c.streaming).toBe(true);
    // Unsupportable fields fall to unsupported family baseline
    expect(c.vision).toBe(false);
  });

  it('custom model partial override merges with catalog', async () => {
    const custom: Record<string, CustomModelDefinition> = {
      'anthropic-test-model': { capabilities: { streaming: false } },
    };
    const c = await capabilitiesFor(reg(), 'anthropic', 'anthropic-test-model', custom);
    expect(c.streaming).toBe(false);
    // Rest unchanged
    expect(c.tools).toBe(true);
    expect(c.maxContext).toBe(200_000);
  });

  // ---- maxOutput (drives subagent Request.maxTokens, e.g. Chimera) ----

  it('reads maxOutput from models.dev limit.output', async () => {
    // Anthropic family has no hard-coded maxOutput in family-capabilities
    // anymore — it must come from the catalog. If the model has
    // `limit.output`, capabilitiesFor propagates it; otherwise it's
    // undefined and the caller (agent-response) falls back to 8192.
    const c = await capabilitiesFor(reg(), 'anthropic', 'anthropic-test-model');
    expect(c.maxOutput).toBe(64_000);
  });

  it('returns undefined maxOutput when neither catalog nor custom supplies it', async () => {
    // An unknown model on the anthropic family has no `limit.output`
    // entry and no family default — must surface as undefined so
    // agent-response applies its 8192 fallback rather than fabricating
    // a value.
    const c = await capabilitiesFor(reg(), 'anthropic', 'mystery-model');
    expect(c.maxOutput).toBeUndefined();
  });

  it('custom model can override maxOutput independently of the catalog', async () => {
    const custom: Record<string, CustomModelDefinition> = {
      'anthropic-test-model': { capabilities: { maxOutput: 32_000 } },
    };
    const c = await capabilitiesFor(reg(), 'anthropic', 'anthropic-test-model', custom);
    // Custom wins over the catalog's 64_000
    expect(c.maxOutput).toBe(32_000);
  });

  it('memoizes per registry/provider/model and avoids repeated lookups until refresh', async () => {
    const registry = countingRegistry();

    const first = await capabilitiesFor(registry, 'anthropic', 'anthropic-test-model');
    const second = await capabilitiesFor(registry, 'anthropic', 'anthropic-test-model');

    expect(second).toBe(first);
    expect(registry.getProvider).toHaveBeenCalledTimes(1);
    expect(registry.getModel).toHaveBeenCalledTimes(1);

    await registry.refresh();
    const third = await capabilitiesFor(registry, 'anthropic', 'anthropic-test-model');

    expect(third).not.toBe(first);
    expect(registry.getProvider).toHaveBeenCalledTimes(2);
    expect(registry.getModel).toHaveBeenCalledTimes(2);
  });
});
