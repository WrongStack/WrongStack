import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config } from '@wrongstack/contracts/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const config: Config = {
  version: 1,
  provider: 'account',
  model: 'cached',
  context: {
    warnThreshold: 0.7,
    softThreshold: 0.8,
    hardThreshold: 0.9,
    preserveK: 2,
    eliseThreshold: 1000,
  },
  tools: {
    defaultExecutionStrategy: 'sequential',
    maxIterations: 0,
    iterationTimeoutMs: 1000,
    sessionTimeoutMs: 1000,
    perIterationOutputCapBytes: 1024,
  },
  log: { level: 'error' },
  features: { mcp: false, plugins: false, memory: false, modelsRegistry: true, skills: false },
};

import { discoverAndMergeWebuiProviders } from '../src/server/model-auto-discovery.js';

const mocks = vi.hoisted(() => ({
  discoverOpenAICompatibleModels: vi.fn(),
  resolveDiscoveryTargets: vi.fn(),
}));

vi.mock('@wrongstack/providers', async (importOriginal) => {
  // The overlay/cache helpers are pure and shared with the CLI host; use the
  // real ones so this suite exercises the same merge the CLI does.
  const actual = await importOriginal<typeof import('@wrongstack/providers')>();
  return {
    discoverOpenAICompatibleModels: mocks.discoverOpenAICompatibleModels,
    resolveDiscoveryTargets: mocks.resolveDiscoveryTargets,
    discoveryOverlay: actual.discoveryOverlay,
    pruneDiscoveryCache: actual.pruneDiscoveryCache,
  };
});

describe('model-auto-discovery', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-discovery-test-'));
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('serves a fresh identity-scoped cache without waiting for discovery', async () => {
    const cfg = { models: ['old'] };
    const provider = { id: 'account', models: { cached: { id: 'cached' } } };
    mocks.resolveDiscoveryTargets.mockReturnValue([
      {
        id: 'account',
        cfg,
        baseUrl: 'https://catalog.test/v1',
        cacheKey: 'identity',
        accountCatalog: true,
      },
    ]);
    await fs.writeFile(
      path.join(tmpDir, 'discovered-models-cache.json'),
      JSON.stringify({ identity: { fetchedAt: new Date().toISOString(), provider } }),
    );
    const registry = { mergeOverlay: vi.fn() };
    // If startup contacts the network, it would block on this unresolved request.
    mocks.discoverOpenAICompatibleModels.mockReturnValue(new Promise(() => undefined));
    const startup = discoverAndMergeWebuiProviders({ config, registry, cacheDir: tmpDir });
    await vi.waitFor(() => expect(registry.mergeOverlay).toHaveBeenCalled());
    await startup;
    expect(mocks.discoverOpenAICompatibleModels).not.toHaveBeenCalled();
    expect(cfg.models).toEqual(['cached']);
  });

  it.each(['expired', 'future', 'other-account', 'invalid'])(
    'refreshes a %s cache instead of trusting it',
    async (kind) => {
      const provider = { id: 'account', models: { cached: { id: 'cached' } } };
      const fetchedAt =
        kind === 'expired'
          ? new Date(Date.now() - 5 * 60_000).toISOString()
          : kind === 'future'
            ? new Date(Date.now() + 60_000).toISOString()
            : new Date().toISOString();
      await fs.writeFile(
        path.join(tmpDir, 'discovered-models-cache.json'),
        JSON.stringify({
          [kind === 'other-account' ? 'foreign-identity' : 'identity']: {
            fetchedAt,
            provider: kind === 'invalid' ? { models: null } : provider,
          },
        }),
      );
      mocks.resolveDiscoveryTargets.mockReturnValue([
        { id: 'account', cfg: {}, baseUrl: 'https://catalog.test/v1', cacheKey: 'identity' },
      ]);
      const live = { id: 'account', models: { live: { id: 'live' } } };
      mocks.discoverOpenAICompatibleModels.mockResolvedValue(live);
      const registry = { mergeOverlay: vi.fn() };
      await discoverAndMergeWebuiProviders({ config, registry, cacheDir: tmpDir });
      expect(mocks.discoverOpenAICompatibleModels).toHaveBeenCalledOnce();
      expect(registry.mergeOverlay).toHaveBeenCalledWith({ account: live }, {});
    },
  );

  it('does not apply a fresh cache for an account that is no longer current', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'discovered-models-cache.json'),
      JSON.stringify({
        identity: { fetchedAt: new Date().toISOString(), provider: { models: {} } },
      }),
    );
    mocks.resolveDiscoveryTargets.mockReturnValue([
      {
        id: 'account',
        cfg: {},
        baseUrl: 'https://catalog.test/v1',
        cacheKey: 'identity',
        isCurrent: () => false,
      },
    ]);
    const registry = { mergeOverlay: vi.fn() };
    mocks.discoverOpenAICompatibleModels.mockResolvedValue(undefined);
    await discoverAndMergeWebuiProviders({ config, registry, cacheDir: tmpDir });
    expect(registry.mergeOverlay).not.toHaveBeenCalled();
    expect(mocks.discoverOpenAICompatibleModels).not.toHaveBeenCalled();
  });

  it('forwards account renewal and caches using its rotated identity', async () => {
    const target = {
      id: 'account',
      cfg: {},
      baseUrl: 'https://catalog.test/v1',
      apiKey: 'expired',
      cacheKey: 'old-identity',
      prepareApiKey: vi.fn(async () => {
        target.cacheKey = 'renewed-identity';
        return 'renewed';
      }),
    };
    mocks.resolveDiscoveryTargets.mockReturnValue([target]);
    mocks.discoverOpenAICompatibleModels.mockImplementationOnce(async (_id, options) => {
      await options.prepareApiKey(options.fetchImpl);
      return { id: 'account', models: { live: { id: 'live' } } };
    });
    await discoverAndMergeWebuiProviders({
      config: {} as never,
      registry: { mergeOverlay: vi.fn() },
      cacheDir: tmpDir,
    });
    expect(target.prepareApiKey).toHaveBeenCalledOnce();
    const cache = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'discovered-models-cache.json'), 'utf8'),
    );
    expect(cache['renewed-identity'].provider.models.live.id).toBe('live');
    expect(cache['old-identity']).toBeUndefined();
  });

  it('reports catalog HTTP errors without exposing the response or assuming an outage', async () => {
    mocks.resolveDiscoveryTargets.mockReturnValue([
      { id: 'account', cfg: {}, baseUrl: 'https://catalog.test/v1', cacheKey: 'account' },
    ]);
    mocks.discoverOpenAICompatibleModels.mockImplementationOnce(async (_id, options) => {
      options.onFailure('HTTP 401; check account credentials and permissions');
      return undefined;
    });
    const warn = vi.fn();
    await discoverAndMergeWebuiProviders({
      config: {} as never,
      registry: { mergeOverlay: vi.fn() },
      cacheDir: tmpDir,
      logger: { warn } as never,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 401'));
    expect(warn.mock.calls.flat().join(' ')).not.toContain('unreachable');
  });

  it('bails out early if registry does not implement OverlayRegistry', async () => {
    mocks.resolveDiscoveryTargets.mockReturnValue([
      { id: 'target-1', cfg: {}, baseUrl: 'http://localhost:11434', apiKey: '', cacheKey: 'key-1' },
    ]);

    await discoverAndMergeWebuiProviders({
      config: {} as never,
      registry: null,
      cacheDir: tmpDir,
    });

    await discoverAndMergeWebuiProviders({
      config: {} as never,
      registry: { notMergeOverlay: () => {} },
      cacheDir: tmpDir,
    });

    expect(mocks.discoverOpenAICompatibleModels).not.toHaveBeenCalled();
  });

  it('bails out early if resolveDiscoveryTargets returns empty array', async () => {
    mocks.resolveDiscoveryTargets.mockReturnValue([]);
    const registry = { mergeOverlay: vi.fn() };

    await discoverAndMergeWebuiProviders({
      config: {} as never,
      registry,
      cacheDir: tmpDir,
    });

    expect(mocks.discoverOpenAICompatibleModels).not.toHaveBeenCalled();
    expect(registry.mergeOverlay).not.toHaveBeenCalled();
  });

  it('discovers models, merges overlay, writes cache file, and logs info', async () => {
    const registry = { mergeOverlay: vi.fn() };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };

    mocks.resolveDiscoveryTargets.mockReturnValue([
      {
        id: 'ollama',
        cfg: { headers: { 'X-Custom': '1' } },
        baseUrl: 'http://localhost:11434',
        apiKey: 'key',
        cacheKey: 'ollama:http://localhost:11434',
      },
    ]);

    const fakeProvider = {
      id: 'ollama',
      models: {
        'llama3.1:8b': { id: 'llama3.1:8b', name: 'Llama 3.1 8B' },
        'qwen2.5:7b': { id: 'qwen2.5:7b', name: 'Qwen 2.5 7B' },
      },
    };

    mocks.discoverOpenAICompatibleModels.mockResolvedValue(fakeProvider);

    await discoverAndMergeWebuiProviders({
      config: {} as never,
      registry,
      cacheDir: tmpDir,
      logger,
    });

    expect(mocks.discoverOpenAICompatibleModels).toHaveBeenCalledWith(
      'ollama',
      expect.objectContaining({
        baseUrl: 'http://localhost:11434',
        apiKey: 'key',
        headers: { 'X-Custom': '1' },
        providerName: 'ollama',
        fetchImpl: undefined,
        onFailure: expect.any(Function),
      }),
    );

    expect(registry.mergeOverlay).toHaveBeenCalledWith({ ollama: fakeProvider }, {});
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('auto-discovered 2 models for "ollama"'),
    );

    // Verify cache file was written
    const cacheFile = path.join(tmpDir, 'discovered-models-cache.json');
    const cachedContent = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
    expect(cachedContent['ollama:http://localhost:11434']).toMatchObject({
      provider: fakeProvider,
    });
  });

  it('uses cached models when discovery returns null and cache exists', async () => {
    const registry = { mergeOverlay: vi.fn() };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };

    const cacheFile = path.join(tmpDir, 'discovered-models-cache.json');
    const cachedProvider = {
      id: 'vllm',
      models: { 'mistral-7b': { id: 'mistral-7b' } },
    };
    await fs.writeFile(
      cacheFile,
      JSON.stringify({
        'vllm:http://localhost:8000': {
          fetchedAt: '2026-09-07T12:00:00.000Z',
          provider: cachedProvider,
        },
      }),
      'utf8',
    );

    mocks.resolveDiscoveryTargets.mockReturnValue([
      {
        id: 'vllm',
        cfg: {},
        baseUrl: 'http://localhost:8000',
        apiKey: '',
        cacheKey: 'vllm:http://localhost:8000',
      },
    ]);

    // Discovery fails (returns null)
    mocks.discoverOpenAICompatibleModels.mockResolvedValue(null);

    await discoverAndMergeWebuiProviders({
      config: {} as never,
      registry,
      cacheDir: tmpDir,
      logger,
    });

    expect(registry.mergeOverlay).toHaveBeenCalledWith({ vllm: cachedProvider }, {});
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('using 1 cached models from 2026-09-07T12:00:00.000Z'),
    );
  });

  it('passes xAI discovery metadata and applies account visibility', async () => {
    const registry = { mergeOverlay: vi.fn() };
    const cfg = { type: 'xai' };
    mocks.resolveDiscoveryTargets.mockReturnValue([
      {
        id: 'xai',
        cfg,
        baseUrl: 'https://api.x.ai/v1',
        apiKey: 'xai-key',
        cacheKey: 'xai-key',
        modelDiscoveryPath: 'language-models',
        modelDiscoveryAuthoritative: true,
      },
    ]);
    const provider = {
      id: 'xai',
      models: { 'grok-4.6': { id: 'grok-4.6' } },
    };
    mocks.discoverOpenAICompatibleModels.mockResolvedValue(provider);

    await discoverAndMergeWebuiProviders({
      config: { providers: { xai: cfg } } as never,
      registry,
      cacheDir: tmpDir,
    });

    expect(mocks.discoverOpenAICompatibleModels).toHaveBeenCalledWith(
      'xai',
      expect.objectContaining({ modelDiscoveryPath: 'language-models' }),
    );
    expect(cfg).not.toHaveProperty('models');
    expect(registry.mergeOverlay).toHaveBeenCalledWith(
      { xai: provider },
      expect.objectContaining({ authoritativeProviderIds: ['xai'] }),
    );
  });

  it('logs warning when discovery fails and no cache is available', async () => {
    const registry = { mergeOverlay: vi.fn() };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };

    mocks.resolveDiscoveryTargets.mockReturnValue([
      {
        id: 'remote-ai',
        cfg: {},
        baseUrl: 'http://unreachable:9999',
        apiKey: '',
        cacheKey: 'remote:http://unreachable:9999',
      },
    ]);

    mocks.discoverOpenAICompatibleModels.mockResolvedValue(null);

    await discoverAndMergeWebuiProviders({
      config: {} as never,
      registry,
      cacheDir: tmpDir,
      logger,
    });

    expect(registry.mergeOverlay).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('auto-discovery for "remote-ai" failed and no cache available'),
    );
  });

  it('handles corrupted cache file gracefully and logs debug on cache write failure', async () => {
    const registry = { mergeOverlay: vi.fn() };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };

    const cacheFile = path.join(tmpDir, 'discovered-models-cache.json');
    await fs.writeFile(cacheFile, '{ invalid json', 'utf8');

    mocks.resolveDiscoveryTargets.mockReturnValue([
      {
        id: 'test',
        cfg: {},
        baseUrl: 'http://localhost:8080',
        apiKey: '',
        cacheKey: 'test:http://localhost:8080',
      },
    ]);

    const fakeProvider = { id: 'test', models: {} };
    mocks.discoverOpenAICompatibleModels.mockResolvedValue(fakeProvider);

    // Create a file where a directory is expected so mkdir fails with ENOTDIR/EEXIST
    const blockerFile = path.join(tmpDir, 'blocker');
    await fs.writeFile(blockerFile, 'not a dir');
    const invalidCacheDir = path.join(blockerFile, 'subfolder');

    await discoverAndMergeWebuiProviders({
      config: {} as never,
      registry,
      cacheDir: invalidCacheDir,
      logger,
    });

    expect(logger.debug).toHaveBeenCalledWith('provider auto-discovery cache write failed');
  });
});
