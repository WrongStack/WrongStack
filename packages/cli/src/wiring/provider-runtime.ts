import type { ProviderRegistry } from '@wrongstack/core/registry';
import type { Config, Provider, ProviderConfig } from '@wrongstack/core/types';
import { makeProviderFromConfig } from '@wrongstack/providers';
import { getProxyConfig, rewriteBaseUrl, shouldRewriteFor } from '@wrongstack/core/wiring/proxy-rewrite';

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
): ResolvedProviderCfg {
  const savedCfg = config.providers?.[providerId];
  // Fall back to the top-level config's apiKey/baseUrl on a per-key basis
  // so a saved cfg that omits one still inherits from the parent.
  const rawBaseUrl = savedCfg?.baseUrl ?? config.baseUrl;
  // When the WrongProxy/WrongTrace toggle is on and the daemon is reachable,
  // rewrite `rawBaseUrl` through the proxy (`http://localhost:8000/proxy/<host><path>`).
  // Excluded providers (e.g. openai-codex) flow through unchanged — the
  // rewriter itself is a no-op for them.
  const baseUrl =
    rawBaseUrl && shouldRewriteFor(providerId)
      ? rewriteBaseUrl(rawBaseUrl, currentProxyBaseUrl())
      : rawBaseUrl;
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
): ResolvedProviderCfg {
  return resolveProviderCfg(config, providerId);
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
  },
  providerId: string,
): Provider {
  const { cfg, factoryType } = resolveProviderCfg(args.config, providerId);
  const useRegistry =
    !!args.config.features.modelsRegistry && args.providerRegistry.has(factoryType);
  return useRegistry
    ? args.providerRegistry.create(cfg, factoryType)
    : makeProviderFromConfig(
        providerId,
        factoryType === 'ai-gateway' ? { ...cfg, type: factoryType } : cfg,
      );
}
