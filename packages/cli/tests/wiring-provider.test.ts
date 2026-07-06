import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Config, Logger, ModelsRegistry, ResolvedProvider } from '@wrongstack/core';
import { setupProvider } from '../src/wiring/provider.js';
import { expectConfigError } from './helpers/config-error.js';

// Mock the providers package — we test setupProvider in isolation from
// the real provider factory chain. The factories are exercised in their
// own package tests. `capabilitiesFor` is the real implementation so
// the per-model catalog resolution path (which is what Chimera depends
// on) actually runs.
vi.mock('@wrongstack/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/providers')>();
  return {
    ...actual,
    buildProviderFactoriesFromRegistry: vi.fn(),
    makeProviderFromConfig: vi.fn(),
  };
});

const providersMod = await import('@wrongstack/providers');
const buildProviderFactoriesFromRegistry = vi.mocked(
  providersMod.buildProviderFactoriesFromRegistry,
);
const makeProviderFromConfig = vi.mocked(providersMod.makeProviderFromConfig);

function fakeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
    setLevel: vi.fn(),
  } as never as Logger;
}

function fakeModelsRegistry(overrides: Partial<ModelsRegistry> = {}): ModelsRegistry {
  return {
    getProvider: vi.fn().mockResolvedValue(undefined),
    listProviders: vi.fn(),
    suggestModel: vi.fn(),
    refresh: vi.fn(),
    ...overrides,
  } as never as ModelsRegistry;
}

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

const fakeFactory = { type: 'anthropic', create: () => ({}) } as never;
const fakeProviderInstance = { name: 'anthropic-instance' } as never;

beforeEach(() => {
  vi.clearAllMocks();
  buildProviderFactoriesFromRegistry.mockResolvedValue([fakeFactory]);
  makeProviderFromConfig.mockReturnValue(fakeProviderInstance);
});

describe('setupProvider', () => {
  it('resolves provider and creates via registry on happy path', async () => {
    const resolved = { family: 'anthropic', npm: '@anthropic-ai/sdk' } as ResolvedProvider;
    const modelsRegistry = fakeModelsRegistry({
      getProvider: vi.fn().mockResolvedValue(resolved),
    });

    const out = await setupProvider({
      config: fakeConfig(),
      modelsRegistry,
      logger: fakeLogger(),
    });

    expect(out.resolvedProvider).toBe(resolved);
    expect(out.providerRegistry.has('anthropic')).toBe(true);
    // Registry path used — makeProviderFromConfig should NOT be called.
    expect(makeProviderFromConfig).not.toHaveBeenCalled();
    expect(out.provider).toBeDefined();
  });

  it('falls back to savedProviderCfg.type when primary lookup misses', async () => {
    const resolved = { family: 'openai', npm: 'openai' } as ResolvedProvider;
    // setupProvider calls getProvider twice (primary + savedCfg.type) for
    // provider resolution, and capabilitiesFor() then calls it a third
    // time to compute the family baseline. Mock all three to return the
    // saved-config entry so capability resolution doesn't drop the test
    // into the unsupported family.
    const getProvider = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve(undefined))
      .mockImplementationOnce(() => Promise.resolve(resolved))
      .mockImplementation(() => Promise.resolve(resolved));
    const modelsRegistry = fakeModelsRegistry({ getProvider });

    const out = await setupProvider({
      config: fakeConfig({
        provider: 'my-openai',
        providers: { 'my-openai': { type: 'openai', apiKey: 'sk' } },
      }),
      modelsRegistry,
      logger: fakeLogger(),
    });

    expect(getProvider).toHaveBeenCalledTimes(3);
    expect(out.resolvedProvider).toBe(resolved);
  });

  it('warns when provider unresolved and no saved family', async () => {
    const logger = fakeLogger();
    await setupProvider({
      config: fakeConfig({ provider: 'mystery' }),
      modelsRegistry: fakeModelsRegistry(),
      logger,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('"mystery" not found in models.dev'),
    );
  });

  it('does NOT warn when saved provider has family override', async () => {
    const logger = fakeLogger();
    await setupProvider({
      config: fakeConfig({
        provider: 'mystery',
        providers: { mystery: { type: 'mystery', family: 'openai' } as never },
      }),
      modelsRegistry: fakeModelsRegistry(),
      logger,
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('seeds openai-codex with the current Codex fallback models when no saved list exists', async () => {
    const out = await setupProvider({
      config: fakeConfig({
        provider: 'openai-codex',
        model: 'gpt-5.5',
        providers: {
          'openai-codex': {
            type: 'openai-codex',
            family: 'openai-codex',
            apiKeys: [{ label: 'oauth-default', apiKey: 'tok', createdAt: '2026-01-01' }],
            activeKey: 'oauth-default',
          } as never,
        },
      }),
      modelsRegistry: fakeModelsRegistry(),
      logger: fakeLogger(),
    });

    expect(out.resolvedProvider?.models.map((m) => m.id)).toEqual([
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.3-codex-spark',
    ]);
  });

  it('filters openai-codex catalog seeding to current Codex models', async () => {
    const getProvider = vi.fn(async (id: string) => {
      if (id === 'openai') {
        return {
          id: 'openai',
          name: 'OpenAI',
          family: 'openai',
          envVars: [],
          models: [
            { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', family: 'gpt-codex' },
            { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', family: 'gpt-codex' },
            { id: 'gpt-5.5', name: 'GPT-5.5', family: 'gpt-codex' },
          ],
        } as ResolvedProvider;
      }
      return undefined;
    });

    const out = await setupProvider({
      config: fakeConfig({
        provider: 'openai-codex',
        model: 'gpt-5.5',
        providers: {
          'openai-codex': {
            type: 'openai-codex',
            family: 'openai-codex',
          } as never,
        },
      }),
      modelsRegistry: fakeModelsRegistry({ getProvider }),
      logger: fakeLogger(),
    });

    expect(out.resolvedProvider?.models.map((m) => m.id)).toEqual(['gpt-5.5', 'gpt-5.4-mini']);
  });

  it('throws UNSUPPORTED_PROVIDER when family is unsupported and no override', async () => {
    const resolved = { family: 'unsupported', npm: 'weird-sdk' } as ResolvedProvider;
    const modelsRegistry = fakeModelsRegistry({
      getProvider: vi.fn().mockResolvedValue(resolved),
    });

    const ce = await expectConfigError(
      () => setupProvider({ config: fakeConfig({ provider: 'weird' }), modelsRegistry, logger: fakeLogger() }),
      {
        code: 'CONFIG_INVALID',
        context: { provider: 'weird', family: 'weird-sdk', kind: 'unsupported' },
      },
    );
    expect(ce.message).toContain('weird-sdk');
  });

  it('registry-build failure throws a structured ConfigError (phase: registry-build)', async () => {
    buildProviderFactoriesFromRegistry.mockRejectedValue(new Error('ENOENT'));

    const ce = await expectConfigError(
      () => setupProvider({ config: fakeConfig(), modelsRegistry: fakeModelsRegistry(), logger: fakeLogger() }),
      { code: 'CONFIG_INVALID', context: { phase: 'registry-build', provider: 'anthropic' } },
    );
    expect(ce.cause).toBeInstanceOf(Error);
    expect((ce.cause as Error).message).toBe('ENOENT');
    expect(ce.message).toMatch(
      /Failed to load models\.dev registry.*ENOENT.*wstack models refresh/s,
    );
  });

  it('provider-create failure throws a structured ConfigError (phase: provider-create)', async () => {
    buildProviderFactoriesFromRegistry.mockResolvedValue([]);
    makeProviderFromConfig.mockImplementation(() => {
      throw new Error('bad config');
    });

    const ce = await expectConfigError(
      () => setupProvider({ config: fakeConfig({ provider: 'novel' }), modelsRegistry: fakeModelsRegistry(), logger: fakeLogger() }),
      { code: 'CONFIG_INVALID', context: { phase: 'provider-create', provider: 'novel' } },
    );
    expect(ce.cause).toBeInstanceOf(Error);
    expect((ce.cause as Error).message).toBe('bad config');
    expect(ce.message).toMatch(/Failed to create provider.*bad config/);
  });

  it('non-Error throw from provider-create is wrapped with cause-preserved (string cause)', async () => {
    buildProviderFactoriesFromRegistry.mockResolvedValue([]);
    makeProviderFromConfig.mockImplementation(() => {
      throw 'plain string';
    });

    const ce = await expectConfigError(
      () => setupProvider({ config: fakeConfig(), modelsRegistry: fakeModelsRegistry(), logger: fakeLogger() }),
      { context: { phase: 'provider-create' } },
    );
    expect(ce.cause).toBe('plain string');
    expect(ce.message).toMatch(/Failed to create provider.*plain string/);
  });

  it('non-Error throw from registry-build is wrapped with cause-preserved (string cause)', async () => {
    buildProviderFactoriesFromRegistry.mockRejectedValue('registry boom');

    const ce = await expectConfigError(
      () => setupProvider({ config: fakeConfig(), modelsRegistry: fakeModelsRegistry(), logger: fakeLogger() }),
      { context: { phase: 'registry-build' } },
    );
    expect(ce.cause).toBe('registry boom');
    expect(ce.message).toMatch(/Failed to load models\.dev registry.*registry boom/);
  });

  it('skips registry build when modelsRegistry feature is disabled', async () => {
    const out = await setupProvider({
      config: fakeConfig({
        features: { mcp: true, plugins: true, memory: true, modelsRegistry: false, skills: true },
      }),
      modelsRegistry: fakeModelsRegistry(),
      logger: fakeLogger(),
    });

    expect(buildProviderFactoriesFromRegistry).not.toHaveBeenCalled();
    // Registry empty → falls through to makeProviderFromConfig.
    expect(makeProviderFromConfig).toHaveBeenCalled();
    expect(out.provider).toBe(fakeProviderInstance);
  });

  it('uses providerConfig from config.providers when available', async () => {
    buildProviderFactoriesFromRegistry.mockResolvedValue([]);
    await setupProvider({
      config: fakeConfig({
        provider: 'openai',
        providers: { openai: { type: 'openai', apiKey: 'sk-saved', baseUrl: 'https://x' } },
      }),
      modelsRegistry: fakeModelsRegistry(),
      logger: fakeLogger(),
    });
    expect(makeProviderFromConfig).toHaveBeenCalledWith(
      'openai',
      expect.objectContaining({ apiKey: 'sk-saved', baseUrl: 'https://x', type: 'openai' }),
    );
  });

  // ---- maxOutput resolution (drives Chimera's Request.maxTokens) ----
  //
  // These tests exercise the real capabilitiesFor() path, not a mock.
  // The mock provider instance starts with no `capabilities`; setupProvider
  // should populate maxOutput from the models.dev catalog lookup.

  function providerWith(caps: Record<string, unknown>): { capabilities: Record<string, unknown> } {
    return { capabilities: caps } as never;
  }

  it('overwrites the provider family baseline with catalog-resolved maxOutput', async () => {
    // makeProviderFromConfig returns a stub whose `capabilities` carries
    // only the family default (no maxOutput). setupProvider must reach
    // the registry, call capabilitiesFor, and put the catalog value on
    // the provider so agent-response can read it.
    //
    // Note: buildProviderFactoriesFromRegistry is mocked to return [] so
    // the registry-driven path falls through to makeProviderFromConfig —
    // that's the path the test exercises.
    buildProviderFactoriesFromRegistry.mockResolvedValue([]);
    makeProviderFromConfig.mockReturnValue(providerWith({ maxContext: 200_000 }) as never);
    const getModel = vi.fn(async (providerId: string, modelId: string) => ({
      providerId,
      modelId,
      capabilities: {
        tools: true,
        vision: true,
        reasoning: false,
        maxContext: 200_000,
        maxOutput: 64_000,
      },
    }));
    const modelsRegistry = fakeModelsRegistry({ getModel });

    const { provider } = await setupProvider({
      config: fakeConfig({ provider: 'anthropic', model: 'anthropic-test-model' }),
      modelsRegistry,
      logger: fakeLogger(),
    });

    expect((provider as { capabilities: { maxOutput?: number } }).capabilities.maxOutput).toBe(
      64_000,
    );
  });

  it('falls back to undefined maxOutput when the catalog has no entry for the model', async () => {
    // Some user-defined providers don't show up in models.dev at all —
    // the registry returns undefined for getModel. setupProvider must
    // not invent a value, just leave the family default unset so
    // agent-response applies its 8192 safety net.
    buildProviderFactoriesFromRegistry.mockResolvedValue([]);
    makeProviderFromConfig.mockReturnValue(providerWith({ maxContext: 8_192 }) as never);
    const modelsRegistry = fakeModelsRegistry({
      getModel: vi.fn().mockResolvedValue(undefined),
    });

    const { provider } = await setupProvider({
      config: fakeConfig({ provider: 'openai-compatible', model: 'my-fine-tune' }),
      modelsRegistry,
      logger: fakeLogger(),
    });

    expect(
      (provider as { capabilities: { maxOutput?: number } }).capabilities.maxOutput,
    ).toBeUndefined();
  });

  it('skips catalog resolution when modelsRegistry feature is disabled', async () => {
    // Feature off → we don't even call the registry, so the provider's
    // baseline capabilities stay intact. The 8192 fallback in
    // agent-response covers this case.
    const baselineCaps = { maxContext: 8_192, maxOutput: 8_192 };
    makeProviderFromConfig.mockReturnValue(providerWith(baselineCaps) as never);
    const getModel = vi.fn();
    const modelsRegistry = fakeModelsRegistry({ getModel });

    const { provider } = await setupProvider({
      config: fakeConfig({
        features: { mcp: true, plugins: true, memory: true, modelsRegistry: false, skills: true },
      }),
      modelsRegistry,
      logger: fakeLogger(),
    });

    expect(getModel).not.toHaveBeenCalled();
    expect((provider as { capabilities: { maxOutput?: number } }).capabilities.maxOutput).toBe(
      8_192,
    );
  });
});
