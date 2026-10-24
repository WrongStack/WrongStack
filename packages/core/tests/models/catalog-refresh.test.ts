import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ModelsDevPayload, ModelsRegistry } from '@wrongstack/contracts/types/models-registry';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshCatalogIfStale, startCatalog } from '../../src/models/catalog-refresh.js';
import { DefaultModelsRegistry } from '../../src/models/models-registry.js';

function payload(context: number): ModelsDevPayload {
  return {
    anthropic: {
      id: 'anthropic',
      name: 'Anthropic',
      npm: '@ai-sdk/anthropic',
      models: {
        'model-a': { id: 'model-a', name: 'Model A', limit: { context, output: 8192 } },
      },
    },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function writeCache(file: string, body: ModelsDevPayload, ageMs: number): Promise<void> {
  await fs.writeFile(
    file,
    JSON.stringify({
      fetchedAt: new Date(Date.now() - ageMs).toISOString(),
      url: 'https://models.dev/api.json',
      payload: body,
    }),
  );
}

let dir: string;
let cacheFile: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-catalog-refresh-'));
  cacheFile = path.join(dir, 'models-cache.json');
});

afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('DefaultModelsRegistry.loadCached', () => {
  it('serves a stale-but-usable cache with no network I/O', async () => {
    await writeCache(cacheFile, payload(100_000), 2 * 24 * 3600 * 1000);
    const fetchImpl = vi.fn();
    const registry = new DefaultModelsRegistry({ cacheFile, ttlSeconds: 0, fetchImpl });

    expect(await registry.loadCached()).toBe(true);
    const model = await registry.getModel('anthropic', 'model-a');

    expect(model?.capabilities.maxContext).toBe(100_000);
    expect(fetchImpl).not.toHaveBeenCalled();
    // Age reflects the cached fetch, so the caller knows a refresh is due.
    expect(await registry.ageSeconds()).toBeGreaterThan(24 * 3600);
  });

  it('returns false and loads nothing when there is no cache', async () => {
    const fetchImpl = vi.fn();
    const registry = new DefaultModelsRegistry({ cacheFile, fetchImpl });

    expect(await registry.loadCached()).toBe(false);
    expect(registry.catalogGeneration()).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a cache older than maxStaleAgeSeconds', async () => {
    await writeCache(cacheFile, payload(100_000), 10 * 24 * 3600 * 1000);
    const registry = new DefaultModelsRegistry({ cacheFile, fetchImpl: vi.fn() });

    expect(await registry.loadCached()).toBe(false);
  });

  it('refuses a poisoned (non-catalog) cache file', async () => {
    await fs.writeFile(
      cacheFile,
      JSON.stringify({ fetchedAt: new Date().toISOString(), url: 'x', payload: { error: 'nope' } }),
    );
    const registry = new DefaultModelsRegistry({ cacheFile, fetchImpl: vi.fn() });

    expect(await registry.loadCached()).toBe(false);
  });

  it('merges the bundled overlay file without fetching the overlay URL', async () => {
    await writeCache(cacheFile, payload(100_000), 60_000);
    const overlayFile = path.join(dir, 'providers.json');
    await fs.writeFile(
      overlayFile,
      JSON.stringify({
        anthropic: { id: 'anthropic', models: { 'model-a': { limit: { context: 1_000_000 } } } },
      }),
    );
    const fetchImpl = vi.fn();
    const registry = new DefaultModelsRegistry({
      cacheFile,
      fetchImpl,
      overlayFile,
      overlayUrl: 'https://example.invalid/providers.json',
      overlayCacheFile: path.join(dir, 'overlay-cache.json'),
    });

    expect(await registry.loadCached()).toBe(true);
    expect((await registry.getModel('anthropic', 'model-a'))?.capabilities.maxContext).toBe(
      1_000_000,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('DefaultModelsRegistry refresh signalling', () => {
  it('shares one network round-trip between concurrent refresh() callers', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(payload(200_000)));
    const registry = new DefaultModelsRegistry({ cacheFile, fetchImpl });

    const [a, b, c] = await Promise.all([
      registry.refresh(),
      registry.refresh(),
      registry.refresh(),
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
    // The flight is cleared afterwards, so a later refresh fetches again.
    await registry.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('clears the in-flight slot after a failed refresh', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(jsonResponse(payload(200_000)));
    const registry = new DefaultModelsRegistry({ cacheFile, fetchImpl });

    await expect(registry.refresh()).rejects.toThrow('offline');
    await expect(registry.refresh()).resolves.toBeDefined();
  });

  it('bumps the generation and notifies listeners after the new payload is live', async () => {
    await writeCache(cacheFile, payload(100_000), 60_000);
    const fetchImpl = vi.fn(async () => jsonResponse(payload(300_000)));
    const registry = new DefaultModelsRegistry({ cacheFile, fetchImpl });
    await registry.loadCached();
    const before = registry.catalogGeneration();

    const seen: number[] = [];
    registry.onCatalogChanged(() => {
      // Reading through the registry inside the listener sees the new catalog.
      void registry.getModel('anthropic', 'model-a').then((m) => {
        seen.push(m?.capabilities.maxContext ?? -1);
      });
    });
    await registry.refresh();
    await new Promise((r) => setImmediate(r));

    expect(registry.catalogGeneration()).toBe(before + 1);
    expect(seen).toEqual([300_000]);
  });

  it('isolates a throwing listener from the others and from the caller', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(payload(200_000)));
    const warn = vi.fn();
    const registry = new DefaultModelsRegistry({
      cacheFile,
      fetchImpl,
      logger: { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() } as never,
    });
    const second = vi.fn();
    registry.onCatalogChanged(() => {
      throw new Error('listener boom');
    });
    registry.onCatalogChanged(second);

    await expect(registry.refresh()).resolves.toBeDefined();
    expect(second).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('listener boom'),
      expect.objectContaining({ event: 'models_registry.listener_failed' }),
    );
  });

  it('notifies on runtime overlay merges and stops after unsubscribe', async () => {
    await writeCache(cacheFile, payload(100_000), 60_000);
    const registry = new DefaultModelsRegistry({ cacheFile, fetchImpl: vi.fn() });
    await registry.loadCached();
    const listener = vi.fn();
    const off = registry.onCatalogChanged(listener);

    registry.mergeOverlay({
      local: { id: 'local', name: 'Local', models: { m: { id: 'm', name: 'm' } } },
    });
    expect(listener).toHaveBeenCalledTimes(1);

    off();
    registry.mergeOverlay({
      local2: { id: 'local2', name: 'Local2', models: { m: { id: 'm', name: 'm' } } },
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('refreshCatalogIfStale', () => {
  function stub(age: number): ModelsRegistry & { refresh: ReturnType<typeof vi.fn> } {
    return {
      load: vi.fn(),
      refresh: vi.fn(async () => ({})),
      listProviders: vi.fn(),
      getProvider: vi.fn(),
      getModel: vi.fn(),
      suggestModel: vi.fn(),
      ageSeconds: vi.fn(async () => age),
    };
  }

  it('skips the network when the catalog was fetched recently', async () => {
    const registry = stub(60);
    expect(await refreshCatalogIfStale(registry)).toBe('recent');
    expect(registry.refresh).not.toHaveBeenCalled();
  });

  it('refreshes an old or never-fetched catalog', async () => {
    for (const age of [3600, Number.POSITIVE_INFINITY]) {
      const registry = stub(age);
      expect(await refreshCatalogIfStale(registry)).toBe('refreshed');
      expect(registry.refresh).toHaveBeenCalledTimes(1);
    }
  });

  it('always refreshes when maxAgeSeconds is 0', async () => {
    const registry = stub(1);
    expect(await refreshCatalogIfStale(registry, { maxAgeSeconds: 0 })).toBe('refreshed');
  });
});

describe('startCatalog', () => {
  const logger = () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn() });

  it('boots from cache and refreshes in the background', async () => {
    await writeCache(cacheFile, payload(100_000), 2 * 3600 * 1000);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fetchImpl = vi.fn(async () => {
      await gate;
      return jsonResponse(payload(400_000));
    });
    const registry = new DefaultModelsRegistry({ cacheFile, ttlSeconds: 0, fetchImpl });

    const result = await startCatalog({ registry, logger: logger(), intervalMs: 0 });

    // Boot continued before the network answered, serving the cached window.
    expect(result.mode).toBe('cache+background');
    expect((await registry.getModel('anthropic', 'model-a'))?.capabilities.maxContext).toBe(
      100_000,
    );
    release();
    await result.settled;
    expect((await registry.getModel('anthropic', 'model-a'))?.capabilities.maxContext).toBe(
      400_000,
    );
  });

  it('fetches in the foreground when there is no cache', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(payload(200_000)));
    const registry = new DefaultModelsRegistry({ cacheFile, fetchImpl });

    const result = await startCatalog({ registry, logger: logger() });

    expect(result.mode).toBe('foreground');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fetches in the foreground for a short-lived process even with a cache', async () => {
    await writeCache(cacheFile, payload(100_000), 2 * 3600 * 1000);
    const fetchImpl = vi.fn(async () => jsonResponse(payload(200_000)));
    const registry = new DefaultModelsRegistry({ cacheFile, fetchImpl });

    const result = await startCatalog({ registry, logger: logger(), shortLived: true });

    expect(result.mode).toBe('foreground');
    expect((await registry.getModel('anthropic', 'model-a'))?.capabilities.maxContext).toBe(
      200_000,
    );
  });

  it('never throws when the network is down — the cache stays', async () => {
    await writeCache(cacheFile, payload(100_000), 2 * 3600 * 1000);
    const log = logger();
    const registry = new DefaultModelsRegistry({
      cacheFile,
      fetchImpl: vi.fn(async () => {
        throw new Error('offline');
      }),
    });

    const result = await startCatalog({ registry, logger: log, intervalMs: 0 });
    await result.settled;

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('offline'));
    expect((await registry.getModel('anthropic', 'model-a'))?.capabilities.maxContext).toBe(
      100_000,
    );
  });

  it('re-checks periodically and stops when asked', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const registry: ModelsRegistry & { refresh: ReturnType<typeof vi.fn> } = {
      load: vi.fn(),
      loadCached: vi.fn(async () => true),
      refresh: vi.fn(async () => ({})),
      listProviders: vi.fn(),
      getProvider: vi.fn(),
      getModel: vi.fn(),
      suggestModel: vi.fn(),
      ageSeconds: vi.fn(async () => Number.POSITIVE_INFINITY),
    };

    const result = await startCatalog({ registry, logger: logger(), intervalMs: 1000 });
    await result.settled;
    expect(registry.refresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(registry.refresh).toHaveBeenCalledTimes(2);

    result.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(registry.refresh).toHaveBeenCalledTimes(2);
  });

  it('falls back to a foreground refresh for registries without loadCached', async () => {
    const registry: ModelsRegistry & { refresh: ReturnType<typeof vi.fn> } = {
      load: vi.fn(),
      refresh: vi.fn(async () => ({})),
      listProviders: vi.fn(),
      getProvider: vi.fn(),
      getModel: vi.fn(),
      suggestModel: vi.fn(),
      ageSeconds: vi.fn(async () => Number.POSITIVE_INFINITY),
    };

    const result = await startCatalog({ registry, logger: logger() });

    expect(result.mode).toBe('foreground');
    expect(registry.refresh).toHaveBeenCalledTimes(1);
  });
});
