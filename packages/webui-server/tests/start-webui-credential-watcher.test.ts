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
vi.mock('@wrongstack/providers', () => ({
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

  it('refreshes config, broadcasts changes, and reloads the active provider', () => {
    let onSnapshot: ((snapshot: Record<string, any>) => void) | undefined;
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
    const update = vi.fn();
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
        configStore: { update },
        providerRegistry,
      } as never,
      clients: new Map(),
      updateAutoCompactionMaxContext,
    });

    expect(result).toBe(close);
    onSnapshot?.({
      providers: { openai: { type: 'openai', apiKey: 'new' } },
      uiLocale: 'fr',
      apiKey: 'fallback-key',
      fallbackModels: ['backup'],
    });

    expect(setConfig).toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'fallback-key', fallbackModels: ['backup'] }),
    );
    expect(mocks.broadcast).toHaveBeenCalledWith(expect.any(Map), {
      type: 'prefs.updated',
      payload: { uiLocale: 'fr' },
    });
    expect(context.meta['uiLocale']).toBe('fr');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ type: 'openai', apiKey: 'new' }));
    expect(context.provider).toEqual({ id: 'replacement' });
    expect(updateAutoCompactionMaxContext).toHaveBeenCalledWith({ id: 'replacement' });
  });
});
