import * as os from 'node:os';
import * as path from 'node:path';
import { DefaultLogger, DefaultModelsRegistry, type ModelsDevPayload } from '@wrongstack/core';
import { describe, expect, it, vi } from 'vitest';
import { buildProviderFactoriesFromRegistry } from '../src/index.js';

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
        limit: { context: 200_000 },
      },
    },
  },
  groq: {
    id: 'groq',
    name: 'Groq',
    env: ['GROQ_API_KEY'],
    npm: '@ai-sdk/groq',
    api: 'https://api.groq.com/openai/v1',
    models: { 'llama-3.3-70b': { id: 'llama-3.3-70b', name: 'Llama 3.3' } },
  },
  google: {
    id: 'google',
    name: 'Google',
    env: ['GEMINI_API_KEY'],
    npm: '@ai-sdk/google',
    models: { 'gemini-2.5-flash': { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' } },
  },
  mistral: {
    id: 'mistral',
    name: 'Mistral',
    npm: '@ai-sdk/mistral',
    env: ['MISTRAL_API_KEY'],
    api: 'https://api.mistral.ai/v1',
    models: { 'mistral-large': { id: 'mistral-large', name: 'Mistral Large' } },
  },
};

function makeRegistry() {
  return new DefaultModelsRegistry({
    cacheFile: path.join(os.tmpdir(), `wstack-factest-${Date.now()}.json`),
    seed: SAMPLE,
  });
}

describe('buildProviderFactoriesFromRegistry', () => {
  it('produces a factory for each supported provider plus generic openai-compatible', async () => {
    const registry = makeRegistry();
    const factories = await buildProviderFactoriesFromRegistry({ registry });
    const types = factories.map((f) => f.type).sort();
    expect(types).toContain('anthropic');
    expect(types).toContain('groq');
    expect(types).toContain('google');
    expect(types).toContain('mistral');
    expect(types).toContain('openai-compatible');
  });

  it('anthropic factory builds an AnthropicProvider', async () => {
    const registry = makeRegistry();
    const factories = await buildProviderFactoriesFromRegistry({ registry });
    const f = factories.find((x) => x.type === 'anthropic');
    const provider = f!.create({ type: 'anthropic', apiKey: 'sk-test' });
    expect(provider.id).toBe('anthropic');
  });

  it('groq factory builds an openai-compatible provider with the catalog base URL', async () => {
    const registry = makeRegistry();
    const factories = await buildProviderFactoriesFromRegistry({ registry });
    const f = factories.find((x) => x.type === 'groq');
    const provider = f!.create({ type: 'groq', apiKey: 'gsk-test' });
    expect(provider.id).toBe('groq');
  });

  it('rejects invalid compatibility quirks', async () => {
    const registry = makeRegistry();
    const factories = await buildProviderFactoriesFromRegistry({ registry });
    const f = factories.find((x) => x.type === 'groq');
    expect(() =>
      f!.create({
        type: 'groq',
        apiKey: 'gsk-test',
        quirks: { unknownField: true },
      }),
    ).toThrow(/Invalid quirks/);
  });

  it('google factory builds a GoogleProvider', async () => {
    const registry = makeRegistry();
    const factories = await buildProviderFactoriesFromRegistry({ registry });
    const f = factories.find((x) => x.type === 'google');
    const provider = f!.create({ type: 'google', apiKey: 'AIza-test' });
    expect(provider.id).toBe('google');
  });

  it('mistral factory builds an openai-compatible provider from the catalog', async () => {
    const registry = makeRegistry();
    const factories = await buildProviderFactoriesFromRegistry({ registry });
    const f = factories.find((x) => x.type === 'mistral');
    const provider = f!.create({ type: 'mistral', apiKey: 'msk-test' });
    expect(provider.id).toBe('mistral');
  });

  it('reads apiKey from env vars when not provided in config', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-from-env-' + Math.random();
    try {
      const registry = makeRegistry();
      const factories = await buildProviderFactoriesFromRegistry({ registry });
      const f = factories.find((x) => x.type === 'anthropic');
      const provider = f!.create({ type: 'anthropic' });
      expect(provider.id).toBe('anthropic');
    } finally {
      delete process.env['ANTHROPIC_API_KEY'];
    }
  });

  it('throws on missing apiKey + missing env', async () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const registry = makeRegistry();
    const factories = await buildProviderFactoriesFromRegistry({ registry });
    const f = factories.find((x) => x.type === 'anthropic');
    expect(() => f!.create({ type: 'anthropic' })).toThrow(/API key/);
  });

  it('logs unsupported providers via the logger', async () => {
    const registry = makeRegistry();
    const logger = new DefaultLogger({ level: 'info' });
    const spy = vi.spyOn(logger, 'info');
    await buildProviderFactoriesFromRegistry({ registry, log: logger });
    const calls = spy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => m.includes('mistral'))).toBe(false);
  });
});
