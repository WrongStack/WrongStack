import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  Config,
  Logger,
  ModelsDevPayload,
  ModelsDevProvider,
} from '@wrongstack/contracts/types';
import {
  type DiscoveryOverlayOptions,
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

interface OverlayRegistry {
  mergeOverlay(payload: ModelsDevPayload, opts?: DiscoveryOverlayOptions): void;
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
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as DiscoverCache)
      : {};
  } catch {
    return {};
  }
}

function validCacheEntry(value: unknown): value is DiscoverCacheEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as { fetchedAt?: unknown; provider?: unknown };
  if (
    typeof entry.fetchedAt !== 'string' ||
    !Number.isFinite(Date.parse(entry.fetchedAt)) ||
    !entry.provider ||
    typeof entry.provider !== 'object'
  ) {
    return false;
  }
  const models = (entry.provider as { models?: unknown }).models;
  return !!models && typeof models === 'object' && !Array.isArray(models);
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
        ...(modelDiscoveryPath ? { modelDiscoveryPath } : {}),
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
        registry.mergeOverlay(merge.payload, merge.options);
        opts.logger?.info?.(
          `auto-discovered ${Object.keys(provider.models).length} models for "${id}" from ${baseUrl}`,
        );
        return;
      }

      const candidate = cache[cacheKey] ?? cache[previousCacheKey];
      const cached = validCacheEntry(candidate) ? candidate : undefined;
      if (candidate !== undefined && !cached) {
        delete cache[cacheKey];
        cacheDirty = true;
      }
      if (cached) {
        if (cacheKey !== previousCacheKey) {
          cache[cacheKey] = cached;
          cacheDirty = true;
        }
        if (pruneDiscoveryCache(cache, target)) cacheDirty = true;
        if (accountCatalog) cfg.models = Object.keys(cached.provider.models);
        const merge = discoveryOverlay(target, cached.provider, cached.fetchedAt);
        registry.mergeOverlay(merge.payload, merge.options);
        opts.logger?.warn?.(
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
          registry.mergeOverlay(merge.payload, merge.options);
        }
        opts.logger?.warn?.(
          `auto-discovery for "${id}" failed and no cache available (${failureReason}; catalog at ${baseUrl})`,
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
