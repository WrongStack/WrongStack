import type { Config, Provider, ProviderConfig } from '@wrongstack/core/types';
import {
  applyProxyConfig,
  __resetProxyConfigForTests,
} from '@wrongstack/core/wiring/proxy-rewrite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupProviderRuntime, type ProviderRuntimeDeps } from '../src/wiring/provider-runtime-setup.js';

// Keep the unit hermetic: the catalog overlay, storage watchers/snapshot
// reader, fallback extension, and consolidator are all replaced with fakes.
// The real resolver/builder runtimes are injected as deps (that is the seam
// this module owns). Credential-shaped strings are deliberately low-entropy
// fixture tokens, never real secret material.
vi.mock('@wrongstack/providers', () => ({
  withCatalogCapabilities: vi.fn(async (_models: unknown, providerId: string, provider: Provider) => ({
    ...provider,
    id: `${providerId}-catalog`,
  })),
  makeProviderFromConfig: vi.fn(),
}));

vi.mock('@wrongstack/core/storage', () => ({
  readProviderSnapshot: vi.fn(),
  watchProviderConfig: vi.fn(),
  SessionMemoryConsolidator: class SessionMemoryConsolidator {
    constructor(public readonly opts: unknown) {}
  },
}));

vi.mock('@wrongstack/core/agent', () => ({
  createFallbackModelExtension: vi.fn((opts: unknown) => ({ name: 'fallback-model', opts })),
}));

vi.mock('@wrongstack/sage', () => ({
  getSageService: vi.fn(() => undefined),
}));

const storageMod = await import('@wrongstack/core/storage');
const readProviderSnapshot = vi.mocked(storageMod.readProviderSnapshot);
const watchProviderConfig = vi.mocked(storageMod.watchProviderConfig);
const agentsMod = await import('@wrongstack/core/agent');
const createFallbackModelExtension = vi.mocked(agentsMod.createFallbackModelExtension);

// Distinct fixture tokens so assertions can tell snapshot layers apart.
const TOKEN_TOP = 'fixture-token-top';
const TOKEN_PROFILE = 'fixture-token-profile';
const TOKEN_LOCAL = 'fixture-token-local';
const TOKEN_REPO = 'fixture-token-repo';
const TOKEN_ROTATED = 'fixture-token-rotated';
const TOKEN_WORK = 'fixture-token-work';

interface WatcherHandle {
  path: string;
  trigger: () => void;
  close: ReturnType<typeof vi.fn>;
}

let createdWatchers: WatcherHandle[];
let configWatchCbs: Array<(next: Config) => void>;
let snapshotByPath: Record<string, unknown>;

function fakeConfig(overrides: Partial<Config> = {}): Config {
  return {
    version: 1,
    provider: 'anthropic',
    model: 'claude-3',
    apiKey: TOKEN_TOP,
    features: { mcp: true, plugins: true, memory: false, modelsRegistry: false, skills: true },
    ...overrides,
  } as Config;
}

function fakeProvider(id: string): Provider {
  return { id, capabilities: {} as never, complete: vi.fn(), stream: vi.fn() } as Provider;
}

function makeDeps(overrides: Partial<ProviderRuntimeDeps> = {}) {
  const context = {
    provider: fakeProvider('old-provider'),
    model: 'old-model',
    runModelTransition: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
  };
  return {
    config: fakeConfig(),
    onConfigUpdate: vi.fn(),
    configStore: {
      watch: vi.fn((cb: (next: Config) => void) => {
        configWatchCbs.push(cb);
        return () => {};
      }),
      update: vi.fn(),
    },
    fallbackProfileManager: { reload: vi.fn() },
    providerRegistry: {} as never,
    modelsRegistry: { catalog: true } as never,
    agent: { extensions: { register: vi.fn() } },
    memoryStore: { getCapability: () => undefined },
    refreshMaxContext: vi.fn(async () => {}),
    refreshActiveReasoningConfig: vi.fn(async () => {}),
    wpaths: {
      profileConfig: (profile: string) => `/home/profiles/${profile}.json`,
      projectLocalConfig: '/proj/.wrongstack/config.local.json',
      inProjectConfig: '/proj/.wrongstack/config.json',
    },
    vault: {} as never,
    logger: { warn: vi.fn(), info: vi.fn() },
    teardownHandlers: [] as Array<() => void>,
    context,
    events: {} as never,
    resolveProviderCfgRuntime: vi.fn((c: Config, providerId: string) => ({
      cfg: { type: providerId, apiKey: c.apiKey } as ProviderConfig,
    })),
    buildProviderForIdRuntime: vi.fn((_opts: unknown, providerId: string) => fakeProvider(providerId)),
    statusTracker: {} as never,
    ...overrides,
  } as ProviderRuntimeDeps;
}

/** Flush pending `void onAnyConfigChange()` promises fired by watcher stubs. */
async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  createdWatchers = [];
  configWatchCbs = [];
  snapshotByPath = {};
  delete process.env['WRONGSTACK_DISABLE_CONFIG_WATCH'];
  watchProviderConfig.mockImplementation(
    ((path: string, _vault: unknown, cb: () => void) => {
      const handle: WatcherHandle = { path, trigger: cb, close: vi.fn() };
      createdWatchers.push(handle);
      return handle as never;
    }) as never,
  );
  readProviderSnapshot.mockImplementation(
    ((path: string) =>
      path in snapshotByPath ? Promise.resolve(snapshotByPath[path]) : Promise.resolve(undefined)) as never,
  );
});

afterEach(() => {
  delete process.env['WRONGSTACK_DISABLE_CONFIG_WATCH'];
});

describe('setupProviderRuntime — returned runtime helpers', () => {
  it('delegates provider resolution and building to the injected runtimes', () => {
    const deps = makeDeps();
    const runtime = setupProviderRuntime(deps);
    expect(runtime.resolveProviderCfg('anthropic').cfg.type).toBe('anthropic');
    expect(runtime.buildProviderForId('openai').id).toBe('openai');
    expect(deps.resolveProviderCfgRuntime).toHaveBeenCalledWith(deps.config, 'anthropic');
  });

  it('skips the catalog overlay when the models registry feature is off', async () => {
    const deps = makeDeps();
    const runtime = setupProviderRuntime(deps);
    const provider = await runtime.buildProviderForModel('anthropic', 'claude-3');
    expect(provider.id).toBe('anthropic');
  });

  it('applies the catalog overlay when the models registry feature is on', async () => {
    const deps = makeDeps({
      config: fakeConfig({ features: { mcp: true, plugins: true, memory: false, modelsRegistry: true, skills: true } }),
    });
    const runtime = setupProviderRuntime(deps);
    const provider = await runtime.buildProviderForModel('anthropic', 'claude-3');
    expect(provider.id).toBe('anthropic-catalog');
  });

  it('refreshes max context and reasoning config through the injected callbacks', async () => {
    const deps = makeDeps();
    const runtime = setupProviderRuntime(deps);
    await runtime.refreshMaxContextFor('anthropic', 'claude-3');
    expect(deps.refreshMaxContext).toHaveBeenCalledWith('anthropic', 'claude-3', {
      type: 'anthropic',
      apiKey: TOKEN_TOP,
    });
    await runtime.refreshRuntimeModelStateFor('openai', 'gpt-x');
    expect(deps.refreshActiveReasoningConfig).toHaveBeenCalledWith('openai', 'gpt-x');
  });
});

describe('setupProviderRuntime — switchProviderAndModel', () => {
  it('switches atomically inside the model transition and syncs every consumer', async () => {
    const deps = makeDeps();
    const runtime = setupProviderRuntime(deps);
    const result = await runtime.switchProviderAndModel('openai', 'gpt-x');
    expect(result).toBeNull();
    expect(deps.context.runModelTransition).toHaveBeenCalledTimes(1);
    expect(deps.configStore.update).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-x' });
    expect(deps.onConfigUpdate).toHaveBeenCalled();
    expect(deps.fallbackProfileManager.reload).toHaveBeenCalled();
    expect(deps.context.provider?.id).toBe('openai');
    expect(deps.context.model).toBe('gpt-x');
    expect(deps.refreshMaxContext).toHaveBeenCalledWith('openai', 'gpt-x', {
      type: 'openai',
      apiKey: TOKEN_TOP,
    });
    expect(deps.refreshActiveReasoningConfig).toHaveBeenCalledWith('openai', 'gpt-x');
  });

  it('returns the error message when building the provider fails', async () => {
    const deps = makeDeps({
      buildProviderForIdRuntime: vi.fn(() => {
        throw new Error('no credentials for openai');
      }) as never,
    });
    const runtime = setupProviderRuntime(deps);
    const result = await runtime.switchProviderAndModel('openai', 'gpt-x');
    expect(result).toBe('no credentials for openai');
    expect(deps.configStore.update).not.toHaveBeenCalled();
    expect(deps.context.model).toBe('old-model');
  });

  it('logs but tolerates capability-refresh failures after a successful switch', async () => {
    const deps = makeDeps({
      refreshMaxContext: vi.fn(async () => {
        throw new Error('context probe timeout');
      }),
    });
    const runtime = setupProviderRuntime(deps);
    const result = await runtime.switchProviderAndModel('openai', 'gpt-x');
    expect(result).toBeNull();
    expect(deps.context.model).toBe('gpt-x');
    expect(deps.logger.warn).toHaveBeenCalledWith(
      'Provider/model switched, but runtime capability refresh failed: context probe timeout',
    );
  });
});

describe('setupProviderRuntime — extensions and consolidation', () => {
  it('registers the fallback model extension with the gate and live config accessor', () => {
    const deps = makeDeps();
    setupProviderRuntime(deps);
    expect(deps.agent.extensions.register).toHaveBeenCalledTimes(1);
    const ext = createFallbackModelExtension.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(ext['fallbackGateSeconds']).toBe(7);
    expect(ext['fallbackGate']).toBeDefined();
    expect(typeof ext['getConfig']).toBe('function');
  });

  it('registers the session memory consolidator when memory is enabled', () => {
    const deps = makeDeps({
      config: fakeConfig({ features: { mcp: true, plugins: true, memory: true, modelsRegistry: false, skills: true } }),
    });
    setupProviderRuntime(deps);
    expect(deps.agent.extensions.register).toHaveBeenCalledTimes(2);
  });

  it('skips consolidation when memoryConsolidation is explicitly disabled', () => {
    const deps = makeDeps({
      config: fakeConfig({
        features: { mcp: true, plugins: true, memory: true, modelsRegistry: false, skills: true, memoryConsolidation: false },
      }),
    });
    setupProviderRuntime(deps);
    expect(deps.agent.extensions.register).toHaveBeenCalledTimes(1);
  });
});

describe('setupProviderRuntime — config watchers', () => {
  it('watches profile, project-local, and in-project layers', () => {
    const deps = makeDeps();
    setupProviderRuntime(deps);
    expect(createdWatchers.map((w) => w.path)).toEqual([
      '/home/profiles/default.json',
      '/proj/.wrongstack/config.local.json',
      '/proj/.wrongstack/config.json',
    ]);
  });

  it('opens no watchers when WRONGSTACK_DISABLE_CONFIG_WATCH=1', () => {
    process.env['WRONGSTACK_DISABLE_CONFIG_WATCH'] = '1';
    const deps = makeDeps();
    setupProviderRuntime(deps);
    expect(createdWatchers).toHaveLength(0);
  });

  it('merges trusted layers with higher priority winning', async () => {
    snapshotByPath['/home/profiles/default.json'] = {
      providers: { anthropic: { apiKey: TOKEN_PROFILE } },
      apiKey: TOKEN_PROFILE,
      favoriteModels: ['a'],
    };
    snapshotByPath['/proj/.wrongstack/config.local.json'] = {
      providers: { openai: { apiKey: TOKEN_LOCAL } },
      favoriteModels: ['b'],
    };
    const deps = makeDeps();
    setupProviderRuntime(deps);
    createdWatchers[0]?.trigger();
    await flushAsync();
    expect(deps.configStore.update).toHaveBeenCalledTimes(1);
    const patch = deps.configStore.update.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(patch['providers']).toEqual({
      anthropic: { apiKey: TOKEN_PROFILE },
      openai: { apiKey: TOKEN_LOCAL },
    });
    expect(patch['favoriteModels']).toEqual(['b']);
    expect(deps.onConfigUpdate).toHaveBeenCalled();
  });

  it('ignores duplicate serialized snapshots without re-applying them', async () => {
    snapshotByPath['/home/profiles/default.json'] = { providers: { a: { apiKey: TOKEN_PROFILE } } };
    const deps = makeDeps();
    setupProviderRuntime(deps);
    createdWatchers[0]?.trigger();
    await flushAsync();
    createdWatchers[1]?.trigger();
    await flushAsync();
    expect(deps.configStore.update).toHaveBeenCalledTimes(1);
  });

  it('sanitizes credential fields from the repo-committed in-project layer', async () => {
    snapshotByPath['/proj/.wrongstack/config.json'] = {
      providers: { evil: { apiKey: 'x' } },
      apiKey: TOKEN_REPO,
      baseUrl: 'https://evil.example.com',
      fallbackMaxLastResortCandidates: 0,
      favoriteModels: ['repo-fav'],
    };
    const deps = makeDeps();
    setupProviderRuntime(deps);
    createdWatchers[2]?.trigger();
    await flushAsync();
    const patch = deps.configStore.update.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(patch['providers']).toEqual({});
    expect(patch['apiKey']).toBeUndefined();
    expect(patch['baseUrl']).toBeUndefined();
    expect(patch['fallbackMaxLastResortCandidates']).toBeUndefined();
    expect(patch['favoriteModels']).toEqual(['repo-fav']);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('ignored credential field(s) from the repo-committed config'),
    );
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('providers, apiKey, baseUrl, fallbackMaxLastResortCandidates'),
    );
  });

  it('keeps routing-only edits from rebuilding the provider', async () => {
    snapshotByPath['/home/profiles/default.json'] = {
      providers: {},
      favoriteModels: ['later-favorite'],
    };
    const deps = makeDeps();
    setupProviderRuntime(deps);
    createdWatchers[0]?.trigger();
    await flushAsync();
    expect(deps.configStore.update).toHaveBeenCalled();
    expect(deps.context.provider?.id).toBe('old-provider');
    expect(deps.logger.info).not.toHaveBeenCalledWith(expect.stringContaining('credentials reloaded'));
  });

  it('rebuilds the active provider with the catalog overlay on credential changes', async () => {
    snapshotByPath['/home/profiles/default.json'] = {
      providers: { anthropic: { apiKey: TOKEN_ROTATED } },
      apiKey: TOKEN_ROTATED,
    };
    const deps = makeDeps({
      config: fakeConfig({ features: { mcp: true, plugins: true, memory: false, modelsRegistry: true, skills: true } }),
    });
    setupProviderRuntime(deps);
    createdWatchers[0]?.trigger();
    await flushAsync();
    expect(deps.context.provider?.id).toBe('anthropic-catalog');
    expect(deps.logger.info).toHaveBeenCalledWith('Provider credentials reloaded from config (anthropic)');
  });

  it('warns when the credential rebuild fails instead of throwing', async () => {
    snapshotByPath['/home/profiles/default.json'] = {
      providers: { anthropic: { apiKey: TOKEN_ROTATED } },
      apiKey: TOKEN_ROTATED,
    };
    const deps = makeDeps({
      buildProviderForIdRuntime: vi.fn(() => {
        throw new Error('factory exploded');
      }) as never,
    });
    setupProviderRuntime(deps);
    createdWatchers[0]?.trigger();
    await flushAsync();
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Credential hot-reload failed for anthropic'),
    );
  });

  it('re-points watchers when the active profile changes via ConfigStore', async () => {
    snapshotByPath['/home/profiles/work.json'] = {
      providers: { anthropic: { apiKey: TOKEN_WORK } },
      apiKey: TOKEN_WORK,
    };
    const deps = makeDeps();
    setupProviderRuntime(deps);
    expect(createdWatchers.map((w) => w.path)).toContain('/home/profiles/default.json');

    // configWatchCbs[0] is the fallback-reload subscription; the profile
    // rebind watcher is registered later in setup.
    const rebind = configWatchCbs[1];
    expect(rebind).toBeDefined();
    rebind?.(fakeConfig({ activeProfile: 'work' }));
    expect(createdWatchers.map((w) => w.path)).toContain('/home/profiles/work.json');
    await flushAsync();
    expect(deps.configStore.update).toHaveBeenCalled();
  });

  it('pushes watcher teardown and fallback-reload subscriptions onto teardownHandlers', () => {
    const deps = makeDeps();
    setupProviderRuntime(deps);
    // 1 fallback reload on configStore.watch + 1 profile rebind + closeWatchers.
    expect(deps.teardownHandlers.length).toBeGreaterThanOrEqual(3);
  });

  it('reloads the fallback profile manager on every ConfigStore update', () => {
    const deps = makeDeps();
    setupProviderRuntime(deps);
    const reload = configWatchCbs[0];
    expect(reload).toBeDefined();
    const reloadSpy = deps.fallbackProfileManager.reload as unknown as {
      mock: { calls: unknown[] };
    };
    const before = reloadSpy.mock.calls.length;
    reload?.(fakeConfig({ favoriteModels: ['z'] }));
    expect(reloadSpy.mock.calls.length).toBe(before + 1);
  });
});

describe('setupProviderRuntime — WrongProxy instant-apply', () => {
  // The instant-apply subscription lives on the CORE proxy singleton, so
  // every state change here goes through the real applyProxyConfig.
  beforeEach(() => __resetProxyConfigForTests());
  afterEach(() => __resetProxyConfigForTests());

  function proxyDeps() {
    const context = {
      provider: fakeProvider('anthropic'),
      model: 'claude-3',
      runModelTransition: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
    };
    const deps = makeDeps({
      config: fakeConfig({ baseUrl: 'https://api.example.com/v1' }),
      context,
    } as Partial<ProviderRuntimeDeps>);
    return { deps, context };
  }

  it('rebuilds the live provider through the transition gate when the proxy activates', async () => {
    const { deps, context } = proxyDeps();
    const build = vi.fn((_opts: unknown, providerId: string) => fakeProvider(providerId));
    deps.buildProviderForIdRuntime = build as never;
    setupProviderRuntime(deps);
    const originalProvider = context.provider;

    applyProxyConfig({ enabled: true, url: 'http://localhost:3444', active: true });
    await flushAsync();
    await flushAsync();

    expect(build).toHaveBeenCalledWith(expect.anything(), 'anthropic');
    expect(context.runModelTransition).toHaveBeenCalled();
    // The live provider object was swapped (new instance with same id).
    expect(context.provider).not.toBe(originalProvider);
    expect(context.provider?.id).toBe('anthropic');
    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('live provider rebuilt'),
    );
  });

  it('does NOT rebuild when the proxy config write is value-identical (probe tick)', async () => {
    const { deps } = proxyDeps();
    const build = vi.fn((_opts: unknown, providerId: string) => fakeProvider(providerId));
    deps.buildProviderForIdRuntime = build as never;
    setupProviderRuntime(deps);

    applyProxyConfig({ enabled: true, url: 'http://localhost:3444', active: true });
    await flushAsync();
    expect(build).toHaveBeenCalledTimes(1); // raw → rewritten flip

    applyProxyConfig({ active: true }); // identical tick
    await flushAsync();
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('skips the swap when the live provider moved before the rebuild ran (superseded)', async () => {
    const { deps, context } = proxyDeps();
    setupProviderRuntime(deps);
    // A /model switch lands between the proxy change and the rebuild.
    applyProxyConfig({ enabled: true, url: 'http://localhost:3444', active: true });
    context.provider = fakeProvider('openai'); // moved elsewhere
    await flushAsync();
    await flushAsync();
    // runModelTransition ran but the guard prevented the stale overwrite —
    // the provider is still the one the switch installed.
    expect(context.provider.id).toBe('openai');
  });

  it('stops rebuilding once the teardown handler runs', async () => {
    const { deps } = proxyDeps();
    const build = vi.fn((_opts: unknown, providerId: string) => fakeProvider(providerId));
    deps.buildProviderForIdRuntime = build as never;
    setupProviderRuntime(deps);
    const disposes = [...deps.teardownHandlers];
    for (const dispose of disposes) dispose();

    applyProxyConfig({ enabled: true, url: 'http://localhost:3444', active: true });
    await flushAsync();
    expect(build).not.toHaveBeenCalled();
  });
});
