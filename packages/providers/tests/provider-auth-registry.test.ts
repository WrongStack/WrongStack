import type { ProviderAuthOutcome, ProviderConfig } from '@wrongstack/contracts/types';
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
  it('publishes every built-in login flow through one registry', () => {
    const registry = createBuiltinProviderAuthRegistry();
    expect(registry.list().map((entry) => entry.id)).toEqual([
      'chatgpt',
      'copilot',
      'openrouter',
      'antigravity',
      'xai',
      'kimi',
      'meta',
      'chatgpt-api',
    ]);
    expect(registry.resolveId('openai-codex')).toBe('chatgpt');
    expect(registry.resolveId('anthropic-oauth')).toBeUndefined();
    expect(registry.resolveId('github-copilot')).toBe('copilot');
    expect(registry.get('copilot')?.interactionTypes).toEqual(['device_code']);
    expect(registry.resolveId('openrouter-login')).toBe('openrouter');
    expect(registry.resolveId('openrouter-oauth')).toBe('openrouter');
    expect(registry.resolveId('google-antigravity')).toBe('antigravity');
    expect(registry.resolveId('agy')).toBe('antigravity');
  });
});

describe('applyProviderAuthOutcome', () => {
  it('preserves an existing auth profile when a different provider tries to use its alias', () => {
    const providers: Record<string, ProviderConfig> = {
      work: { type: 'anthropic', family: 'anthropic', apiKey: 'keep-existing-key' },
    };
    expect(() =>
      applyProviderAuthOutcome(providers, outcome(), { targetProviderId: 'work' }),
    ).toThrow('another provider');
    expect(providers['work']).toEqual({
      type: 'anthropic',
      family: 'anthropic',
      apiKey: 'keep-existing-key',
    });
  });

  it.each(['account/model', '__proto__', 'constructor'])(
    'rejects an unroutable or reserved account alias %s',
    (targetProviderId) => {
      const providers: Record<string, ProviderConfig> = {};
      expect(() => applyProviderAuthOutcome(providers, outcome(), { targetProviderId })).toThrow(
        'alias',
      );
      expect(Object.keys(providers)).toEqual([]);
    },
  );
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
    expect(applied.provider.models).toEqual([]);
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

  it('retains the canonical provider type for an arbitrary account alias', () => {
    const providers: Record<string, ProviderConfig> = {};
    const applied = applyProviderAuthOutcome(providers, outcome(), {
      targetProviderId: 'personal-account',
    });
    expect(applied.providerId).toBe('personal-account');
    expect(applied.provider.type).toBe('openrouter');
    expect(providers['openrouter']).toBeUndefined();
  });
});
