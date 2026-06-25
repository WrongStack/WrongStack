import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ProviderRegistry, type Config, type Provider } from '@wrongstack/core';
import {
  buildProviderForId,
  resolveProviderCfg,
} from '../src/wiring/provider-runtime.js';

// Mock the providers package — we test the resolver / builder in
// isolation from the real provider factory chain. The factories are
// exercised in their own package tests.
vi.mock('@wrongstack/providers', () => ({
  makeProviderFromConfig: vi.fn(),
}));

const providersMod = await import('@wrongstack/providers');
const makeProviderFromConfig = vi.mocked(providersMod.makeProviderFromConfig);

function fakeConfig(overrides: Partial<Config> = {}): Config {
  return {
    version: 1,
    provider: 'anthropic',
    model: 'claude',
    apiKey: 'sk-test',
    features: { mcp: true, plugins: true, memory: true, modelsRegistry: true, skills: true },
    ...overrides,
  } as Config;
}

function fakeProvider(id: string): Provider {
  return { id, capabilities: {} as never, complete: vi.fn(), stream: vi.fn() } as Provider;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveProviderCfg', () => {
  it('plain catalog provider: cfg.type === providerId, factoryType === providerId', () => {
    const cfg = fakeConfig();
    const out = resolveProviderCfg(cfg, 'anthropic');
    expect(out.cfg.type).toBe('anthropic');
    expect(out.factoryType).toBe('anthropic');
    // The cfg is fresh (no saved entry); the apiKey/baseUrl fall through
    // from the top-level config so the resulting Provider has credentials.
    expect(out.cfg.apiKey).toBe('sk-test');
  });

  it('saved-config alias with type: cfg.type === providerId (NOT the wire family)', () => {
    // Regression for issue #16. The user picks `minimax-coding-plan` as a
    // saved-config alias that uses the `anthropic` wire family. The bug
    // was that the cfg.type was rewritten to `anthropic` (the saved
    // `type`), which made the resulting Provider's `.id === 'anthropic'`.
    // The fix: cfg.type stays `minimax-coding-plan` so the Provider's id
    // matches the user's chosen id.
    const cfg = fakeConfig({
      providers: {
        'minimax-coding-plan': {
          type: 'anthropic',
          apiKey: 'sk-minimax',
          family: 'anthropic',
          models: ['MiniMax-M3'],
        },
      },
    });
    const out = resolveProviderCfg(cfg, 'minimax-coding-plan');
    expect(out.cfg.type).toBe('minimax-coding-plan'); // not 'anthropic'
    expect(out.factoryType).toBe('anthropic');
    expect(out.cfg.apiKey).toBe('sk-minimax');
    expect(out.cfg.family).toBe('anthropic');
  });

  it('saved-config alias without type: factoryType === providerId', () => {
    // A saved config with no explicit `type` falls through to the
    // user-visible id for both cfg.type and factoryType.
    const cfg = fakeConfig({
      providers: {
        'my-proxy': { apiKey: 'sk-proxy', family: 'openai-compatible' },
      },
    });
    const out = resolveProviderCfg(cfg, 'my-proxy');
    expect(out.cfg.type).toBe('my-proxy');
    expect(out.factoryType).toBe('my-proxy');
    expect(out.cfg.family).toBe('openai-compatible');
  });

  it('top-level apiKey/baseUrl are the fallback when the saved cfg omits them', () => {
    const cfg = fakeConfig({
      apiKey: 'sk-top',
      baseUrl: 'https://top.example.com',
      providers: {
        'minimax-coding-plan': { type: 'anthropic', family: 'anthropic' },
      },
    });
    const out = resolveProviderCfg(cfg, 'minimax-coding-plan');
    expect(out.cfg.apiKey).toBe('sk-top');
    expect(out.cfg.baseUrl).toBe('https://top.example.com');
  });
});

describe('buildProviderForId', () => {
  it('saved-config alias: returns Provider with id === providerId (NOT the wire family)', () => {
    // Regression for issue #16: prior to the fix, the saved config's
    // `type` leaked into the resulting Provider's id, so a saved-config
    // alias like `minimax-coding-plan` (with `type: 'anthropic'`) ended
    // up with `id: 'anthropic'` after any /model / fallback / resume call.
    // The fix: buildProviderForId always returns a Provider whose `id` is
    // the user-visible providerId.
    const cfg = fakeConfig({
      providers: {
        'minimax-coding-plan': {
          type: 'anthropic',
          apiKey: 'sk-minimax',
          family: 'anthropic',
          models: ['MiniMax-M3'],
        },
      },
    });
    const registry = new ProviderRegistry();

    // We hit the `makeProviderFromConfig` path because the registry has
    // no factory registered for the user-visible id `minimax-coding-plan`.
    makeProviderFromConfig.mockReturnValue(fakeProvider('minimax-coding-plan'));

    const provider = buildProviderForId({ config: cfg, providerRegistry: registry }, 'minimax-coding-plan');

    expect(provider.id).toBe('minimax-coding-plan');
    // Verify the call site: id parameter must be the user-visible id, not
    // the saved type.
    expect(makeProviderFromConfig).toHaveBeenCalledWith(
      'minimax-coding-plan',
      expect.objectContaining({ type: 'minimax-coding-plan', family: 'anthropic' }),
    );
  });

  it('plain catalog provider with a registered factory: uses registry path', () => {
    // When the saved config's type (or the providerId itself) is in the
    // catalog registry, the registry path is used. The Provider still has
    // the user-visible id because `cfg.type === providerId` flows through
    // to the factory which constructs the Provider from cfg.
    const cfg = fakeConfig({
      providers: {
        anthropic: { type: 'anthropic', apiKey: 'sk', family: 'anthropic' },
      },
    });
    const registry = new ProviderRegistry();
    const anthropicFactory = {
      type: 'anthropic',
      family: 'anthropic' as const,
      create: vi.fn((c: { type: string }) => fakeProvider(c.type)),
    };
    registry.register(anthropicFactory);

    const provider = buildProviderForId({ config: cfg, providerRegistry: registry }, 'anthropic');
    expect(provider.id).toBe('anthropic');
    // The factory's create method received cfg.type === 'anthropic'.
    expect(anthropicFactory.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'anthropic' }),
    );
    // makeProviderFromConfig is NOT called on the registry path.
    expect(makeProviderFromConfig).not.toHaveBeenCalled();
  });

  it('catalog disabled: falls through to makeProviderFromConfig regardless of factory availability', () => {
    // `features.modelsRegistry === false` disables the registry path.
    const cfg = fakeConfig({
      features: { mcp: true, plugins: true, memory: true, modelsRegistry: false, skills: true },
    });
    const registry = new ProviderRegistry();
    makeProviderFromConfig.mockReturnValue(fakeProvider('anthropic'));

    buildProviderForId({ config: cfg, providerRegistry: registry }, 'anthropic');
    expect(makeProviderFromConfig).toHaveBeenCalledTimes(1);
  });
});
