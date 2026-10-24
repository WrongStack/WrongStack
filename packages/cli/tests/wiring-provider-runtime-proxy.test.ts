import type { Config, Provider } from '@wrongstack/contracts/types';
import {
  __resetProxyConfigForTests,
  applyProxyConfig,
} from '@wrongstack/core/wiring/proxy-rewrite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveProviderCfg } from '../src/wiring/provider-runtime.js';
import {
  type ProviderRuntimeDeps,
  setupProviderRuntime,
} from '../src/wiring/provider-runtime-setup.js';

vi.mock('@wrongstack/providers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withCatalogCapabilities: vi.fn(
    async (_models: unknown, _id: string, provider: Provider) => provider,
  ),
}));
vi.mock('@wrongstack/core/agent', () => ({
  createFallbackModelExtension: vi.fn(() => ({ name: 'fallback-model' })),
}));
vi.mock('@wrongstack/core/storage', () => ({
  readProviderSnapshot: vi.fn(async () => undefined),
  watchProviderConfig: vi.fn(() => ({ close: vi.fn() })),
  SessionMemoryConsolidator: class SessionMemoryConsolidator {},
}));
vi.mock('@wrongstack/sage', () => ({ getSageService: vi.fn(() => undefined) }));

function fakeConfig(overrides: Partial<Config> = {}): Config {
  return {
    version: 1,
    provider: 'anthropic',
    model: 'claude-3',
    features: { mcp: true, plugins: true, memory: false, modelsRegistry: false, skills: true },
    ...overrides,
  } as Config;
}

function fakeProvider(id: string): Provider {
  return { id, capabilities: {} as never, complete: vi.fn(), stream: vi.fn() } as Provider;
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function proxyDeps(): {
  deps: ProviderRuntimeDeps;
  context: ProviderRuntimeDeps['context'];
} {
  const config = fakeConfig({ baseUrl: 'https://api.example.com/v1' });
  const context = {
    provider: fakeProvider('anthropic'),
    model: 'claude-3',
    runModelTransition: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
  } as ProviderRuntimeDeps['context'];
  const configStore = {
    get: () => config,
    update: vi.fn(),
    replace: vi.fn(),
    watch: vi.fn(() => () => {}),
  };
  const deps: ProviderRuntimeDeps = {
    config,
    loadConfig: vi.fn(async () => config),
    onConfigUpdate: vi.fn(),
    configStore,
    fallbackProfileManager: { reload: vi.fn() } as never,
    providerRegistry: {} as never,
    modelsRegistry: {} as never,
    agent: { extensions: { register: vi.fn() } },
    memoryStore: { getCapability: () => undefined },
    refreshMaxContext: vi.fn(async () => {}),
    refreshActiveReasoningConfig: vi.fn(async () => {}),
    wpaths: {
      profileConfig: (profile: string) => `/home/profiles/${profile}.json`,
      globalConfig: '/home/config.json',
      projectLocalConfig: '/proj/.wrongstack/config.local.json',
      inProjectConfig: '/proj/.wrongstack/config.json',
    } as never,
    vault: {} as never,
    logger: { warn: vi.fn(), info: vi.fn() } as never,
    teardownHandlers: [] as Array<() => void>,
    context,
    events: { emit: vi.fn() } as never,
    resolveProviderCfgRuntime: vi.fn((cfg: Config, providerId: string) => ({
      cfg: { type: providerId, baseUrl: cfg.baseUrl },
    })),
    buildProviderForIdRuntime: vi.fn((_opts: unknown, providerId: string) =>
      fakeProvider(providerId),
    ),
    statusTracker: { unblock: vi.fn() } as never,
  };
  return { deps, context };
}

describe('setupProviderRuntime — WrongProxy instant-apply', () => {
  beforeEach(() => __resetProxyConfigForTests());
  afterEach(() => __resetProxyConfigForTests());

  it('rebuilds the live provider through the transition gate when the proxy activates', async () => {
    const { deps, context } = proxyDeps();
    const build = vi.fn((_opts: unknown, providerId: string) => fakeProvider(providerId));
    deps.buildProviderForIdRuntime = build as never;
    setupProviderRuntime(deps);
    const originalProvider = context.provider;

    applyProxyConfig({ enabled: true, url: 'http://localhost:3444', active: true });
    await flushAsync();

    expect(build).toHaveBeenCalledWith(expect.anything(), 'anthropic');
    expect(context.runModelTransition).toHaveBeenCalled();
    expect(context.provider).not.toBe(originalProvider);
    expect(context.provider?.id).toBe('anthropic');
    expect(deps.logger.info).toHaveBeenCalledWith(expect.stringContaining('live provider rebuilt'));
  });

  it('does not rebuild for a value-identical proxy probe tick', async () => {
    const { deps } = proxyDeps();
    const build = vi.fn((_opts: unknown, providerId: string) => fakeProvider(providerId));
    deps.buildProviderForIdRuntime = build as never;
    setupProviderRuntime(deps);

    applyProxyConfig({ enabled: true, url: 'http://localhost:3444', active: true });
    await flushAsync();
    expect(build).toHaveBeenCalledTimes(1);

    applyProxyConfig({ active: true });
    await flushAsync();
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('does not rebuild a fallback account from the configured primary endpoint', async () => {
    const { deps, context } = proxyDeps();
    context.provider = fakeProvider('work-account');
    deps.config = fakeConfig({
      baseUrl: 'https://old-primary.example/v1',
      providers: { 'work-account': { type: 'openai', apiKey: 'work-key' } },
    });
    const build = vi.fn((_opts: unknown, providerId: string) => fakeProvider(providerId));
    deps.buildProviderForIdRuntime = build as never;
    setupProviderRuntime(deps);
    const originalProvider = context.provider;

    applyProxyConfig({ enabled: true, url: 'http://localhost:3444', active: true });
    await flushAsync();

    expect(build).not.toHaveBeenCalled();
    expect(context.provider).toBe(originalProvider);
  });

  it('skips a stale swap when the live provider moved before rebuild', async () => {
    const { deps, context } = proxyDeps();
    setupProviderRuntime(deps);
    applyProxyConfig({ enabled: true, url: 'http://localhost:3444', active: true });
    context.provider = fakeProvider('openai');
    await flushAsync();
    expect(context.provider.id).toBe('openai');
  });

  it('stops rebuilding after teardown', async () => {
    const { deps } = proxyDeps();
    const build = vi.fn((_opts: unknown, providerId: string) => fakeProvider(providerId));
    deps.buildProviderForIdRuntime = build as never;
    setupProviderRuntime(deps);
    for (const dispose of deps.teardownHandlers) dispose();

    applyProxyConfig({ enabled: true, url: 'http://localhost:3444', active: true });
    await flushAsync();
    expect(build).not.toHaveBeenCalled();
  });
});

describe('resolveProviderCfg — WrongProxy rewrite log redaction', () => {
  beforeEach(() => __resetProxyConfigForTests());
  afterEach(() => __resetProxyConfigForTests());

  function logLines(baseUrl: string): string[] {
    const lines: string[] = [];
    resolveProviderCfg(fakeConfig({ baseUrl }), 'anthropic', {
      logger: { info: (message: string) => lines.push(message) },
    });
    return lines.filter((line) => line.includes('WrongProxy rewrite'));
  }

  it('redacts fragment credentials from an unparseable URL', () => {
    const lines = logLines('https://api.example.com path/#key=fixture-token-frag');
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('fixture-token-frag');
    expect(lines[0]).not.toContain('#');
    expect(lines[0]).toContain('https://api.example.com path/');
  });

  it('redacts query credentials from a well-formed URL', () => {
    const lines = logLines('https://api.example.com/v1?key=fixture-token-query');
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('fixture-token-query');
    expect(lines[0]).toContain('https://api.example.com/v1');
  });
});
