import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultModelsRegistry } from '../../src/models/models-registry.js';
import type { ModelsDevPayload } from '../../src/types/models-registry.js';

const SAMPLE: ModelsDevPayload = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    npm: '@ai-sdk/anthropic',
    models: {
      m1: {
        id: 'm1',
        name: 'M1',
        release_date: '2026-01-01',
        tool_call: true,
        limit: { context: 1000 },
        cost: { input: 1, output: 2 },
      },
    },
  },
  empty: { id: 'empty', name: 'Empty', npm: '@ai-sdk/openai', models: {} },
};

const OVERLAY: ModelsDevPayload = {
  custom: { id: 'custom', name: 'Custom', npm: '@ai-sdk/openai-compatible', models: {} },
};

const jsonResponse = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => body }) as never as Response;

let dir: string;
let cacheFile: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-models-'));
  cacheFile = path.join(dir, 'models.dev.json');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

async function writeCache(file: string, payload: ModelsDevPayload, ageMs = 0): Promise<void> {
  await fs.writeFile(
    file,
    JSON.stringify({ fetchedAt: new Date(Date.now() - ageMs).toISOString(), url: 'x', payload }),
  );
}

describe('models-registry — extra coverage', () => {
  it('serves a fresh cache without hitting the network', async () => {
    await writeCache(cacheFile, SAMPLE);
    const fetchImpl = vi.fn() as never as typeof fetch;
    const reg = new DefaultModelsRegistry({ cacheFile, fetchImpl });
    const payload = await reg.load();
    expect(payload.anthropic).toBeDefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws an HTTP error when the fetch is not ok and there is no cache', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, false, 503)) as never as typeof fetch;
    const reg = new DefaultModelsRegistry({ cacheFile, fetchImpl, ttlSeconds: 0 });
    await expect(reg.load()).rejects.toThrow(/HTTP 503/);
  });

  it('maps an AbortError to a timeout error', async () => {
    const fetchImpl = vi.fn(async () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }) as never as typeof fetch;
    const reg = new DefaultModelsRegistry({
      cacheFile,
      fetchImpl,
      ttlSeconds: 0,
      refreshTimeoutMs: 5,
    });
    await expect(reg.load()).rejects.toThrow(/timed out/);
  });

  it('rejects a poisoned 200 payload and falls back to the stale cache', async () => {
    await writeCache(cacheFile, SAMPLE); // stale under ttlSeconds:0
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: 'blocked by captive portal' }),
    ) as never as typeof fetch;
    const reg = new DefaultModelsRegistry({ cacheFile, fetchImpl, ttlSeconds: 0 });
    const payload = await reg.load();
    // The error envelope is a valid-JSON 200 but not a catalog — it must not
    // replace the stale-but-real cache.
    expect(payload.anthropic).toBeDefined();
    expect((payload as Record<string, unknown>).error).toBeUndefined();
  });

  it('refuses to cache a poisoned 200 payload when there is no cache', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: 'blocked' }),
    ) as never as typeof fetch;
    const reg = new DefaultModelsRegistry({ cacheFile, fetchImpl, ttlSeconds: 0 });
    await expect(reg.load()).rejects.toThrow(/non-catalog payload/);
  });

  it('getModel returns undefined for unknown provider or model', async () => {
    const reg = new DefaultModelsRegistry({ cacheFile, seed: SAMPLE });
    expect(await reg.getModel('nope', 'm1')).toBeUndefined();
    expect(await reg.getModel('anthropic', 'nope')).toBeUndefined();
    expect(await reg.getModel('anthropic', 'm1')).toMatchObject({
      providerId: 'anthropic',
      modelId: 'm1',
    });
  });

  it('suggestModel returns undefined for unknown provider or a provider with no models', async () => {
    const reg = new DefaultModelsRegistry({ cacheFile, seed: SAMPLE });
    expect(await reg.suggestModel('nope')).toBeUndefined();
    expect(await reg.suggestModel('empty')).toBeUndefined();
    expect(await reg.suggestModel('anthropic')).toBe('m1');
  });

  it('ageSeconds reads the cache when nothing has been loaded, and reports Infinity with no cache', async () => {
    await writeCache(cacheFile, SAMPLE, 5000);
    const reg = new DefaultModelsRegistry({ cacheFile });
    expect(await reg.ageSeconds()).toBeGreaterThan(0);
    const empty = new DefaultModelsRegistry({ cacheFile: path.join(dir, 'missing.json') });
    expect(await empty.ageSeconds()).toBe(Number.POSITIVE_INFINITY);
  });

  it('cacheLocation resolves the cache path', () => {
    const reg = new DefaultModelsRegistry({ cacheFile });
    expect(reg.cacheLocation()).toBe(path.resolve(cacheFile));
  });

  it('memoises an in-memory overlay merged on top of the base', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(SAMPLE)) as never as typeof fetch;
    const reg = new DefaultModelsRegistry({ cacheFile, fetchImpl, overlay: OVERLAY });
    const first = await reg.load();
    expect(first.custom).toBeDefined();
    expect(first.anthropic).toBeDefined();
    const second = await reg.load(); // memoised overlay
    expect(second).toBe(first);
  });

  it('fetches and caches an overlay from a URL', async () => {
    const overlayCacheFile = path.join(dir, 'overlay-cache.json');
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('overlay') ? jsonResponse(OVERLAY) : jsonResponse(SAMPLE),
    ) as never as typeof fetch;
    const reg = new DefaultModelsRegistry({
      cacheFile,
      fetchImpl,
      overlayUrl: 'https://example.com/overlay.json',
      overlayCacheFile,
    });
    const payload = await reg.load();
    expect(payload.custom).toBeDefined();
    expect(JSON.parse(await fs.readFile(overlayCacheFile, 'utf8')).payload.custom).toBeDefined();
  });

  it('falls back to a stale overlay cache when the overlay fetch fails', async () => {
    const overlayCacheFile = path.join(dir, 'overlay-cache.json');
    await writeCache(overlayCacheFile, OVERLAY, 1000); // recent stale overlay
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('overlay')) throw new Error('overlay offline');
      return jsonResponse(SAMPLE);
    }) as never as typeof fetch;
    const reg = new DefaultModelsRegistry({
      cacheFile,
      fetchImpl,
      ttlSeconds: 0,
      overlayUrl: 'https://example.com/overlay.json',
      overlayCacheFile,
    });
    const payload = await reg.load();
    expect(payload.custom).toBeDefined();
  });

  it('degrades to no overlay when the bundled overlay file is unreadable', async () => {
    const reg = new DefaultModelsRegistry({
      cacheFile,
      seed: undefined,
      fetchImpl: (async () => jsonResponse(SAMPLE)) as never as typeof fetch,
      overlayFile: path.join(dir, 'does-not-exist.json'),
    });
    const payload = await reg.load();
    expect(payload.anthropic).toBeDefined(); // base only; overlay file missing → {}
  });
});
