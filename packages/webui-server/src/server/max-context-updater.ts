import type { EventBus } from '@wrongstack/contracts/kernel';
import type {
  Config,
  Logger,
  ModelsDevModel,
  ModelsRegistry,
  Provider,
  ProviderConfig,
} from '@wrongstack/contracts/types';
import {
  CONTEXT_WINDOW_MODE_PINNED_META_KEY,
  resolveContextWindowPolicy,
} from '@wrongstack/contracts/types';
import type { Context } from '@wrongstack/core/agent';
import type { AutoCompactionMiddleware } from '@wrongstack/core/execution';
import { refreshCatalogIfStale } from '@wrongstack/core/models';
import {
  priceCliffRouteForContext,
  resolvePriceCliffTokens,
  toErrorMessage,
  writePriceCliffMeta,
} from '@wrongstack/core/utils';
import { resolveProviderModelMetadata } from './model-catalog.js';

/**
 * Publish (or clear) the route's long-context price cliff on a session's meta.
 *
 * Both WebUI stamp points — service boot and a model switch — go through this
 * one function so they can never disagree about when the cap is cleared. Boot
 * is what makes the protection real for a tab that opens on a cliffed model and
 * is never switched: without a boot stamp the compaction ladder finds no cliff
 * meta and stays purely window-relative, filling a 1M window straight into the
 * 2x billed tier the cap exists to avoid.
 *
 * The key is stamped through `priceCliffRouteForContext` from the LIVE context —
 * the same derivation the ladder reads back with — so a cliff published for
 * another route is dropped rather than silently applied to this session.
 */
export function publishRoutePriceCliff(input: {
  meta: Record<string, unknown>;
  /** The catalog pricing already fetched for this route; no second registry walk. */
  catalogCost: ModelsDevModel['cost'] | undefined;
  /** The window the compaction ladder is using; <= 0 means "unknown", so clear. */
  maxContext: number;
  /** The live context the ladder will read the cliff back from. */
  routeCtx: { provider?: { id?: string }; model?: string };
  /** `context.priceCliff !== false`. False clears the cap entirely. */
  enabled: boolean;
  /**
   * False when the catalog read FAILED (threw, or no registry to read from).
   * Then the pricing is UNKNOWN, not absent, so the existing cap is preserved:
   * writing `null` would clear a cliff published from a good read and silently
   * disable the protection until the next switch or refresh. Preserving is safe
   * because the key is route-stamped — a cliff belonging to another
   * provider/model is dropped by the reader rather than mis-applied here.
   */
  costKnown: boolean;
}): void {
  const routeKey = priceCliffRouteForContext(input.routeCtx);
  if (!input.enabled || input.maxContext <= 0) {
    writePriceCliffMeta(input.meta, null, routeKey);
    return;
  }
  if (!input.costKnown) return;
  writePriceCliffMeta(
    input.meta,
    resolvePriceCliffTokens(input.catalogCost, input.maxContext),
    routeKey,
  );
}

/**
 * A context window only counts when it is a positive, finite token count —
 * the same rule as the CLI's `positiveNumber` in context-limit.ts. `0` or a
 * negative from a hand-edited `context.effectiveMaxContext` (the `/context
 * limit` writer rejects both) means "not set", so the chain falls through to
 * the provider window. The model-switch path used `??`, which kept the `0`:
 * boot fell through to the provider window, but the next switch wrote 0 into
 * the new provider's capabilities and turned auto-compaction off.
 */
export function positiveWindow(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

export interface MaxContextUpdaterDeps {
  /** Boot config — only `context.autoCompact` is read from it (as before). */
  config: Config;
  /** Live config reader; re-read on every resolution. */
  getConfig: () => Config;
  context: Context;
  modelsRegistry: ModelsRegistry;
  events: EventBus;
  logger: Logger;
  modelCapabilitiesRef: { current: unknown };
  autoCompactor: AutoCompactionMiddleware | undefined;
}

export type UpdateAutoCompactionMaxContext = (
  newProvider: Provider,
  providerId?: string,
  providerCfg?: ProviderConfig | undefined,
  /** The conversation whose window this is; the leader's context when omitted. */
  target?: Context | undefined,
) => Promise<void>;

/**
 * The WebUI server's context-window owner: resolves the active window from the
 * catalog on a model switch and pushes it to every consumer (provider
 * capabilities, the capability ref, auto-compaction, the window policy, the
 * `ctx.max_context` event).
 *
 * It also re-resolves the SAME target whenever the catalog changes — boot now
 * serves the cached catalog and refreshes it in the background, so without
 * this the window would keep the cached number until the next switch.
 */
export function createMaxContextUpdater(
  deps: MaxContextUpdaterDeps,
): UpdateAutoCompactionMaxContext {
  const { config, getConfig, context, modelsRegistry, events, logger, modelCapabilitiesRef } = deps;
  const { autoCompactor } = deps;

  // The target the window was last resolved for; a catalog change (background
  // or periodic refresh) re-resolves it locally without another fetch.
  let lastTarget:
    | { provider: Provider; providerId: string; cfg: ProviderConfig | undefined }
    | undefined;
  // Bumped per switch. A model switch fires this updater without awaiting it,
  // so an older switch's resolution can finish after a newer one (lookup depth
  // differs per path); only the newest target may publish its window.
  let generation = 0;

  // Newest resolution per conversation other than the leader (same rule as `generation`).
  const tabGenerations = new WeakMap<Context, number>();

  const apply = async (
    newProvider: Provider,
    providerId: string,
    providerCfg: ProviderConfig | undefined,
    gen: number,
    target: Context = context,
  ): Promise<void> => {
    // The leader owns the process-wide consumers (capability ref, the shared compactor's
    // fallback window). Another tab's window lands on that tab's context only: the compaction
    // threshold reads the context's own `effectiveMaxContext` first.
    const leader = target === context;
    const current = () => (leader ? generation : tabGenerations.get(target));
    const currentConfig = getConfig();
    let newMaxContext =
      positiveWindow(currentConfig.context?.effectiveMaxContext) ??
      newProvider.capabilities.maxContext;
    // The catalog's published pricing for THIS route, captured while the model
    // metadata is already in hand — the long-context price cliff is derived
    // from it below, so no second registry walk is needed.
    let catalogCost: ModelsDevModel['cost'];
    // "No published tier" and "could not read the tier" are different states:
    // only the first may clear the cap. A throw leaves pricing UNKNOWN, so the
    // helper preserves whatever the route had instead of silently disabling the
    // protection for the rest of the session.
    let catalogCostKnown = false;
    try {
      const m = await resolveProviderModelMetadata(
        modelsRegistry,
        providerId,
        target.model,
        providerCfg ?? currentConfig.providers?.[providerId],
      );
      newMaxContext = positiveWindow(m?.capabilities?.maxContext) ?? newMaxContext;
      catalogCost = m?.cost;
      catalogCostKnown = true;
    } catch {
      // best-effort: use provider capability, keep the existing cliff
    }
    if (gen !== current()) return;
    newProvider.capabilities.maxContext = newMaxContext;
    if (leader)
      modelCapabilitiesRef.current =
        newMaxContext > 0
          ? {
              maxContextTokens: newMaxContext,
              supportsTools: !!newProvider.capabilities.tools,
              supportsVision: !!newProvider.capabilities.vision,
              supportsReasoning: !!newProvider.capabilities.reasoning,
            }
          : undefined;
    if (newMaxContext > 0) {
      target.meta['effectiveMaxContext'] = newMaxContext;
      if (leader) {
        autoCompactor?.setMaxContext(newMaxContext);
        autoCompactor?.setEnabled(config.context?.autoCompact !== false);
      }
      // Window changed (model switch): re-resolve the default policy so it
      // stays scaled to the window (≥1M defaults to Deep, smaller back to
      // Balanced). A policy the user pinned for this session is left alone.
      if (target.meta[CONTEXT_WINDOW_MODE_PINNED_META_KEY] !== true) {
        const policy = resolveContextWindowPolicy(
          currentConfig.context ?? {},
          undefined,
          newMaxContext,
        );
        target.meta['contextWindowMode'] = policy.id;
        target.meta['contextWindowPolicy'] = policy;
      }
    } else {
      delete target.meta['effectiveMaxContext'];
      if (leader) autoCompactor?.setEnabled(false);
    }
    // Publish the route's long-context price cliff from the catalog pricing
    // already fetched above — no second registry walk. Cleared when the new
    // model publishes no step-up tier, the window is unknown, or the user
    // turned the protection off, so a switch off a cliffed model can never
    // leave a stale cap compacting the new route too early. A failed catalog
    // read is NOT "no tier": the existing cap is preserved.
    publishRoutePriceCliff({
      meta: target.meta,
      catalogCost,
      maxContext: newMaxContext,
      routeCtx: target,
      enabled: currentConfig.context?.priceCliff !== false,
      costKnown: catalogCostKnown,
    });
    events.emit('ctx.max_context', {
      sessionId: target.session.id,
      providerId: newProvider.id,
      modelId: target.model,
      maxContext: newMaxContext,
    });
  };

  modelsRegistry.onCatalogChanged?.(() => {
    const provider = lastTarget?.provider ?? context.provider;
    if (!provider) return;
    void apply(provider, lastTarget?.providerId ?? provider.id, lastTarget?.cfg, generation).catch(
      (err: unknown) => {
        logger.debug(`max-context re-resolve after catalog change failed: ${toErrorMessage(err)}`);
      },
    );
  });

  return async (newProvider, providerId = newProvider.id, providerCfg, target = context) => {
    const leader = target === context;
    let gen: number;
    if (leader) {
      lastTarget = { provider: newProvider, providerId, cfg: providerCfg };
      gen = ++generation;
    } else {
      gen = (tabGenerations.get(target) ?? 0) + 1;
      tabGenerations.set(target, gen);
    }
    // A catalog fetched minutes ago (boot's background refresh, the last
    // switch) is current — don't make every switch wait on models.dev.
    await refreshCatalogIfStale(modelsRegistry).catch((err) => {
      logger.warn(
        `models.dev refresh failed for ${providerId}/${target.model}: ${toErrorMessage(err)}; using cached catalog`,
      );
    });
    if (gen !== (leader ? generation : tabGenerations.get(target))) return;
    await apply(newProvider, providerId, providerCfg, gen, target);
  };
}
