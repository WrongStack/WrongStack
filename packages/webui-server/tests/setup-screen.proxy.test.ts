/**
 * Unit tests for the WrongProxy rewrite applied in `resolveSetupProvider`
 * (packages/webui-server/src/server/setup-screen.ts) with the proxy
 * `active=true` vs `false`, mocking `applyProxyConfig` (delegating spy on the
 * real singleton) and the provider factory.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeProviderFromConfig } from '@wrongstack/providers';
import {
  applyProxyConfig,
  __resetProxyConfigForTests,
} from '@wrongstack/core/wiring/proxy-rewrite';
import type { Config } from '@wrongstack/core/types';
import type { ProviderRegistry } from '@wrongstack/core/registry';

vi.mock('@wrongstack/core/wiring/proxy-rewrite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/core/wiring/proxy-rewrite')>();
  return {
    ...actual,
    applyProxyConfig: vi.fn((next: Parameters<typeof applyProxyConfig>[0]) =>
      actual.applyProxyConfig(next),
    ),
  };
});

vi.mock('@wrongstack/providers', () => ({
  // Capture the routed cfg so tests can assert the effective baseUrl without
  // constructing a real SDK provider.
  makeProviderFromConfig: vi.fn(
    (id: string, cfg: Record<string, unknown>) => ({ id, ...cfg, capabilities: {} }),
  ),
}));

import { resolveSetupProvider } from '../src/server/setup-screen.js';

function openaiConfig(): Config {
  return {
    version: 1,
    provider: 'openai',
    model: 'gpt-4o',
    features: { modelsRegistry: false },
    providers: {
      openai: { type: 'openai', apiKey: 'sk-test', baseUrl: 'https://api.openai.com/v1' },
    },
  } as unknown as Config;
}

const registry = { has: () => false } as unknown as ProviderRegistry;

beforeEach(() => {
  __resetProxyConfigForTests();
  vi.mocked(applyProxyConfig).mockClear();
});

afterEach(() => __resetProxyConfigForTests());

describe('resolveSetupProvider proxy rewrite', () => {
  it('rewrites the configured provider baseUrl through the proxy when active', () => {
    applyProxyConfig({ enabled: true, url: 'http://localhost:8000', active: true });
    const result = resolveSetupProvider({ config: openaiConfig(), needsProvider: false, providerRegistry: registry });
    expect(result.needsSetup).toBe(false);
    expect(makeProviderFromConfig).toHaveBeenCalledWith(
      'openai',
      expect.objectContaining({ baseUrl: 'http://localhost:8000/proxy/api.openai.com/v1' }),
    );
    expect((result.provider as { baseUrl?: string }).baseUrl).toBe(
      'http://localhost:8000/proxy/api.openai.com/v1',
    );
  });

  it('keeps the raw baseUrl when active=false', () => {
    applyProxyConfig({ enabled: true, url: 'http://localhost:8000', active: false });
    const result = resolveSetupProvider({ config: openaiConfig(), needsProvider: false, providerRegistry: registry });
    expect(makeProviderFromConfig).toHaveBeenCalledWith(
      'openai',
      expect.objectContaining({ baseUrl: 'https://api.openai.com/v1' }),
    );
    expect((result.provider as { baseUrl?: string }).baseUrl).toBe('https://api.openai.com/v1');
  });

  it('keeps the raw baseUrl when the singleton is never enabled', () => {
    const result = resolveSetupProvider({ config: openaiConfig(), needsProvider: false, providerRegistry: registry });
    expect(makeProviderFromConfig).toHaveBeenCalledWith(
      'openai',
      expect.objectContaining({ baseUrl: 'https://api.openai.com/v1' }),
    );
    expect((result.provider as { baseUrl?: string }).baseUrl).toBe('https://api.openai.com/v1');
  });

  it('rewrites the first saved provider in Branch 2 when active', () => {
    applyProxyConfig({ enabled: true, url: 'http://localhost:8000', active: true });
    const config = {
      version: 1,
      provider: 'openai',
      model: 'gpt-4o',
      features: { modelsRegistry: false },
      providers: {
        anthropic: { type: 'anthropic', apiKey: 'sk-test', baseUrl: 'https://api.anthropic.com/v1' },
      },
    } as unknown as Config;
    const result = resolveSetupProvider({ config, needsProvider: true, providerRegistry: registry });
    expect(result.needsSetup).toBe(false);
    expect(makeProviderFromConfig).toHaveBeenCalledWith(
      'anthropic',
      expect.objectContaining({ baseUrl: 'http://localhost:8000/proxy/api.anthropic.com/v1' }),
    );
  });
});