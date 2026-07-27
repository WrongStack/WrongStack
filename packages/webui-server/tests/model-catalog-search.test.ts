import type { ModelsDevModel, ResolvedProvider } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import { searchCatalogModels } from '../src/server/model-catalog-search.js';

function provider(id: string, name: string, models: ModelsDevModel[]): ResolvedProvider {
  return { id, name, family: 'openai', envVars: [], models, npm: undefined };
}

const SAMPLE_MODELS: ModelsDevModel[] = [
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    tool_call: true,
    reasoning: false,
    modalities: { input: ['text', 'image'], output: ['text'] },
    limit: { context: 128_000, output: 16_384 },
    cost: { input: 2.5, output: 10 },
    release_date: '2025-05-13',
  },
  {
    id: 'gpt-4o-mini',
    name: 'GPT-4o Mini',
    tool_call: true,
    reasoning: false,
    limit: { context: 128_000, output: 16_384 },
    cost: { input: 0.15, output: 0.6 },
  },
  {
    id: 'claude-sonnet-4',
    name: 'Claude Sonnet 4',
    tool_call: true,
    reasoning: true,
    modalities: { input: ['text', 'image'], output: ['text'] },
    limit: { context: 200_000, output: 8_192 },
    cost: { input: 3, output: 15 },
    release_date: '2025-05-14',
  },
  {
    id: 'claude-opus-4',
    name: 'Claude Opus 4',
    tool_call: true,
    reasoning: true,
    modalities: { input: ['text', 'image'], output: ['text'] },
    limit: { context: 200_000, output: 8_192 },
    cost: { input: 15, output: 75 },
  },
  {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    tool_call: true,
    reasoning: true,
    modalities: { input: ['text', 'image', 'audio'], output: ['text'] },
    limit: { context: 1_048_576, output: 65_536 },
    cost: { input: 1.25, output: 10 },
    open_weights: false,
  },
  {
    id: 'deepseek-chat',
    name: 'DeepSeek Chat',
    tool_call: true,
    reasoning: false,
    modalities: { input: ['text'], output: ['text'] },
    limit: { context: 1_000_000, output: 8_192 },
    cost: { input: 0.14, output: 0.28 },
    open_weights: true,
  },
  {
    id: 'deepseek-r1',
    name: 'DeepSeek R1',
    tool_call: false,
    reasoning: true,
    modalities: { input: ['text'], output: ['text'] },
    limit: { context: 1_000_000, output: 8_192 },
  },
];

const PROVIDERS: ResolvedProvider[] = [
  provider('openai', 'OpenAI', [SAMPLE_MODELS[0]!, SAMPLE_MODELS[1]!]),
  provider('anthropic', 'Anthropic', [SAMPLE_MODELS[2]!, SAMPLE_MODELS[3]!]),
  provider('google', 'Google', [SAMPLE_MODELS[4]!]),
  provider('deepseek', 'DeepSeek', [SAMPLE_MODELS[5]!, SAMPLE_MODELS[6]!]),
];

function fakeRegistry() {
  return {
    listProviders: async () => PROVIDERS,
  };
}

describe('searchCatalogModels', () => {
  it('returns empty for empty query', async () => {
    const results = await searchCatalogModels(fakeRegistry(), '', 8);
    expect(results).toEqual([]);
  });

  it('returns empty for whitespace query', async () => {
    const results = await searchCatalogModels(fakeRegistry(), '   ', 8);
    expect(results).toEqual([]);
  });

  it('returns exact id match at top', async () => {
    const results = await searchCatalogModels(fakeRegistry(), 'gpt-4o', 8);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.modelId).toBe('gpt-4o');
    expect(results[0]!.providerId).toBe('openai');
    expect(results[0]!.contextWindow).toBe(128_000);
    expect(results[0]!.maxOutput).toBe(16_384);
  });

  it('returns exact name match high in ranking', async () => {
    const results = await searchCatalogModels(fakeRegistry(), 'GPT-4o Mini', 8);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.modelId).toBe('gpt-4o-mini');
  });

  it('returns prefix matches', async () => {
    const results = await searchCatalogModels(fakeRegistry(), 'claude', 8);
    const ids = results.map((r) => r.modelId);
    expect(ids).toContain('claude-sonnet-4');
    expect(ids).toContain('claude-opus-4');
    // Shorter suffix has a higher prefix-match score: "claude-opus-4" (8 extra chars)
    // ranks ahead of "claude-sonnet-4" (9 extra chars).
    expect(ids.indexOf('claude-opus-4')).toBeLessThan(ids.indexOf('claude-sonnet-4'));
  });

  it('returns substring matches', async () => {
    const results = await searchCatalogModels(fakeRegistry(), 'deep', 8);
    const ids = results.map((r) => r.modelId);
    expect(ids).toContain('deepseek-chat');
    expect(ids).toContain('deepseek-r1');
  });

  it('respects the limit parameter', async () => {
    const results = await searchCatalogModels(fakeRegistry(), 'gpt', 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('clamps limit between 1 and 20', async () => {
    const results = await searchCatalogModels(fakeRegistry(), 'gpt', -1);
    expect(results.length).toBeLessThanOrEqual(20);
  });

  it('exposes capability flags in matches', async () => {
    const [sonnet] = await searchCatalogModels(fakeRegistry(), 'claude-sonnet-4', 1);
    expect(sonnet?.capabilities).toContain('tools');
    expect(sonnet?.capabilities).toContain('reasoning');
    expect(sonnet?.capabilities).toContain('vision');
  });

  it('includes cost and release date when available', async () => {
    const [match] = await searchCatalogModels(fakeRegistry(), 'gpt-4o', 1);
    expect(match?.inputCost).toBe(2.5);
    expect(match?.outputCost).toBe(10);
    expect(match?.releaseDate).toBe('2025-05-13');
  });

  it('scores exact model id above prefix match', async () => {
    const results = await searchCatalogModels(fakeRegistry(), 'deepseek-chat', 8);
    expect(results[0]!.modelId).toBe('deepseek-chat');
  });

  it('scores exact name above prefix', async () => {
    const results = await searchCatalogModels(fakeRegistry(), 'DeepSeek R1', 8);
    expect(results[0]!.modelId).toBe('deepseek-r1');
  });
});
