import type { EventBus } from '@wrongstack/contracts/kernel';
import {
  CONTEXT_WINDOW_MODE_PINNED_META_KEY,
  type Config,
  type Logger,
  type ModelsRegistry,
  type Provider,
  type ProviderConfig,
  resolveContextWindowPolicy,
} from '@wrongstack/contracts/types';
import type { Context } from '@wrongstack/core/agent';
import type { AutoCompactionMiddleware } from '@wrongstack/core/execution';
import { refreshCatalogIfStale } from '@wrongstack/core/models';
import { toErrorMessage } from '@wrongstack/core/utils';
import { resolveProviderModelMetadata } from './model-catalog.js';

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
    try {
      const m = await resolveProviderModelMetadata(
        modelsRegistry,
        providerId,
        target.model,
        providerCfg ?? currentConfig.providers?.[providerId],
      );
      newMaxContext = positiveWindow(m?.capabilities?.maxContext) ?? newMaxContext;
    } catch {
      // best-effort: use provider capability
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
