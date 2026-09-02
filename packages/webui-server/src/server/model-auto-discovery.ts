import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Config, Logger, ModelsDevPayload, ModelsDevProvider } from '@wrongstack/core/types';
import { discoverOpenAICompatibleModels, resolveDiscoveryTargets } from '@wrongstack/providers';

interface DiscoverCacheEntry {
  fetchedAt: string;
  provider: ModelsDevProvider;
}

type DiscoverCache = Record<string, DiscoverCacheEntry>;

interface OverlayRegistry {
  mergeOverlay(payload: ModelsDevPayload): void;
}

function isOverlayRegistry(value: unknown): value is OverlayRegistry {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as OverlayRegistry).mergeOverlay === 'function'
  );
}

async function readCache(file: string): Promise<DiscoverCache> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as DiscoverCache;
  } catch {
    return {};
  }
}

export async function discoverAndMergeWebuiProviders(opts: {
  config: Config;
  registry: unknown;
  cacheDir: string;
  logger?: Pick<Logger, 'debug' | 'info' | 'warn'> | undefined;
  fetchImpl?: typeof fetch | undefined;
}): Promise<void> {
  const registry = opts.registry;
  if (!isOverlayRegistry(registry)) return;
  const targets = resolveDiscoveryTargets(opts.config);
  if (targets.length === 0) return;

  const cacheFile = path.join(opts.cacheDir, 'discovered-models-cache.json');
  const cache = await readCache(cacheFile);
  let cacheDirty = false;

  await Promise.all(
    targets.map(async ({ id, cfg, baseUrl, apiKey, cacheKey }) => {
      const provider = await discoverOpenAICompatibleModels(id, {
        baseUrl,
        apiKey,
        headers: cfg.headers,
        providerName: id,
        fetchImpl: opts.fetchImpl,
      });
      if (provider) {
        cache[cacheKey] = { fetchedAt: new Date().toISOString(), provider };
        cacheDirty = true;
        registry.mergeOverlay({ [id]: provider });
        opts.logger?.info?.(
          `auto-discovered ${Object.keys(provider.models).length} models for "${id}" from ${baseUrl}`,
        );
        return;
      }

      const cached = cache[cacheKey];
      if (cached) {
        registry.mergeOverlay({ [id]: cached.provider });
        opts.logger?.warn?.(
          `auto-discovery for "${id}" failed; using ${
            Object.keys(cached.provider.models).length
          } cached models from ${cached.fetchedAt}`,
        );
      } else {
        opts.logger?.warn?.(
          `auto-discovery for "${id}" failed and no cache available (server at ${baseUrl} unreachable?)`,
        );
      }
    }),
  );

  if (cacheDirty) {
    try {
      await fs.mkdir(path.dirname(cacheFile), { recursive: true });
      await fs.writeFile(cacheFile, JSON.stringify(cache), 'utf8');
    } catch {
      opts.logger?.debug?.('provider auto-discovery cache write failed');
    }
  }
}
