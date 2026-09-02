/**
 * WrongProxy instant-apply for the standalone WebUI server.
 *
 * Mirrors the CLI-side wiring in `setupProviderRuntime` (packages/cli/src/
 * wiring/provider-runtime-setup.ts): subscribe to material proxy-config
 * changes via `createProxyInstantApply` and rebuild the LIVE provider when
 * the routing verdict for the active provider flips, so a Settings toggle
 * or probe deactivation takes effect immediately instead of on the next
 * incidental provider build.
 *
 * The rebuild sequence mirrors `applyModelSwitchCore` (routes.ts) — route
 * the cfg through `routeProviderCfgThroughProxy`, build via registry or
 * `makeProviderFromConfig`, overlay the live model's catalog capabilities
 * — minus the parts that don't apply when provider+model are unchanged
 * (no config persist, no session.start spam). The swap itself runs inside
 * `runModelTransition` with a superseded-check so a queued rebuild can
 * never overwrite a newer /model switch.
 *
 * In the CLI-hosted path this server module is NOT wired (the CLI's own
 * `setupProviderRuntime` instant-apply covers the shared agent context),
 * so there is exactly one rebuilder per process.
 */

import { createProxyInstantApply } from '@wrongstack/core/wiring/proxy-rewrite';
import type { Provider, ProviderConfig } from '@wrongstack/core/types';
import { makeProviderFromConfig, withCatalogCapabilities } from '@wrongstack/providers';
import { fanOutProviderRebuild } from './provider-fanout.js';
import { routeProviderCfgThroughProxy } from './proxy-runtime.js';
import type { WebuiDeps, WebuiMutableState } from './routes.js';

interface WebuiProxyApplyOptions {
  state: WebuiMutableState;
  deps: WebuiDeps;
  /** Mirrors `cb.updateAutoCompactionMaxContext` in start-webui.ts. */
  updateAutoCompactionMaxContext: (
    provider: Provider,
    providerId?: string,
    providerCfg?: ProviderConfig | undefined,
  ) => Promise<void>;
}

/**
 * Wire the standalone server's WrongProxy instant-apply. Returns the
 * dispose function for shutdown wiring. The helper itself lives in
 * `@wrongstack/core` so both hosts share the identical change-detection
 * semantics (effective-URL comparison, serialized rebuilds).
 */
export function setupWebuiProxyInstantApply(options: WebuiProxyApplyOptions): () => void {
  const { state, deps, updateAutoCompactionMaxContext } = options;

  const instantApply = createProxyInstantApply({
    // Prefer the LIVE provider id over the config's — mirrors the CLI
    // wiring; the context is the source of truth once the session boots.
    getActiveProviderId: () => deps.context.provider?.id ?? state.getConfig().provider ?? '',
    // Same raw-read rule as every other WebUI provider-build site:
    // savedCfg.baseUrl ?? top-level config.baseUrl.
    getRawBaseUrl: (providerId) =>
      state.getConfig().providers?.[providerId]?.baseUrl ?? state.getConfig().baseUrl,
    rebuildProvider: async (providerId) => {
      // The WHOLE sequence — config read, build, catalog overlay, swap —
      // runs inside the transition gate: reading `context.model` or the
      // config outside it would let a concurrent /model switch race this
      // rebuild (stale overlay / stale cfg), and the superseded guard
      // re-checks the live provider so a queued rebuild can never
      // overwrite a newer switch.
      await deps.context.runModelTransition(async () => {
        if (deps.context.provider?.id !== providerId) return; // superseded
        const cur = state.getConfig();
        const providerCfg: ProviderConfig = cur.providers?.[providerId] ?? { type: providerId };
        const routedCfg = routeProviderCfgThroughProxy(providerCfg, cur.baseUrl, providerId);
        const built = deps.providerRegistry.has(providerId)
          ? deps.providerRegistry.create({ ...routedCfg, type: providerId } as never)
          : makeProviderFromConfig(providerId, routedCfg);
        // Overlay the LIVE model's catalog facts — same rule as
        // applyModelSwitchCore: a freshly built provider only carries the
        // wire-family baseline, which would drop maxContext/maxOutput.
        const model = deps.context.model ?? cur.model ?? '';
        const newProv = deps.modelsRegistry
          ? await withCatalogCapabilities(deps.modelsRegistry, providerId, built, {
              ...routedCfg,
              type: providerId,
              model,
            })
          : built;
        const previousProvider = deps.context.provider;
        deps.context.provider = newProv;
        // The routing verdict is a project-wide fact. Swapping only the root
        // context left every tab opened before the toggle talking to the
        // upstream directly while the leader went through the proxy.
        fanOutProviderRebuild({
          sessionAgentIds: deps.sessionAgentIds,
          peekAgent: deps.peekAgent,
          previous: previousProvider,
          next: newProv,
          applied: deps.context,
        });
        // Best-effort capability refresh after the swap — same pattern as
        // the credential hot-reload watcher.
        void updateAutoCompactionMaxContext(newProv, providerId).catch(() => undefined);
      });
    },
    logger: deps.logger,
  });

  return () => instantApply.dispose();
}
