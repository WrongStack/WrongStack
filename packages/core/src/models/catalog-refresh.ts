import type { Logger } from '@wrongstack/contracts/types/logger';
import type { ModelsRegistry } from '@wrongstack/contracts/types/models-registry';
import { toErrorMessage } from '../utils/error.js';

/**
 * A catalog fetched this recently is treated as current: a model switch or a
 * model-picker open skips the network instead of re-downloading models.dev.
 */
export const RECENT_CATALOG_REFRESH_SECONDS = 10 * 60;

/** How often a long-lived process re-checks the catalog in the background. */
export const BACKGROUND_CATALOG_REFRESH_INTERVAL_MS = 30 * 60 * 1000;

export type CatalogRefreshOutcome = 'refreshed' | 'recent';

/**
 * Refresh the catalog unless the last successful fetch is younger than
 * `maxAgeSeconds`. Throws when the network refresh itself fails, so callers
 * keep their own "using cached catalog" diagnostics.
 */
export async function refreshCatalogIfStale(
  registry: ModelsRegistry,
  opts: { maxAgeSeconds?: number | undefined } = {},
): Promise<CatalogRefreshOutcome> {
  const maxAgeSeconds = opts.maxAgeSeconds ?? RECENT_CATALOG_REFRESH_SECONDS;
  if (maxAgeSeconds > 0 && typeof registry.ageSeconds === 'function') {
    const age = await registry.ageSeconds();
    if (Number.isFinite(age) && age >= 0 && age < maxAgeSeconds) return 'recent';
  }
  await registry.refresh();
  return 'refreshed';
}

export interface CatalogStartupOptions {
  registry: ModelsRegistry;
  logger?: Pick<Logger, 'info' | 'warn' | 'debug'> | undefined;
  /**
   * Short-lived processes (single-shot prompts) cannot outlive a background
   * fetch, so a stale cache is refreshed in the foreground there.
   */
  shortLived?: boolean | undefined;
  /** Re-check interval for long-lived processes; `0` disables the timer. */
  intervalMs?: number | undefined;
}

export interface CatalogStartupResult {
  /** How the catalog became available before boot continued. */
  mode: 'cache+background' | 'foreground';
  /** Settles when the startup refresh (foreground or background) finishes. */
  settled: Promise<void>;
  /** Stop the periodic refresh timer (no-op when none was started). */
  stop: () => void;
}

/**
 * Boot-time catalog policy shared by every surface:
 *
 *  - usable cache on disk → serve it immediately and refresh in the
 *    background (derived caches follow via `onCatalogChanged` /
 *    `catalogGeneration`), then keep re-checking on an unref'd timer;
 *  - no usable cache, a short-lived process, or a registry without
 *    `loadCached` → the old blocking refresh, falling back to whatever
 *    `load()` can serve when the network is down.
 *
 * Never throws: a failed refresh is logged and the cached catalog stays.
 */
export async function startCatalog(opts: CatalogStartupOptions): Promise<CatalogStartupResult> {
  const { registry, logger } = opts;
  const refreshLogged = async (reason: string): Promise<void> => {
    try {
      const outcome = await refreshCatalogIfStale(registry);
      if (outcome === 'refreshed') logger?.info(`models.dev catalog refreshed (${reason})`);
    } catch (err) {
      logger?.warn(`models.dev refresh failed (${toErrorMessage(err)}); using cached catalog`);
    }
  };

  const hasCache =
    typeof registry.loadCached === 'function'
      ? await registry.loadCached().catch(() => false)
      : false;

  if (!hasCache || opts.shortLived) {
    await refreshLogged('startup');
    return { mode: 'foreground', settled: Promise.resolve(), stop: () => {} };
  }

  const settled = refreshLogged('background');
  const intervalMs = opts.intervalMs ?? BACKGROUND_CATALOG_REFRESH_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | undefined;
  if (intervalMs > 0) {
    timer = setInterval(() => {
      void refreshLogged('periodic');
    }, intervalMs);
    timer.unref?.();
  }
  return {
    mode: 'cache+background',
    settled,
    stop: () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
