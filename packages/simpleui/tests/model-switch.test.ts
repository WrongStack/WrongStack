import { describe, expect, it } from 'vitest';
import {
  findModelContextWindow,
  parseCatalogProviders,
  parseSavedProviderIds,
  planModelSwitch,
  providersNeedingModels,
} from '../src/lib/model-switch.js';
import type { ModelDescriptor } from '../src/types.js';

describe('parseCatalogProviders', () => {
  it('reads id, label, and hasApiKey from a catalog payload', () => {
    expect(
      parseCatalogProviders({
        providers: [
          { id: 'openai', name: 'OpenAI', hasApiKey: true, modelCount: 12 },
          { id: 'mistral', name: 'Mistral', hasApiKey: false, modelCount: 8 },
        ],
      }),
    ).toEqual([
      { id: 'openai', label: 'OpenAI', hasApiKey: true },
      { id: 'mistral', label: 'Mistral', hasApiKey: false },
    ]);
  });

  it('falls back to the id when the name is missing or empty', () => {
    expect(parseCatalogProviders({ providers: [{ id: 'ollama', hasApiKey: true }] })).toEqual([
      { id: 'ollama', label: 'ollama', hasApiKey: true },
    ]);
  });

  it('skips malformed entries and non-array payloads', () => {
    expect(
      parseCatalogProviders({
        providers: [null, 'openai', { name: 'No id' }, { id: '', hasApiKey: true }, { id: 'ok' }],
      }),
    ).toEqual([{ id: 'ok', label: 'ok', hasApiKey: false }]);
    expect(parseCatalogProviders({})).toEqual([]);
    expect(parseCatalogProviders({ providers: 'nope' })).toEqual([]);
  });
});

describe('parseSavedProviderIds', () => {
  it('collects ids from saved provider views', () => {
    expect(
      parseSavedProviderIds({
        providers: [
          { id: 'openai-codex', apiKeys: [] },
          { id: 'github-copilot', apiKeys: [] },
        ],
      }),
    ).toEqual(['openai-codex', 'github-copilot']);
  });

  it('skips malformed entries and non-array payloads', () => {
    expect(parseSavedProviderIds({ providers: [{ id: 'a' }, null, { id: 7 }, {}] })).toEqual(['a']);
    expect(parseSavedProviderIds({})).toEqual([]);
  });
});

describe('providersNeedingModels', () => {
  it('unions the session provider, credentialed catalog providers, and saved providers', () => {
    expect(
      providersNeedingModels({
        catalog: [
          { id: 'openai', label: 'OpenAI', hasApiKey: true },
          { id: 'mistral', label: 'Mistral', hasApiKey: false },
        ],
        savedIds: ['ollama-local'],
        currentProvider: 'anthropic',
        alreadyRequested: new Set(),
      }),
    ).toEqual(['anthropic', 'openai', 'ollama-local']);
  });

  it('skips providers already requested', () => {
    expect(
      providersNeedingModels({
        catalog: [{ id: 'openai', label: 'OpenAI', hasApiKey: true }],
        savedIds: ['ollama-local'],
        currentProvider: 'openai',
        alreadyRequested: new Set(['openai', 'ollama-local']),
      }),
    ).toEqual([]);
  });

  it('works from saved ids alone (catalog not yet received)', () => {
    expect(
      providersNeedingModels({
        savedIds: ['openai-codex'],
        alreadyRequested: new Set(),
      }),
    ).toEqual(['openai-codex']);
  });
});

describe('findModelContextWindow', () => {
  const models: Record<string, ModelDescriptor[]> = {
    openai: [
      { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128_000 },
      { id: 'unknown-ctx', name: 'No window' },
    ],
  };

  it('returns the declared window for a known model', () => {
    expect(findModelContextWindow(models, 'openai', 'gpt-4o')).toBe(128_000);
  });

  it('returns undefined for missing providers, models, or undeclared windows', () => {
    expect(findModelContextWindow(models, 'anthropic', 'gpt-4o')).toBeUndefined();
    expect(findModelContextWindow(models, 'openai', 'gpt-3.5')).toBeUndefined();
    expect(findModelContextWindow(models, 'openai', 'unknown-ctx')).toBeUndefined();
  });
});

describe('planModelSwitch', () => {
  const models: Record<string, ModelDescriptor[]> = {
    anthropic: [{ id: 'claude-opus-4', name: 'Claude Opus 4', contextWindow: 200_000 }],
    openai: [
      { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128_000 },
      { id: 'gpt-4.1', name: 'GPT-4.1', contextWindow: 1_000_000 },
      { id: 'probed', name: 'Probed model' },
    ],
  };

  it('is a noop for the active provider+model or an empty selection', () => {
    expect(
      planModelSwitch({
        models,
        currentProvider: 'anthropic',
        currentModel: 'claude-opus-4',
        nextProvider: 'anthropic',
        nextModel: 'claude-opus-4',
      }),
    ).toEqual({ kind: 'noop' });
    expect(
      planModelSwitch({
        models,
        currentProvider: 'anthropic',
        currentModel: 'claude-opus-4',
        nextProvider: '',
        nextModel: '',
      }),
    ).toEqual({ kind: 'noop' });
  });

  it('warns when the new model window is smaller, across providers', () => {
    expect(
      planModelSwitch({
        models,
        currentProvider: 'anthropic',
        currentModel: 'claude-opus-4',
        nextProvider: 'openai',
        nextModel: 'gpt-4o',
      }),
    ).toEqual({
      kind: 'warn',
      modelName: 'GPT-4o',
      currentWindow: 200_000,
      nextWindow: 128_000,
    });
  });

  it('warns within the same provider too', () => {
    expect(
      planModelSwitch({
        models,
        currentProvider: 'openai',
        currentModel: 'gpt-4.1',
        nextProvider: 'openai',
        nextModel: 'gpt-4o',
      }),
    ).toEqual({
      kind: 'warn',
      modelName: 'GPT-4o',
      currentWindow: 1_000_000,
      nextWindow: 128_000,
    });
  });

  it('falls back to the session maxContext for the current window', () => {
    expect(
      planModelSwitch({
        models: { openai: models['openai'] ?? [] },
        currentProvider: 'custom-local',
        currentModel: 'my-fine-tune',
        sessionMaxContext: 256_000,
        nextProvider: 'openai',
        nextModel: 'gpt-4o',
      }),
    ).toEqual({
      kind: 'warn',
      modelName: 'GPT-4o',
      currentWindow: 256_000,
      nextWindow: 128_000,
    });
  });

  it('switches directly when the new window is equal or larger', () => {
    expect(
      planModelSwitch({
        models,
        currentProvider: 'openai',
        currentModel: 'gpt-4o',
        nextProvider: 'openai',
        nextModel: 'gpt-4.1',
      }),
    ).toEqual({ kind: 'switch' });
    expect(
      planModelSwitch({
        models,
        currentProvider: 'openai',
        currentModel: 'gpt-4o',
        nextProvider: 'anthropic',
        nextModel: 'claude-opus-4',
      }),
    ).toEqual({ kind: 'switch' });
  });

  it('switches without warning when either window is unknown', () => {
    // Next window unknown (probed model with no declared contextWindow).
    expect(
      planModelSwitch({
        models,
        currentProvider: 'anthropic',
        currentModel: 'claude-opus-4',
        nextProvider: 'openai',
        nextModel: 'probed',
      }),
    ).toEqual({ kind: 'switch' });
    // Current window unknown and no session fallback.
    expect(
      planModelSwitch({
        models,
        currentProvider: 'custom-local',
        currentModel: 'my-fine-tune',
        nextProvider: 'openai',
        nextModel: 'gpt-4o',
      }),
    ).toEqual({ kind: 'switch' });
  });
});
