import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  watchProviderConfig: vi.fn(),
  makeProviderFromConfig: vi.fn(),
  patchConfig: vi.fn((_config: unknown, patch: unknown) => patch),
  projectSavedProviders: vi.fn((providers: unknown) => providers),
  broadcast: vi.fn(),
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
