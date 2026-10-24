import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ModelsDevPayload } from '@wrongstack/contracts/types';
import { DefaultModelsRegistry } from '@wrongstack/core/models';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { capabilitiesFor } from '../src/capabilities.js';
import {
  clearModelOutputLimitResolver,
  installCatalogModelOutputLimits,
  resolveCatalogMaxOutput,
} from '../src/model-output-limits.js';

/**
 * Boot now serves the cached catalog and refreshes it in the background. The
 * two caches derived from the catalog must follow that refresh no matter when
 * it lands — including before the output-limit resolver is even installed —
 * and without relying on `refresh()` being monkey-patched.
 */

function catalog(context: number, output: number): ModelsDevPayload {
  return {
    anthropic: {
      id: 'anthropic',
      name: 'Anthropic',
      npm: '@ai-sdk/anthropic',
      models: {
        'model-a': { id: 'model-a', name: 'Model A', tool_call: true, limit: { context, output } },
      },
    },
  } as never as ModelsDevPayload;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

let dir: string;
let cacheFile: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-catalog-change-'));
  cacheFile = path.join(dir, 'models-cache.json');
  await fs.writeFile(
    cacheFile,
    JSON.stringify({
      fetchedAt: new Date(Date.now() - 3600_000).toISOString(),
      url: 'https://models.dev/api.json',
      payload: catalog(100_000, 8_000),
    }),
  );
});

afterEach(async () => {
  clearModelOutputLimitResolver();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('derived caches follow catalog changes', () => {
  it('drops cached capabilities when the catalog generation moves', async () => {
    const registry = new DefaultModelsRegistry({
      cacheFile,
      fetchImpl: vi.fn(async () => json(catalog(900_000, 64_000))),
    });
    await registry.loadCached();

    expect((await capabilitiesFor(registry, 'anthropic', 'model-a')).maxContext).toBe(100_000);
    await registry.refresh();
    expect((await capabilitiesFor(registry, 'anthropic', 'model-a')).maxContext).toBe(900_000);
  });

  it('does not monkey-patch refresh on a generation-aware registry', async () => {
    const registry = new DefaultModelsRegistry({ cacheFile, fetchImpl: vi.fn() });
    const original = registry.refresh;
    await registry.loadCached();

    await capabilitiesFor(registry, 'anthropic', 'model-a');
    await installCatalogModelOutputLimits({ registry, getConfig: () => undefined });

    expect(registry.refresh).toBe(original);
  });

  it('rebuilds the output-limit index from a refresh started before install', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const registry = new DefaultModelsRegistry({
      cacheFile,
      fetchImpl: vi.fn(async () => {
        await gate;
        return json(catalog(900_000, 64_000));
      }),
    });
    await registry.loadCached();

    // Boot's background refresh is already in flight…
    const background = registry.refresh();
    // …when provider wiring installs the resolver from the cached catalog.
    await installCatalogModelOutputLimits({ registry, getConfig: () => undefined });
    expect(resolveCatalogMaxOutput('anthropic', 'model-a')).toBe(8_000);

    release();
    await background;
    expect(resolveCatalogMaxOutput('anthropic', 'model-a')).toBe(64_000);
  });

  it('subscribes once even when the resolver is installed repeatedly', async () => {
    const registry = new DefaultModelsRegistry({
      cacheFile,
      fetchImpl: vi.fn(async () => json(catalog(900_000, 64_000))),
    });
    await registry.loadCached();
    const subscribe = vi.spyOn(registry, 'onCatalogChanged');

    await installCatalogModelOutputLimits({ registry, getConfig: () => undefined });
    await installCatalogModelOutputLimits({ registry, getConfig: () => undefined });

    expect(subscribe).toHaveBeenCalledTimes(1);
  });
});
