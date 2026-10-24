import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Config, Logger, ModelsDevProvider } from '@wrongstack/contracts/types';
import type { DefaultModelsRegistry } from '@wrongstack/core/models';
import {
  discoverOpenAICompatibleModels,
  discoveryOverlay,
  pruneDiscoveryCache,
  resolveDiscoveryTargets,
} from '@wrongstack/providers';

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
    targets.map(async (target) => {
      const previousCacheKey = target.cacheKey;
      const {
        id,
        cfg,
        baseUrl,
        apiKey,
        modelDiscoveryPath,
        accountCatalog,
        copilotCatalog,
        modelsUrl,
        headers,
        prepareApiKey,
        inheritWireFamily,
      } = target;
      let failureReason = 'model catalog request failed';
      const provider = await discoverOpenAICompatibleModels(id, {
        baseUrl,
        apiKey,
        headers: { ...cfg.headers, ...headers },
        accountCatalog,
        copilotCatalog,
        modelsUrl,
        providerName: id,
        modelDiscoveryPath,
        inheritWireFamily,
        fetchImpl: opts.fetchImpl,
        prepareApiKey,
        onFailure: (reason) => {
          failureReason = reason;
        },
      });
      if (target.isCurrent && !target.isCurrent()) return;
      const { cacheKey } = target;
      if (provider) {
        if (accountCatalog) cfg.models = Object.keys(provider.models);
        const fetchedAt = new Date().toISOString();
        cache[cacheKey] = { fetchedAt, provider };
        pruneDiscoveryCache(cache, target);
        cacheDirty = true;
        const merge = discoveryOverlay(target, provider, fetchedAt);
        opts.registry.mergeOverlay(merge.payload, merge.options);
        opts.logger?.info(
          `auto-discovered ${Object.keys(provider.models).length} models for "${id}" from ${baseUrl}`,
        );
        return;
      }
      // Fetch failed — fall back to the last cached list, if any.
      const cached = cache[cacheKey] ?? cache[previousCacheKey];
      if (cached) {
        if (cacheKey !== previousCacheKey) {
          cache[cacheKey] = cached;
          cacheDirty = true;
        }
        if (pruneDiscoveryCache(cache, target)) cacheDirty = true;
        if (accountCatalog) cfg.models = Object.keys(cached.provider.models);
        const merge = discoveryOverlay(target, cached.provider, cached.fetchedAt);
        opts.registry.mergeOverlay(merge.payload, merge.options);
        opts.logger?.warn(
          `auto-discovery for "${id}" failed; using ${
            Object.keys(cached.provider.models).length
          } cached models from ${cached.fetchedAt} (${failureReason})`,
        );
      } else {
        if (accountCatalog) {
          cfg.models = [];
          const merge = discoveryOverlay(target, {
            id,
            name: id,
            npm: '@ai-sdk/openai-compatible',
            api: baseUrl,
            env: [],
            models: {},
          });
          opts.registry.mergeOverlay(merge.payload, merge.options);
        }
        opts.logger?.warn(
          `auto-discovery for "${id}" failed and no cache available (${failureReason}; catalog at ${baseUrl})`,
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
