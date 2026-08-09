import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { DefaultModelsRegistry } from '@wrongstack/core/models';
import type { Config, Logger, ModelsDevProvider } from '@wrongstack/core/types';
import { discoverOpenAICompatibleModels, resolveDiscoveryTargets } from '@wrongstack/providers';

interface DiscoverCacheEntry {
  fetchedAt: string;
  provider: ModelsDevProvider;
}
type DiscoverCache = Record<string, DiscoverCacheEntry>;

async function readCache(file: string): Promise<DiscoverCache> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as DiscoverCache;
  } catch {
    return {};
  }
}

/**
 * Fetch model lists for every auto-discovery provider in the config and merge
 * them into the catalog. Best-effort end to end: a down server or missing key
 * falls back to the last cached list (any age — a local proxy being offline at
 * boot shouldn't wipe its models), and any failure is a logged no-op so boot
 * never breaks.
 *
 * Caches the most recent successful fetch per provider+baseUrl so the models
 * survive a restart while the server is briefly unavailable.
 */
export async function discoverAndMergeProviders(opts: {
  config: Config;
  registry: DefaultModelsRegistry;
  cacheDir: string;
  logger?: Logger | undefined;
  fetchImpl?: typeof fetch | undefined;
}): Promise<void> {
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
        opts.registry.mergeOverlay({ [id]: provider });
        opts.logger?.info(
          `auto-discovered ${Object.keys(provider.models).length} models for "${id}" from ${baseUrl}`,
        );
        return;
      }
      // Fetch failed — fall back to the last cached list, if any.
      const cached = cache[cacheKey];
      if (cached) {
        opts.registry.mergeOverlay({ [id]: cached.provider });
        opts.logger?.warn(
          `auto-discovery for "${id}" failed; using ${
            Object.keys(cached.provider.models).length
          } cached models from ${cached.fetchedAt}`,
        );
      } else {
        opts.logger?.warn(
          `auto-discovery for "${id}" failed and no cache available (server at ${baseUrl} unreachable?)`,
        );
      }
    }),
  );

  if (cacheDirty) {
    try {
      await fs.writeFile(cacheFile, JSON.stringify(cache), 'utf8');
    } catch {
      // best-effort cache write
    }
  }
}
