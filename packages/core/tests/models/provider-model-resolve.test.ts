import { describe, expect, it } from 'vitest';
import {
  describeCatalogModel,
  resolveProviderModelList,
} from '../../src/models/provider-model-resolve.js';
import type { ModelsDevModel, ResolvedProvider } from '../../src/types/models-registry.js';

function catalogModel(over: Partial<ModelsDevModel> = {}): ModelsDevModel {
  return { id: 'm', name: 'M', ...over };
}

function catalog(models: ModelsDevModel[]): ResolvedProvider {
  return { id: 'p', name: 'P', family: 'openai', envVars: [], models };
}

describe('describeCatalogModel', () => {
  it('maps metadata and capability flags', () => {
    const d = describeCatalogModel(
      catalogModel({
        id: 'gpt-x',
        name: 'GPT X',
        release_date: '2026-01-01',
        limit: { context: 200000 },
        cost: { input: 1, output: 2 },
        tool_call: true,
        reasoning: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        open_weights: true,
      }),
    );
    expect(d).toEqual({
      id: 'gpt-x',
      name: 'GPT X',
      releaseDate: '2026-01-01',
      contextWindow: 200000,
      inputCost: 1,
      outputCost: 2,
      outputModalities: ['text'],
      capabilities: ['tools', 'reasoning', 'vision', 'open_weights'],
    });
  });

  it('emits no capabilities for a bare model', () => {
    expect(describeCatalogModel(catalogModel()).capabilities).toEqual([]);
  });

  it('surfaces an overlay description when present, omits it otherwise', () => {
    expect(
      describeCatalogModel(catalogModel({ description: 'Ultra-fast coding model.' })),
    ).toMatchObject({ description: 'Ultra-fast coding model.' });
    expect(describeCatalogModel(catalogModel())).not.toHaveProperty('description');
  });
});

describe('resolveProviderModelList', () => {
  it('returns the full catalog list when there is no saved allowlist', () => {
    const list = resolveProviderModelList(
      undefined,
      catalog([catalogModel({ id: 'a' }), catalogModel({ id: 'b' })]),
    );
    expect(list.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('uses the saved allowlist as authoritative (OAuth / subscription providers)', () => {
    // github-copilot shape: no catalog entry, models come only from config.
    const list = resolveProviderModelList(['gpt-5-mini', 'claude-haiku-4.5'], undefined);
    expect(list).toEqual([
      { id: 'gpt-5-mini', name: 'gpt-5-mini', capabilities: [] },
      { id: 'claude-haiku-4.5', name: 'claude-haiku-4.5', capabilities: [] },
    ]);
  });

  it('enriches saved allowlist ids with catalog metadata when ids match', () => {
    const list = resolveProviderModelList(
      ['known', 'unknown'],
      catalog([
        catalogModel({ id: 'known', name: 'Known', limit: { context: 128000 }, tool_call: true }),
      ]),
    );
    expect(list[0]).toMatchObject({
      id: 'known',
      name: 'Known',
      contextWindow: 128000,
      capabilities: ['tools'],
    });
    expect(list[1]).toEqual({ id: 'unknown', name: 'unknown', capabilities: [] });
  });

  it('enriches openai-codex ids with canonical name + description (no catalog)', () => {
    const list = resolveProviderModelList(['gpt-5.5', 'gpt-5.4-mini'], undefined);
    expect(list).toEqual([
      {
        id: 'gpt-5.5',
        name: 'GPT-5.5',
        description: 'Frontier model for complex coding, research, and real-world work.',
        capabilities: [],
      },
      {
        id: 'gpt-5.4-mini',
        name: 'GPT-5.4 Mini',
        description: 'Small, fast, and cost-efficient model for simpler coding tasks.',
        capabilities: [],
      },
    ]);
  });

  it('layers the codex description onto a catalog hit for the same id', () => {
    const list = resolveProviderModelList(
      ['gpt-5.5'],
      catalog([catalogModel({ id: 'gpt-5.5', name: 'GPT-5.5', limit: { context: 400000 } })]),
    );
    expect(list[0]).toMatchObject({
      id: 'gpt-5.5',
      name: 'GPT-5.5',
      contextWindow: 400000,
      description: 'Frontier model for complex coding, research, and real-world work.',
    });
  });

  it('returns an empty list (never an error) for an unknown provider with no allowlist', () => {
    expect(resolveProviderModelList(undefined, undefined)).toEqual([]);
    expect(resolveProviderModelList([], undefined)).toEqual([]);
  });

  it('falls back to the canonical codex list for openai-codex when config + catalog are empty', () => {
    // User deleted cfg.models AND the models.dev/overlay catalog is unavailable
    // (e.g. offline). The provider must still surface the ChatGPT sign-in models.
    const list = resolveProviderModelList([], undefined, 'openai-codex');
    expect(list.map((m) => m.id)).toEqual([
      'gpt-6-astra',
      'gpt-5.6-sol',
      'gpt-5.5',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.4-mini',
      'gpt-5.3-codex-spark',
    ]);
    expect(list[0]).toMatchObject({
      id: 'gpt-6-astra',
      name: 'GPT-6 Astra',
      description: 'Most capable model for complex work across code, apps, and research.',
      capabilities: [],
    });
  });

  it('falls back to the codex list for openai-codex when the catalog has zero models', () => {
    const list = resolveProviderModelList(undefined, catalog([]), 'openai-codex');
    expect(list.map((m) => m.id)).toEqual([
      'gpt-6-astra',
      'gpt-5.6-sol',
      'gpt-5.5',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.4-mini',
      'gpt-5.3-codex-spark',
    ]);
  });

  it('does not synthesize codex models for non-codex providers', () => {
    expect(resolveProviderModelList([], undefined, 'openai')).toEqual([]);
    expect(resolveProviderModelList([], catalog([]), 'openai')).toEqual([]);
  });
});
