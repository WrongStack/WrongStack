import type { Config, ProviderConfig } from '@wrongstack/contracts/types';
import { ProviderRegistry } from '@wrongstack/core/registry';
import { createSetupProviderFactory } from '@wrongstack/providers';
import { expect, it, vi } from 'vitest';
import { resolveSetupProvider } from '../src/server/setup-screen.js';

it('boots the explicit setup provider without requiring catalog metadata or credentials', () => {
  const result = resolveSetupProvider({
    config: {
      provider: 'wrongstack-setup',
      model: 'setup',
      features: { modelsRegistry: false },
    } as unknown as Config,
    needsProvider: false,
    providerRegistry: new ProviderRegistry(),
  });
  expect(result.provider.id).toBe('wrongstack-setup');
  expect(result.needsSetup).toBe(false);
});

it.each([false, true])(
  'uses the canonical catalog factory for an alias when needsProvider is %s',
  (needsProvider) => {
    const registry = new ProviderRegistry();
    const create = vi.fn((config: ProviderConfig) => createSetupProviderFactory().create(config));
    registry.register({ type: 'openai', family: 'openai', create });
    const result = resolveSetupProvider({
      config: {
        provider: needsProvider ? 'missing' : 'work',
        features: { modelsRegistry: true },
        providers: { work: { type: 'openai', apiKey: 'fixture-work' } },
      } as unknown as Config,
      needsProvider,
      providerRegistry: registry,
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'work', apiKey: 'fixture-work' }),
    );
    expect(result.provider.id).toBe('work');
  },
);

it.each([false, true])(
  'keeps keyless local account aliases usable when needsProvider is %s',
  (needsProvider) => {
    const result = resolveSetupProvider({
      config: {
        provider: needsProvider ? 'missing-primary' : 'local-work',
        features: { modelsRegistry: false },
        providers: {
          'local-work': {
            type: 'ollama',
            family: 'openai-compatible',
            baseUrl: 'http://127.0.0.1:11434/v1',
            envVars: [],
          },
        },
      } as unknown as Config,
      needsProvider,
      providerRegistry: new ProviderRegistry(),
    });
    expect(result.provider.id).toBe('local-work');
  },
);
