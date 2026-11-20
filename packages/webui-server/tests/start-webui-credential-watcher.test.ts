import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  watchProviderConfig: vi.fn(),
  makeProviderFromConfig: vi.fn(),
  patchConfig: vi.fn((_config: unknown, patch: unknown) => patch),
  projectSavedProviders: vi.fn((providers: unknown) => providers),
  broadcast: vi.fn(),
  // Hermetic: the real list depends on which ACP agents are on this machine's PATH.
  standaloneHostProviders: vi.fn((): unknown[] => []),
}));

vi.mock('@wrongstack/core/storage', () => ({
  watchProviderConfig: mocks.watchProviderConfig,
}));
vi.mock('@wrongstack/providers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  makeProviderFromConfig: mocks.makeProviderFromConfig,
}));
vi.mock('../src/server/boot.js', () => ({ patchConfig: mocks.patchConfig }));
vi.mock('../src/server/provider-handlers.js', () => ({
  projectSavedProviders: mocks.projectSavedProviders,
}));
vi.mock('../src/server/ws-utils.js', () => ({ broadcast: mocks.broadcast }));
vi.mock('../src/server/standalone-acp-leader.js', () => ({
  standaloneHostProviders: mocks.standaloneHostProviders,
}));

import { setupWebuiCredentialWatcher } from '../src/server/start-webui-credential-watcher.js';

describe('setupWebuiCredentialWatcher', () => {
  const originalDisable = process.env['WRONGSTACK_DISABLE_CONFIG_WATCH'];

  beforeEach(() => {
    delete process.env['WRONGSTACK_DISABLE_CONFIG_WATCH'];
  });

  afterEach(() => {
    if (originalDisable === undefined) delete process.env['WRONGSTACK_DISABLE_CONFIG_WATCH'];
    else process.env['WRONGSTACK_DISABLE_CONFIG_WATCH'] = originalDisable;
    vi.restoreAllMocks();
  });

  it('does not install a watcher when config watching is disabled', () => {
    process.env['WRONGSTACK_DISABLE_CONFIG_WATCH'] = '1';

    expect(setupWebuiCredentialWatcher({} as never)).toBeUndefined();
    expect(mocks.watchProviderConfig).not.toHaveBeenCalled();
  });

  it('retains active-model vision and output limits when a custom model edit rebuilds credentials', async () => {
    let notify: ((snapshot: Record<string, unknown>) => Promise<void>) | undefined;
    mocks.watchProviderConfig.mockImplementation((_path, _vault, callback) => {
      notify = callback;
      return { close: vi.fn() };
    });
    const providers =
      await vi.importActual<typeof import('@wrongstack/providers')>('@wrongstack/providers');
    mocks.makeProviderFromConfig.mockImplementation(providers.makeProviderFromConfig);
    const entry = {
      type: 'openai-compatible',
      family: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:12345/v1',
      apiKey: 'test-local-key',
      models: ['vision-model'],
      customModels: {
        'vision-model': { name: 'Vision', capabilities: { vision: true, maxOutput: 8192 } },
      },
    };
    let config = { provider: 'local', model: 'vision-model', providers: { local: entry } };
    const registry = {
      refresh: vi.fn(async () => {}),
      getProvider: vi.fn(async () => ({ id: 'local', family: 'openai-compatible', models: [] })),
      getModel: vi.fn(async () => undefined),
    };
    const baseline = providers.makeProviderFromConfig('local', entry as never);
    expect(baseline.capabilities.vision).toBe(false);
    const context = {
      model: 'vision-model',
      provider: await providers.withCatalogCapabilities(registry as never, 'local', baseline, {
        ...entry,
        model: 'vision-model',
      } as never),
      meta: {},
    };
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    setupWebuiCredentialWatcher({
      watchConfigPath: 'config.json',
      vault: {} as never,
      logger: { warn: vi.fn() } as never,
      state: {
        getConfig: () => config,
        setConfig: (next: typeof config) => {
          config = next;
        },
      } as never,
      deps: {
        context,
        modelsRegistry: registry,
        configStore: { replace: vi.fn() },
        providerRegistry: { has: () => false },
      } as never,
      clients: new Map(),
      loadConfig: async () =>
        ({
          ...config,
          providers: { local: { ...entry, models: ['vision-model', 'refiner'] } },
        }) as never,
      updateAutoCompactionMaxContext: vi.fn(async () => {}),
    });
    expect(context.provider.capabilities.vision).toBe(true);
    await notify?.({ providers: { local: entry } });
    expect(context.model).toBe('vision-model');
    expect(context.provider.capabilities.vision).toBe(true);
    expect(context.provider.capabilities.maxOutput).toBe(8192);
  });

  describe('an engine booted before any provider was set up (#448)', () => {
    function boot(
      activeProviderId: string,
      saved: Record<string, unknown>,
      followSavedDefault?: () => boolean,
    ) {
      let notify: ((snapshot: Record<string, unknown>) => Promise<void>) | undefined;
      mocks.watchProviderConfig.mockImplementation((_path, _vault, callback) => {
        notify = callback;
        return { close: vi.fn() };
      });
      let config: Record<string, unknown> = { version: 1 };
      const context = { provider: { id: activeProviderId }, model: '', meta: {} };
      const adoptSavedDefault = vi.fn(async (provider: string, model: string) => {
        context.provider = { id: provider };
        context.model = model;
        config = { ...config, provider, model };
      });
      const create = vi.fn(() => ({ id: 'rebuilt' }));
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      setupWebuiCredentialWatcher({
        watchConfigPath: 'config.json',
        vault: {} as never,
        logger: { warn: vi.fn() } as never,
        state: {
          getConfig: () => config,
          setConfig: (next: Record<string, unknown>) => {
            config = next;
          },
        } as never,
        deps: {
          context,
          configStore: { replace: vi.fn() },
          providerRegistry: { has: () => true, create },
        } as never,
        clients: new Map(),
        loadConfig: async () => saved as never,
        updateAutoCompactionMaxContext: vi.fn(async () => {}),
        adoptSavedDefault,
        followSavedDefault,
      });
      return {
        notify: () => notify?.({ providers: saved['providers'] }),
        adoptSavedDefault,
        create,
        context,
      };
    }
    const saved = {
      version: 1,
      provider: 'local',
      model: 'm1',
      providers: { local: { type: 'openai', apiKey: 'k' } },
    };

    it('takes the saved provider and model once the config names them', async () => {
      const engine = boot('unconfigured', saved);

      await engine.notify();

      expect(engine.adoptSavedDefault).toHaveBeenCalledWith('local', 'm1');
      expect(engine.context.provider.id).toBe('local');
      // The adoption's own config write reloads again: no second rebuild.
      await engine.notify();
      expect(engine.adoptSavedDefault).toHaveBeenCalledTimes(1);
      expect(engine.create).not.toHaveBeenCalled();
    });

    it('waits while the saved config still names no model', async () => {
      const engine = boot('unconfigured', { ...saved, model: undefined });

      await engine.notify();

      expect(engine.adoptSavedDefault).not.toHaveBeenCalled();
    });

    it('control: an engine already on a provider is not switched by a config reload', async () => {
      const engine = boot('other', saved);

      await engine.notify();

      expect(engine.adoptSavedDefault).not.toHaveBeenCalled();
      expect(engine.context.provider.id).not.toBe('local');
    });

    it('an unclaimed spare follows a changed default; a claimed one does not', async () => {
      let unclaimed = true;
      const engine = boot('other', saved, () => unclaimed);

      await engine.notify();
      expect(engine.adoptSavedDefault).toHaveBeenCalledWith('local', 'm1');

      unclaimed = false;
      await engine.notify(); // the default moves on after the claim
      expect(engine.adoptSavedDefault).toHaveBeenCalledTimes(1);
    });

    it('an unclaimed spare already on the saved default is left as it is', async () => {
      const engine = boot('local', saved, () => true);
      engine.context.model = 'm1';

      await engine.notify();

      expect(engine.adoptSavedDefault).not.toHaveBeenCalled();
    });
  });

  it('refreshes config, broadcasts changes, and reloads the active provider', async () => {
    let onSnapshot: ((snapshot: Record<string, any>) => Promise<void>) | undefined;
    const close = vi.fn();
    mocks.watchProviderConfig.mockImplementation(
      (_path: string, _vault: unknown, callback: typeof onSnapshot) => {
        onSnapshot = callback;
        return { close };
      },
    );
    const initialConfig = {
      providers: { openai: { type: 'openai', apiKey: 'old' } },
      uiLocale: 'en',
    };
    const setConfig = vi.fn();
    const replace = vi.fn();
    const nextConfig = {
      version: 1 as const,
      providers: { openai: { type: 'openai', apiKey: 'new' } },
      uiLocale: 'fr',
      apiKey: 'top',
      fallbackModels: ['backup'],
    };
    const create = vi.fn(() => ({ id: 'replacement' }));
    const providerRegistry = { has: vi.fn(() => true), create };
    const context = { provider: { id: 'openai' }, meta: {} as Record<string, unknown> };
    const updateAutoCompactionMaxContext = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = setupWebuiCredentialWatcher({
      watchConfigPath: 'config.json',
      vault: {} as never,
      logger: { warn: vi.fn() } as never,
      state: { getConfig: () => initialConfig, setConfig } as never,
      deps: {
        context,
        configStore: { replace },
        providerRegistry,
      } as never,
      clients: new Map(),
      loadConfig: vi.fn(async () => nextConfig as never),
      updateAutoCompactionMaxContext,
    });

    expect(result).toBe(close);
    await onSnapshot?.({
      providers: { openai: { type: 'openai', apiKey: 'new' } },
      uiLocale: 'fr',
      apiKey: 'fallback-key',
      fallbackModels: ['backup'],
    });

    expect(setConfig).toHaveBeenCalledWith(nextConfig);
    expect(replace).toHaveBeenCalledWith(nextConfig);
    expect(mocks.broadcast).toHaveBeenCalledWith(expect.any(Map), {
      type: 'prefs.updated',
      payload: { uiLocale: 'fr' },
    });
    expect(context.meta['uiLocale']).toBe('fr');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'openai', apiKey: 'new' }),
      'openai',
    );
    expect(context.provider).toEqual({ id: 'replacement' });
    expect(updateAutoCompactionMaxContext).toHaveBeenCalledWith({ id: 'replacement' });
  });
  it('keeps the ACP leader listed and its live agent sessions in place on a config reload', async () => {
    let notify: ((snapshot: Record<string, unknown>) => Promise<void>) | undefined;
    mocks.watchProviderConfig.mockImplementation((_path, _vault, callback) => {
      notify = callback;
      return { close: vi.fn() };
    });
    mocks.projectSavedProviders.mockImplementationOnce(() => [{ id: 'zai', models: ['glm-5'] }]);
    mocks.standaloneHostProviders.mockReturnValueOnce([
      { id: 'acp', type: 'acp', models: [{ id: 'claude-code' }] },
    ]);
    const leader = { id: 'acp', capabilities: { streaming: true } };
    const context = { provider: leader, meta: {} };
    const create = vi.fn();
    const nextConfig = { provider: 'acp', model: 'claude-code', apiKey: 'changed', providers: {} };
    setupWebuiCredentialWatcher({
      watchConfigPath: 'config.json',
      vault: {} as never,
      logger: { warn: vi.fn() } as never,
      state: { getConfig: () => nextConfig, setConfig: vi.fn() } as never,
      deps: {
        context,
        configStore: { replace: vi.fn() },
        providerRegistry: { has: () => true, create },
      } as never,
      clients: new Map(),
      loadConfig: async () => nextConfig as never,
      updateAutoCompactionMaxContext: vi.fn(async () => {}),
    });
    await notify?.({ providers: {} });

    expect(mocks.standaloneHostProviders).toHaveBeenCalledWith(nextConfig);
    expect(mocks.broadcast).toHaveBeenCalledWith(expect.any(Map), {
      type: 'providers.saved',
      payload: {
        providers: [
          { id: 'zai', models: ['glm-5'] },
          expect.objectContaining({ id: 'acp', type: 'acp', models: ['claude-code'] }),
        ],
      },
    });
    // A rebuilt leader would orphan the agent sessions the live one owns.
    expect(create).not.toHaveBeenCalled();
    expect(context.provider).toBe(leader);
  });

  it('blocks removed accounts even with a legacy root key, then recovers on recreation', async () => {
    let notify: ((snapshot: Record<string, unknown>) => Promise<void>) | undefined;
    mocks.watchProviderConfig.mockImplementation((_path, _vault, callback) => {
      notify = callback;
      return { close: vi.fn() };
    });
    let config = { providers: { openai: { type: 'openai', apiKey: 'old' } }, apiKey: 'legacy' };
    let loadedConfig: {
      providers: Record<string, { type: string; apiKey: string }>;
      apiKey: string;
    } = config;
    const old = { id: 'openai', capabilities: {}, complete: vi.fn(), stream: vi.fn() };
    const context = { provider: old, meta: {} };
    const tab = { provider: old };
    const replacement = { ...old, complete: vi.fn(), stream: vi.fn() };
    const create = vi.fn(() => replacement);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    setupWebuiCredentialWatcher({
      watchConfigPath: 'config.json',
      vault: {} as never,
      logger: { warn: vi.fn() } as never,
      state: {
        getConfig: () => config,
        setConfig: (next: typeof config) => {
          config = next;
        },
      } as never,
      deps: {
        context,
        configStore: { replace: vi.fn() },
        providerRegistry: { has: () => true, create },
        sessionAgentIds: () => ['tab'],
        peekAgent: () => ({ ctx: tab }),
      } as never,
      clients: new Map(),
      loadConfig: vi.fn(async () => loadedConfig as never),
      updateAutoCompactionMaxContext: vi.fn().mockResolvedValue(undefined),
    });
    loadedConfig = { ...config, providers: {} };
    await notify?.({ providers: {}, apiKey: 'legacy', snapshotHasProviders: true });
    expect(create).not.toHaveBeenCalled();
    expect(tab.provider).toBe(context.provider);
    const blocked = context.provider as unknown as import('@wrongstack/contracts/types').Provider;
    await expect(
      blocked.complete({} as never, { signal: new AbortController().signal }),
    ).rejects.toThrow('auth profile');
    expect(old.complete).not.toHaveBeenCalled();
    loadedConfig = {
      ...config,
      providers: { openai: { type: 'openai', apiKey: 'new' } },
    };
    await notify?.({ providers: loadedConfig.providers, snapshotHasProviders: true });
    expect(context.provider).toBe(replacement);
    expect(tab.provider).toBe(replacement);
  });
});
