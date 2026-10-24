import type { ProviderConfig } from '@wrongstack/contracts/types';
import type { Context } from '@wrongstack/core/agent';
import { makeProviderFromConfig, withCatalogCapabilities } from '@wrongstack/providers';
import { patchConfig } from './boot.js';
import { loadSavedProviders } from './provider-config-io.js';
import { routeProviderCfgThroughProxy } from './proxy-runtime.js';
import type { WebuiCallbacks, WebuiDeps, WebuiMutableState } from './route-contracts.js';
import { broadcast } from './ws-utils.js';

/**
 * Session-context resolution and the live provider+model switch shared by the
 * route table (`buildRoutes`): provider handlers, model operations, and new
 * session creation all re-point a tab's Context through these.
 */

/**
 * Resolve the Context a session-scoped operation should act on. Each WebUI
 * tab owns its own Context (see backend-services' session agent registry);
 * `deps.context` is only the ROOT one, which is a different tab's state as
 * often as not once four sessions are live.
 */
export function createSessionContextResolver(deps: WebuiDeps): (sessionId?: string) => Context {
  return function sessionContext(sessionId?: string): Context {
    if (!sessionId) return deps.context;
    return deps.getAgent?.(sessionId)?.ctx ?? deps.context;
  };
}

// Apply a provider+model switch to the live session: sync config, rebuild the
// provider, refresh the auto-compaction denominator, persist, and broadcast a
// fresh session.start. Shared by the `model.switch` handler and the
// adopt-on-first-add path. Throws on provider-construction failure.
export function createApplyModelSwitch(
  state: WebuiMutableState,
  deps: WebuiDeps,
  cb: WebuiCallbacks,
  sessionContext: (sessionId?: string) => Context,
): (newProvider: string, newModel: string, sessionId?: string) => Promise<void> {
  return applyModelSwitchCore;

  async function applyModelSwitchCore(
    newProvider: string,
    newModel: string,
    sessionId?: string,
  ): Promise<void> {
    // Target the requesting tab's context. Without a sessionId (the
    // adopt-first-provider boot path) this is still the root context.
    const targetCtx = sessionContext(sessionId);
    await targetCtx.runModelTransition(async () => {
      // provider.add persists the record directly to the profile file
      // (providerStore.save), while the credential watcher's state.setConfig
      // refresh is debounced — the adopt-on-first-add path can read memory
      // before that refresh lands and then persist the boot-stale (empty)
      // providers map, clobbering the just-added record (the fresh-home
      // setup-screen regression). Hydrate from the profile file first so the
      // switch's persist cannot lose it.
      if (!state.getConfig().providers?.[newProvider]) {
        try {
          const fresh = await loadSavedProviders(deps.profileConfigPath, deps.vault);
          if (fresh[newProvider]) {
            state.setConfig(patchConfig(state.getConfig(), { providers: fresh }));
            deps.configStore.update({ providers: fresh });
          }
        } catch (err) {
          deps.logger.warn(`model.switch provider hydration failed: ${String(err)}`);
        }
      }
      const cur = state.getConfig();
      const newCfg = patchConfig(cur, { provider: newProvider, model: newModel });
      const providerCfg: ProviderConfig = newCfg.providers?.[newProvider] ?? { type: newProvider };
      const factoryType = providerCfg.type ?? newProvider;
      // WrongProxy / WrongTrace: rewrite the switched provider's base URL
      // through the shared helper so the live WebUI session honors the
      // proxy toggle, same as the CLI's `/model` switch path. `newCfg.baseUrl`
      // is the fallback when the saved cfg carries no explicit baseUrl.
      const routedCfg = routeProviderCfgThroughProxy(providerCfg, newCfg.baseUrl, newProvider);
      const built = deps.providerRegistry.has(factoryType)
        ? deps.providerRegistry.create({ ...routedCfg, type: newProvider } as never, factoryType)
        : makeProviderFromConfig(newProvider, { ...routedCfg, type: factoryType });
      // Overlay the target model's catalog facts. A freshly constructed provider
      // only has the wire-family baseline, so without this the session keeps the
      // previous model's context window and loses `maxOutput` entirely.
      const newProv = deps.modelsRegistry
        ? await withCatalogCapabilities(deps.modelsRegistry, newProvider, built, {
            ...routedCfg,
            type: newProvider,
            model: newModel,
          })
        : built;
      // Persist only after the target provider has been constructed. A failed
      // build must leave both the live session and durable selection untouched.
      await cb.updateGlobalConfig((config) => {
        config.provider = newProvider;
        config.model = newModel;
      }, 'model.switch');

      // The global config keeps tracking the most recent choice so it is the
      // default a NEW tab starts from and survives a restart — but the LIVE
      // swap lands only on the session that asked for it.
      state.setConfig(newCfg);
      deps.configStore.update({ provider: newProvider, model: newModel });
      targetCtx.model = newModel;
      targetCtx.provider = newProv;
      // Capability refresh is best-effort after the atomic live swap. It must
      // never sit on the acknowledgement boundary: refresh() may make a
      // network request to models.dev, while the selected provider/model is
      // already safe to use for the next turn. Keep the modal's result and the
      // session re-announce on the fast path; apply revised context metadata
      // when the background refresh completes.
      // Pass the POST-rewrite routedCfg (the same config the provider was built
      // from) so maxContext resolution sees the effective proxy-target URL.
      void cb.updateAutoCompactionMaxContext(newProv, newProvider, routedCfg).catch((error) => {
        deps.logger.warn(`model.switch capability refresh failed: ${String(error)}`);
      });

      broadcast(state.getClients(), {
        type: 'session.start',
        payload: await cb.sessionStartPayload(
          sessionId ? { sessionId, model: newModel, provider: newProvider } : {},
        ),
      });
    });
  }
}
