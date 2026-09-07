import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverAndMergeWebuiProviders } from '../src/server/model-auto-discovery.js';

const mocks = vi.hoisted(() => ({
  discoverOpenAICompatibleModels: vi.fn(),
  resolveDiscoveryTargets: vi.fn(),
}));

vi.mock('@wrongstack/providers', () => ({
  discoverOpenAICompatibleModels: mocks.discoverOpenAICompatibleModels,
  resolveDiscoveryTargets: mocks.resolveDiscoveryTargets,
}));

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

    expect(mocks.discoverOpenAICompatibleModels).toHaveBeenCalledWith('ollama', {
      baseUrl: 'http://localhost:11434',
      apiKey: 'key',
      headers: { 'X-Custom': '1' },
      providerName: 'ollama',
      fetchImpl: undefined,
    });

    expect(registry.mergeOverlay).toHaveBeenCalledWith({ ollama: fakeProvider });
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

    expect(registry.mergeOverlay).toHaveBeenCalledWith({ vllm: cachedProvider });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('using 1 cached models from 2026-09-07T12:00:00.000Z'),
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
