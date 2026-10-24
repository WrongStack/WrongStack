import type { Config, Provider, ProviderConfig } from '@wrongstack/contracts/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveProviderCfg } from '../src/wiring/provider-runtime.js';
import {
  type ProviderRuntimeDeps,
  setupProviderRuntime,
} from '../src/wiring/provider-runtime-setup.js';

// Keep the unit hermetic: the catalog overlay, storage watchers/snapshot
// reader, fallback extension, and consolidator are all replaced with fakes.
// The real resolver/builder runtimes are injected as deps (that is the seam
// this module owns). Credential-shaped strings are deliberately low-entropy
// fixture tokens, never real secret material.
vi.mock('@wrongstack/providers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withCatalogCapabilities: vi.fn(
    async (_models: unknown, providerId: string, provider: Provider) => ({
      ...provider,
      id: `${providerId}-catalog`,
    }),
  ),
  makeProviderFromConfig: vi.fn(),
}));

vi.mock('@wrongstack/core/storage', () => ({
  readProviderSnapshot: vi.fn(),
  watchProviderConfig: vi.fn(),
  SessionMemoryConsolidator: class SessionMemoryConsolidator {
    constructor(public readonly opts: unknown) {}
  },
  SessionMemoryCurator: class SessionMemoryCurator {
    constructor(public readonly opts: unknown) {}
  },
}));

vi.mock('@wrongstack/core/agent', () => ({
  createFallbackModelExtension: vi.fn((opts: unknown) => ({ name: 'fallback-model', opts })),
}));

vi.mock('@wrongstack/sage', () => ({
  getSageService: vi.fn(() => undefined),
}));

// The bootstrap watcher reads ~/.wrongstack/config.json off disk. Mock only
// that one reader and keep every other core/utils export real, so transitive
// consumers (atomicWrite and friends) stay intact.
vi.mock('@wrongstack/core/utils', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readJsonObjectFile: vi.fn(async () => ({})),
}));

const storageMod = await import('@wrongstack/core/storage');
const readProviderSnapshot = vi.mocked(storageMod.readProviderSnapshot);
const utilsMod = await import('@wrongstack/core/utils');
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
  const baseConfig = overrides.config ?? fakeConfig();
  const context = {
    provider: fakeProvider('anthropic'),
    model: 'old-model',
    runModelTransition: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
  };
  return {
    config: baseConfig,
    loadConfig: vi.fn(async () => {
      let merged: Partial<Config> = {};
      for (const configPath of [
        '/home/profiles/default.json',
        '/proj/.wrongstack/config.local.json',
        '/proj/.wrongstack/config.json',
      ]) {
        const snapshot = snapshotByPath[configPath] as
          | (Partial<Config> & { snapshotHasProviders?: boolean; sourceFingerprint?: string })
          | undefined;
        if (!snapshot) continue;
        const {
          snapshotHasProviders: _present,
          sourceFingerprint: _fingerprint,
          ...rawPatch
        } = snapshot;
        const patch: Partial<Config> =
          configPath === '/proj/.wrongstack/config.json'
            ? (({
                providers: _providers,
                apiKey: _apiKey,
                baseUrl: _baseUrl,
                fallbackMaxLastResortCandidates: _lastResort,
                ...safe
              }) => safe)(rawPatch)
            : rawPatch;
        merged = {
          ...merged,
          ...patch,
          providers: { ...(merged.providers ?? {}), ...(patch.providers ?? {}) },
        };
      }
      return { ...baseConfig, ...merged } as Config;
    }),
    onConfigUpdate: vi.fn(),
    configStore: {
      watch: vi.fn((cb: (next: Config) => void) => {
        configWatchCbs.push(cb);
        return () => {};
      }),
      update: vi.fn((partial: Partial<Config>) => {
        const next = { ...baseConfig, ...partial } as Config;
        for (const cb of configWatchCbs) cb(next);
        return next;
      }),
      replace: vi.fn((next: Config) => {
        for (const cb of configWatchCbs) cb(next);
        return next;
      }),
      // The bootstrap watcher compares the disk selection against the store's
      // current one, so the fixture must satisfy the real ConfigStore contract.
      get: (): Config => fakeConfig(),
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
      globalConfig: '/home/config.json',
      projectLocalConfig: '/proj/.wrongstack/config.local.json',
      inProjectConfig: '/proj/.wrongstack/config.json',
    },
    vault: {} as never,
    logger: { warn: vi.fn(), info: vi.fn() },
    teardownHandlers: [] as Array<() => void>,
    context,
    // switchProviderAndModel emits 'provider.model_switched' after a
    // successful switch; a bare object makes that call throw with
    // "events?.emit is not a function".
    events: { emit: vi.fn() } as never,
    resolveProviderCfgRuntime: vi.fn((c: Config, providerId: string) => ({
      cfg: { type: providerId, apiKey: c.apiKey } as ProviderConfig,
    })),
    buildProviderForIdRuntime: vi.fn((_opts: unknown, providerId: string) =>
      fakeProvider(providerId),
    ),
    statusTracker: {
      // switchProviderAndModel unblocks the (provider, model) pair before
      // rebuilding the provider; a bare object makes that call throw and
      // fail every switch test with "statusTracker?.unblock is not a function".
      unblock: vi.fn(),
    } as never,
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
  watchProviderConfig.mockImplementation(((path: string, _vault: unknown, cb: () => void) => {
    const handle: WatcherHandle = { path, trigger: cb, close: vi.fn() };
    createdWatchers.push(handle);
    return handle as never;
  }) as never);
  readProviderSnapshot.mockImplementation(((path: string) =>
    path in snapshotByPath
      ? Promise.resolve(snapshotByPath[path])
      : Promise.resolve(undefined)) as never);
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
    // The logger is threaded through so every build logs its proxy rewrite
    // decision into wrongstack.log.
    expect(deps.resolveProviderCfgRuntime).toHaveBeenCalledWith(deps.config, 'anthropic', {
      logger: deps.logger,
    });
    expect(deps.buildProviderForIdRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ config: deps.config, logger: deps.logger }),
      'openai',
    );
  });

  it('skips the catalog overlay when the models registry feature is off', async () => {
    const deps = makeDeps();
    const runtime = setupProviderRuntime(deps);
    const provider = await runtime.buildProviderForModel('anthropic', 'claude-3');
    expect(provider.id).toBe('anthropic');
  });

  it('applies the catalog overlay when the models registry feature is on', async () => {
    const deps = makeDeps({
      config: fakeConfig({
        features: { mcp: true, plugins: true, memory: false, modelsRegistry: true, skills: true },
      }),
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
    // The switch must unblock the (provider, model) pair and emit the
    // model_switched event — pinned so a future refactor that drops
    // either silently fails here, not in production. (sessionId is
    // undefined in this fixture's context; anything() rejects undefined.)
    expect(deps.statusTracker?.unblock).toHaveBeenCalledWith('openai', 'gpt-x');
    expect(deps.events?.emit).toHaveBeenCalledWith(
      'provider.model_switched',
      expect.objectContaining({ from: expect.anything() }),
    );
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
    const ext = createFallbackModelExtension.mock.calls[0]?.[0] as unknown as Record<
      string,
      unknown
    >;
    expect(ext['fallbackGateSeconds']).toBe(7);
    expect(ext['fallbackGate']).toBeDefined();
    expect(typeof ext['getConfig']).toBe('function');
  });

  it('registers consolidation without the legacy automatic curator writer', () => {
    const deps = makeDeps({
      config: fakeConfig({
        features: { mcp: true, plugins: true, memory: true, modelsRegistry: false, skills: true },
      }),
    });
    setupProviderRuntime(deps);
    expect(deps.agent.extensions.register).toHaveBeenCalledTimes(2);
  });

  it('skips consolidation when memoryConsolidation is explicitly disabled', () => {
    const deps = makeDeps({
      config: fakeConfig({
        features: {
          mcp: true,
          plugins: true,
          memory: true,
          modelsRegistry: false,
          skills: true,
          memoryConsolidation: false,
        },
      }),
    });
    setupProviderRuntime(deps);
    expect(deps.agent.extensions.register).toHaveBeenCalledTimes(1);
  });

  it('skips curator when memoryCurator is explicitly disabled', () => {
    const deps = makeDeps({
      config: fakeConfig({
        features: {
          mcp: true,
          plugins: true,
          memory: true,
          modelsRegistry: false,
          skills: true,
          memoryCurator: false,
        },
      }),
    });
    setupProviderRuntime(deps);
    expect(deps.agent.extensions.register).toHaveBeenCalledTimes(2);
  });
});

describe('setupProviderRuntime — config watchers', () => {
  it('replaces the complete live config and synchronizes runtime state', async () => {
    const next = fakeConfig({
      autonomy: { defaultMode: 'auto' },
      extensions: { telegram: { inboundMode: 'allowlist' } },
    });
    const deps = makeDeps({ loadConfig: vi.fn(async () => next) });
    snapshotByPath['/home/profiles/default.json'] = { providers: {} };
    const runtime = setupProviderRuntime(deps);

    await runtime.reloadProviderConfig();

    expect(deps.configStore.replace).toHaveBeenCalledWith(next);
    expect(deps.onConfigUpdate).toHaveBeenCalledWith(next);
    expect(deps.fallbackProfileManager.reload).toHaveBeenCalledWith(next);
    expect(runtime.resolveProviderCfg('anthropic').cfg).toEqual(
      expect.objectContaining({ apiKey: next.apiKey }),
    );
  });

  it('reloads the live fallback account rather than the configured primary', async () => {
    const deps = makeDeps({
      config: fakeConfig({
        providers: {
          anthropic: { type: 'anthropic', apiKey: TOKEN_PROFILE },
          work: { type: 'anthropic', apiKey: TOKEN_WORK },
        },
      }),
      resolveProviderCfgRuntime: resolveProviderCfg,
    });
    deps.context.provider = fakeProvider('work');
    snapshotByPath['/home/profiles/default.json'] = {
      providers: {
        anthropic: { type: 'anthropic', apiKey: TOKEN_PROFILE },
        work: { type: 'anthropic', apiKey: TOKEN_ROTATED },
      },
    };
    const runtime = setupProviderRuntime(deps);
    await runtime.reloadProviderConfig();
    expect(deps.buildProviderForIdRuntime).toHaveBeenCalledWith(expect.anything(), 'work');
    expect(deps.context.provider?.id).toBe('work');
    expect(deps.context.runModelTransition).toHaveBeenCalled();
  });

  it('blocks the old credential after its account is deleted, and can recover on recreation', async () => {
    const old = fakeProvider('work');
    const build = vi.fn((): Provider => {
      return fakeProvider('work');
    });
    const deps = makeDeps({
      config: fakeConfig({ providers: { work: { type: 'anthropic', apiKey: TOKEN_WORK } } }),
      resolveProviderCfgRuntime: resolveProviderCfg,
      buildProviderForIdRuntime: build,
    });
    deps.context.provider = old;
    snapshotByPath['/home/profiles/default.json'] = { providers: {}, snapshotHasProviders: true };
    const runtime = setupProviderRuntime(deps);
    await runtime.reloadProviderConfig();
    const request = { model: 'test', messages: [], maxTokens: 10 } as Parameters<
      Provider['complete']
    >[0];
    await expect(
      deps.context.provider!.complete(request, { signal: new AbortController().signal }),
    ).rejects.toThrow('auth profile');
    expect(build).not.toHaveBeenCalled();
    expect(old.complete).not.toHaveBeenCalled();
    await expect(
      deps.context
        .provider!.stream(request, {
          signal: new AbortController().signal,
        })
        [Symbol.asyncIterator]()
        .next(),
    ).rejects.toThrow('auth profile');
    expect(old.stream).not.toHaveBeenCalled();
    const replacement = fakeProvider('work');
    build.mockImplementation(() => replacement);
    snapshotByPath['/home/profiles/default.json'] = {
      providers: { work: { type: 'anthropic', apiKey: TOKEN_ROTATED } },
    };
    await runtime.reloadProviderConfig();
    expect(deps.context.provider).toBe(replacement);
  });

  it('retries an unchanged credential snapshot after a transient construction failure', async () => {
    const build = vi.fn((): Provider => {
      throw new Error('temporarily unavailable');
    });
    const deps = makeDeps({ buildProviderForIdRuntime: build });
    snapshotByPath['/home/profiles/default.json'] = { providers: {}, apiKey: TOKEN_ROTATED };
    const runtime = setupProviderRuntime(deps);
    await runtime.reloadProviderConfig();
    const recovered = fakeProvider('anthropic');
    build.mockImplementation(() => recovered);
    await runtime.reloadProviderConfig();
    expect(build).toHaveBeenCalledTimes(2);
    expect(deps.context.provider).toBe(recovered);
  });

  it('keeps a model switch that ran ahead of the queued credential rebuild', async () => {
    const deps = makeDeps();
    const switched = fakeProvider('work');
    deps.context.runModelTransition.mockImplementation(async (fn: () => Promise<unknown>) => {
      deps.context.provider = switched;
      return fn();
    });
    snapshotByPath['/home/profiles/default.json'] = { providers: {}, apiKey: TOKEN_ROTATED };
    const runtime = setupProviderRuntime(deps);
    await runtime.reloadProviderConfig();
    expect(deps.context.provider).toBe(switched);
    expect(deps.buildProviderForIdRuntime).not.toHaveBeenCalled();
  });

  it('applies a later credential write after an earlier catalog rebuild finishes', async () => {
    const providers = await import('@wrongstack/providers');
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(providers.withCatalogCapabilities).mockImplementationOnce(
      async (_models, _id, provider) => {
        await waiting;
        return provider;
      },
    );
    const deps = makeDeps({
      config: fakeConfig({
        features: {
          mcp: true,
          plugins: true,
          memory: false,
          modelsRegistry: true,
          skills: true,
        },
      }),
    });
    const runtime = setupProviderRuntime(deps);
    snapshotByPath['/home/profiles/default.json'] = { providers: {}, apiKey: TOKEN_ROTATED };
    const first = runtime.reloadProviderConfig();
    await flushAsync();
    snapshotByPath['/home/profiles/default.json'] = { providers: {}, apiKey: TOKEN_WORK };
    const second = runtime.reloadProviderConfig();
    await flushAsync();
    expect(deps.buildProviderForIdRuntime).toHaveBeenCalledTimes(1);
    release!();
    await Promise.all([first, second]);
    expect(deps.buildProviderForIdRuntime).toHaveBeenCalledTimes(2);
    const builds = vi.mocked(deps.buildProviderForIdRuntime).mock.calls;
    expect(builds[0]?.[0].config.apiKey).toBe(TOKEN_ROTATED);
    expect(builds[1]?.[0].config.apiKey).toBe(TOKEN_WORK);
  });

  it('watches the profile, project-local, in-project, and bootstrap layers', () => {
    const deps = makeDeps();
    setupProviderRuntime(deps);
    expect(createdWatchers.map((w) => w.path)).toEqual([
      '/home/profiles/default.json',
      '/proj/.wrongstack/config.local.json',
      '/proj/.wrongstack/config.json',
      // The root bootstrap is watched for the profile SELECTION only; it is
      // deliberately not a ProviderConfigSnapshot merge layer.
      '/home/config.json',
    ]);
  });

  it('opens no watchers when WRONGSTACK_DISABLE_CONFIG_WATCH=1', () => {
    process.env['WRONGSTACK_DISABLE_CONFIG_WATCH'] = '1';
    const deps = makeDeps();
    setupProviderRuntime(deps);
    expect(createdWatchers).toHaveLength(0);
  });

  it('still reloads an explicit auth save when file watching is disabled', async () => {
    process.env['WRONGSTACK_DISABLE_CONFIG_WATCH'] = '1';
    snapshotByPath['/home/profiles/default.json'] = {
      providers: { anthropic: { apiKey: TOKEN_ROTATED } },
      apiKey: TOKEN_ROTATED,
    };
    const deps = makeDeps();
    const runtime = setupProviderRuntime(deps);
    await runtime.reloadProviderConfig();
    expect(createdWatchers).toHaveLength(0);
    expect(deps.configStore.replace).toHaveBeenCalledWith(
      expect.objectContaining({ providers: { anthropic: { apiKey: TOKEN_ROTATED } } }),
    );
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
    expect(deps.configStore.replace).toHaveBeenCalledTimes(1);
    const patch = deps.configStore.replace.mock.calls[0]?.[0] as Record<string, unknown>;
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
    expect(deps.configStore.replace).toHaveBeenCalledTimes(1);
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
    const patch = deps.configStore.replace.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(patch['providers']).toEqual({});
    expect(patch['apiKey']).toBe(TOKEN_TOP);
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
    expect(deps.configStore.replace).toHaveBeenCalled();
    expect(deps.context.provider?.id).toBe('anthropic');
    expect(deps.logger.info).not.toHaveBeenCalledWith(
      expect.stringContaining('credentials reloaded'),
    );
  });

  it('rebuilds the active provider with the catalog overlay on credential changes', async () => {
    snapshotByPath['/home/profiles/default.json'] = {
      providers: { anthropic: { apiKey: TOKEN_ROTATED } },
      apiKey: TOKEN_ROTATED,
    };
    const deps = makeDeps({
      config: fakeConfig({
        features: { mcp: true, plugins: true, memory: false, modelsRegistry: true, skills: true },
      }),
    });
    setupProviderRuntime(deps);
    createdWatchers[0]?.trigger();
    await flushAsync();
    expect(deps.context.provider?.id).toBe('anthropic-catalog');
    expect(deps.logger.info).toHaveBeenCalledWith(
      'Provider credentials reloaded from config (anthropic)',
    );
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
    expect(deps.configStore.replace).toHaveBeenCalled();
  });

  it('adopts an external bootstrap profile edit and rebinds the layers', async () => {
    // A desktop/external edit changes the selection in the root bootstrap only;
    // ConfigStore is never touched, so only the bootstrap watcher can see it.
    utilsMod.readJsonObjectFile = vi.fn(
      async () => ({ version: 1, activeProfile: 'work' }) as Record<string, unknown>,
    );
    snapshotByPath['/home/profiles/work.json'] = {
      providers: { anthropic: { apiKey: TOKEN_WORK } },
      apiKey: TOKEN_WORK,
    };
    const deps = makeDeps();
    setupProviderRuntime(deps);

    expect(createdWatchers.map((w) => w.path)).toContain('/home/config.json');
    createdWatchers.find((w) => w.path === '/home/config.json')?.trigger();
    await flushAsync();

    // The selection reaches the store WITHOUT the bootstrap's `version` field:
    // routing `version` through a watcher patch is what could trip the
    // ConfigStore guard (storage/config-store.ts:62) that requires version 1.
    expect(deps.configStore.update).toHaveBeenCalledWith({ activeProfile: 'work' });
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
