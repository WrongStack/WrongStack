import type { ProviderAuthOutcome, ProviderConfig } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import { applyProviderAuthOutcome, createBuiltinProviderAuthRegistry } from '../src/oauth/index.js';

function outcome(overrides: Partial<ProviderAuthOutcome> = {}): ProviderAuthOutcome {
  return {
    providerId: 'openrouter',
    family: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['model-a'],
    credential: {
      label: 'oauth-default',
      apiKey: 'secret',
      createdAt: '2026-09-08T00:00:00.000Z',
      authMethod: 'oauth',
    },
    ...overrides,
  };
}

describe('built-in provider auth strategies', () => {
  it('publishes the existing three login flows through one registry', () => {
    const registry = createBuiltinProviderAuthRegistry();
    expect(registry.list().map((entry) => entry.id)).toEqual([
      'chatgpt',
      'claude',
      'copilot',
      'openrouter',
    ]);
    expect(registry.resolveId('openai-codex')).toBe('chatgpt');
    expect(registry.resolveId('anthropic-oauth')).toBe('claude');
    expect(registry.resolveId('github-copilot')).toBe('copilot');
    expect(registry.get('copilot')?.interactionTypes).toEqual(['device_code']);
    expect(registry.resolveId('openrouter-login')).toBe('openrouter');
    expect(registry.resolveId('openrouter-oauth')).toBe('openrouter');
  });
});

describe('applyProviderAuthOutcome', () => {
  it('upserts credentials, preserves aliases, and clears the legacy plaintext key', () => {
    const providers: Record<string, ProviderConfig> = {
      work: {
        type: 'openrouter',
        apiKey: 'legacy',
        baseUrl: 'https://custom.test/v1',
        models: ['curated'],
        apiKeys: [
          { label: 'oauth-default', apiKey: 'old', createdAt: 'old' },
          { label: 'backup', apiKey: 'backup', createdAt: 'old' },
        ],
      },
    };

    const applied = applyProviderAuthOutcome(providers, outcome({ models: [] }), {
      targetProviderId: 'work',
    });

    expect(applied.providerId).toBe('work');
    expect(applied.provider.type).toBe('openrouter');
    expect(applied.provider.baseUrl).toBe('https://custom.test/v1');
    expect(applied.provider.models).toEqual(['curated']);
    expect(applied.provider.apiKey).toBeUndefined();
    expect(applied.provider.activeKey).toBe('oauth-default');
    expect(applied.provider.apiKeys?.map((entry) => entry.label)).toEqual([
      'backup',
      'oauth-default',
    ]);
  });

  it('populates a new provider and stores discovered models', () => {
    const providers: Record<string, ProviderConfig> = {};
    const applied = applyProviderAuthOutcome(providers, outcome());

    expect(providers.openrouter).toBe(applied.provider);
    expect(applied.provider).toMatchObject({
      type: 'openrouter',
      family: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      models: ['model-a'],
      activeKey: 'oauth-default',
    });
  });
});
