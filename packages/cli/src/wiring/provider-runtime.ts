import type { ProviderRegistry } from '@wrongstack/core/registry';
import type { Config, Provider, ProviderConfig } from '@wrongstack/core/types';
import { makeProviderFromConfig } from '@wrongstack/providers';
import {
  getProxyConfig,
  isProxyEligible,
  rewriteBaseUrl,
  sanitizeUrlForLog,
  shouldRewriteFor,
} from '@wrongstack/core/wiring/proxy-rewrite';

/**
 * Resolve the user-visible providerId into a runtime cfg + a factory type
 * for catalog lookups. Single source of truth for how a saved-config
 * provider (with an explicit `type` and/or `family`) maps onto the wire
 * protocol + the user's chosen id.
 *
 * Bug-fix history: previously this collapsed `savedCfg.type` into the
 * returned `resolvedProviderId`, so any call to `buildProviderForId('minimax-coding-plan')`
 * (where the saved config has `type: 'anthropic'`) produced a Provider
 * with `id === 'anthropic'` instead of `'minimax-coding-plan'`. After any
 * `switchProviderAndModel` / fallback / session-resume call, `ctx.provider.id`
 * stopped matching the user's chosen provider id — exactly the drift
 * reported in issue #16.
 *
 * The fix matches the startup path in `wiring/provider.ts`: keep
 * `cfg.type === providerId` so the resulting Provider's `id` is the
 * user's chosen id. Catalog resolution (factory lookup, maxContext
 * catalog lookup) separately resolves the alias via the saved config's
 * `type` or `family`:
 *   - providerRegistry.has(...) is keyed by `factoryType` (the wire family).
 *   - resolveRuntimeMaxContext(...) resolves the alias internally — see
 *     `packages/cli/src/context-limit.ts:100-106`.
 *
 * We pass `providerId` (the user-visible id) to both, and let them resolve.
 */
export interface ResolvedProviderCfg {
  /**
   * `cfg` passed to either `providerRegistry.create(cfg)` or
   * `makeProviderFromConfig(id, cfg)`. `cfg.type === providerId` so the
   * resulting Provider's `id` is the user's chosen id.
   */
  cfg: ProviderConfig;
  /**
   * Factory type used for the `providerRegistry.has(...)` lookup. Equal
   * to `savedCfg.type ?? providerId`. For a saved-config alias like
   * `minimax-coding-plan` with `type: 'anthropic'`, this is `'anthropic'`
   * so the catalog factory lookup succeeds; for a plain catalog entry,
   * this equals `providerId`.
   */
  factoryType: string;
}

export function resolveProviderCfg(
  config: Pick<Config, 'providers' | 'apiKey' | 'baseUrl'>,
  providerId: string,
  opts?: {
    /**
     * Log the rewrite decision for this provider build. Structural
     * (info only) so hosts can pass core's Logger, a child logger, or a
     * test stub. Applied rewrites log at info (routing provenance); skips
     * log at debug-level verbosity via the same `info` channel to keep
     * the interface minimal — wrongstack.log is the primary consumer.
     */
    logger?: { info(message: string): void } | undefined;
  },
): ResolvedProviderCfg {
  const savedCfg = config.providers?.[providerId];
  // Fall back to the top-level config's apiKey/baseUrl on a per-key basis
  // so a saved cfg that omits one still inherits from the parent.
  const rawBaseUrl = savedCfg?.baseUrl ?? config.baseUrl;
  // When the WrongProxy/WrongTrace toggle is on and the daemon is reachable,
  // rewrite `rawBaseUrl` through the proxy (`http://localhost:3444/proxy/<host><path>`).
  // Excluded providers (e.g. openai-codex) flow through unchanged — the
  // rewriter itself is a no-op for them.
  let rewriteReason = 'no-base-url';
  let baseUrl = rawBaseUrl;
  if (rawBaseUrl && shouldRewriteFor(providerId)) {
    const rewritten = rewriteBaseUrl(rawBaseUrl, currentProxyBaseUrl());
    // rewriteBaseUrl is a permissive passthrough: it returns the input
    // unchanged for ineligible shapes. Distinguish "applied" from each
    // distinct skip so the log answers WHY traffic is (not) proxied.
    if (rewritten !== rawBaseUrl) {
      rewriteReason = 'applied';
      baseUrl = rewritten;
    } else {
      rewriteReason = passthroughReason(rawBaseUrl);
    }
  } else if (rawBaseUrl) {
    // shouldRewriteFor() === false here — explain which gate blocked it.
    rewriteReason = proxySkipReason(providerId);
  }
  // NOTE: sanitizeUrlForLog returns '' (never nullish) for missing input,
  // so the sentinel must be `||`, not `??`.
  opts?.logger?.info(
    `WrongProxy rewrite ${rewriteReason} for provider '${providerId}': ${sanitizeUrlForLog(rawBaseUrl) || '<none>'} -> ${sanitizeUrlForLog(baseUrl) || '<none>'}`,
  );
  const cfg: ProviderConfig = {
    ...savedCfg,
    apiKey: savedCfg?.apiKey ?? config.apiKey,
    baseUrl,
    type: providerId,
  };
  const factoryType = savedCfg?.type ?? providerId;
  return { cfg, factoryType };
}

/**
 * Explain a `rewriteBaseUrl` passthrough (input returned unchanged while
 * the proxy gate allowed the rewrite). Distinct tokens, not one collapsed
 * label: each names a different operator action (or non-action).
 */
function passthroughReason(rawBaseUrl: string): string {
  if (!rawBaseUrl.includes('://')) return 'no-scheme';
  const proxyRoot = currentProxyBaseUrl().replace(/\/+$/, '');
  if (proxyRoot && rawBaseUrl.startsWith(`${proxyRoot}/proxy/`)) {
    return 'already-rewritten';
  }
  try {
    const parsed = new URL(rawBaseUrl);
    const host = parsed.hostname;
    const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
    if (isLoopback && parsed.port !== '') return 'loopback';
  } catch {
    // Unparseable — the generic token below is the honest claim.
  }
  return 'ineligible';
}

/**
 * Explain a `shouldRewriteFor() === false` verdict for the log line. The
 * singleton's three gates in precedence order: toggle off, no URL
 * configured, daemon not active (probe failed). Provider-level exclusion
 * (openai-codex) is checked last — it only matters when everything else
 * would have allowed the rewrite.
 */
function proxySkipReason(providerId: string): string {
  const cfg = getProxyConfig();
  if (!cfg.enabled) return 'disabled';
  if (!cfg.url) return 'no-proxy-url';
  if (!cfg.active) return 'inactive';
  if (!isProxyEligible(providerId)) return 'excluded';
  return 'unknown';
}

/**
 * Read the current proxy URL. Indirected through `proxy-rewrite` so the
 * test-only reset (`__resetProxyConfigForTests`) is the single switch
 * that resets both modules' view of state.
 */
function currentProxyBaseUrl(): string {
  return getProxyConfig().url;
}

/**
 * Shared proxy-aware provider-config resolver.
 *
 * Three sites in this monorepo merge a saved provider config with the
 * top-level Config and hand the result to a provider factory:
 *
 *   1. `packages/cli/src/wiring/provider-runtime.ts` `resolveProviderCfg()`
 *      — used by `/model`, the fallback extension, and any other runtime
 *        path that rebuilds a Provider from a saved-config alias.
 *   2. `packages/cli/src/wiring/provider.ts` `setupProvider()` — the
 *      boot-time setup path for the active session provider.
 *   3. `packages/runtime/src/fleet/light-subagent-factory.ts` `buildProvider()`
 *      — subagent provider construction for SDD runs.
 *
 * Each of those had to apply the same proxy rewrite. The duplication
 * drifted: `provider.ts:154` was force-setting `type: config.provider`
 * before the `factoryType` read at line 158, silently destroying any
 * saved-alias `type` field (e.g. `minimax-coding-plan` mapped to
 * `type: 'anthropic'`). The drift was caught by Chimera review; this
 * helper is the single source of truth that prevents it from recurring.
 *
 * Inputs are intentionally `Pick<Config, ...>` (not the full Config) so
 * this helper stays free of disk I/O and can be called from any layer.
 */
export function resolveProviderCfgWithProxy(
  config: Pick<Config, 'providers' | 'apiKey' | 'baseUrl'>,
  providerId: string,
  opts?: { logger?: { info(message: string): void } | undefined },
): ResolvedProviderCfg {
  return resolveProviderCfg(config, providerId, opts);
}

/**
 * Construct a credential-resolved Provider for a provider id, WITHOUT
 * persisting anything. Shared by the `/model` switch and the fallback
 * extension. The returned Provider's `id` is always the user-visible
 * `providerId`, regardless of whether the saved config has an explicit
 * `type` (OAuth / subscription / saved-config alias) or not (plain
 * catalog entry).
 */
export function buildProviderForId(
  args: {
    config: Pick<Config, 'providers' | 'apiKey' | 'baseUrl' | 'features'>;
    providerRegistry: ProviderRegistry;
    /** Optional rewrite-decision logger (see resolveProviderCfg). */
    logger?: { info(message: string): void } | undefined;
  },
  providerId: string,
): Provider {
  const { cfg, factoryType } = resolveProviderCfg(args.config, providerId, {
    logger: args.logger,
  });
  const useRegistry =
    !!args.config.features.modelsRegistry && args.providerRegistry.has(factoryType);
  return useRegistry
    ? args.providerRegistry.create(cfg, factoryType)
    : makeProviderFromConfig(
        providerId,
        factoryType === 'ai-gateway' ? { ...cfg, type: factoryType } : cfg,
      );
}
