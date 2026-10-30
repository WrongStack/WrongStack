/**
 * Model fallback for the standalone engine's conversation agents.
 *
 * The CLI registers `createFallbackModelExtension` on its agent at boot
 * (packages/cli/src/wiring/provider-runtime-setup.ts). The standalone WebUI
 * engine — what `startWebUI` and so the desktop app run — never did, so a
 * configured `fallbackModels` chain or fallback profile never engaged there:
 * a retryable primary failure just ended the turn.
 *
 * Every conversation agent (the template/leader and each per-tab agent) gets
 * its OWN extension instance: the extension keeps per-instance state (dirty
 * flag, primary cooldown ladder, last working fallback), and tabs fail over
 * independently.
 */

import { type Container, type EventBus, TOKENS } from '@wrongstack/contracts/kernel';
import type {
  Config,
  Logger,
  ModelsRegistry,
  Provider,
  ProviderConfig,
} from '@wrongstack/contracts/types';
import { type Agent, type Context, createFallbackModelExtension } from '@wrongstack/core/agent';
import type { ProviderRegistry } from '@wrongstack/core/registry';
import { makeProviderFromConfig, withCatalogCapabilities } from '@wrongstack/providers';
import { createFallbackGate } from '@wrongstack/runtime';
import { routeProviderCfgThroughProxy } from './proxy-runtime.js';

/** Same countdown the CLI uses; `config.fallbackGateSeconds` overrides it. */
export const CONVERSATION_FALLBACK_GATE_SECONDS = 7;

/**
 * Context meta key holding the provider/model THIS conversation chose.
 *
 * Every model switch also rewrites the live config's global selection (so a
 * new tab and a restart start from the latest pick), which makes the config a
 * wrong answer to "what is this tab's primary?" once two tabs disagree. And
 * `ctx.provider` / `ctx.model` cannot answer it either: the fallback extension
 * itself moves them to the fallback model.
 */
export const CONVERSATION_PRIMARY_META_KEY = 'fallbackPrimaryTarget';

export interface ConversationPrimary {
  providerId: string;
  model: string;
}

/** Record the provider/model a conversation's user chose (called on every model switch). */
export function recordConversationPrimary(
  ctx: Pick<Context, 'meta'>,
  providerId: string,
  model: string,
): void {
  // Defensive: a host-supplied context double may carry no meta bag.
  if (!ctx.meta) return;
  ctx.meta[CONVERSATION_PRIMARY_META_KEY] = { providerId, model } satisfies ConversationPrimary;
}

/** The conversation's recorded primary, or undefined when it never switched. */
export function readConversationPrimary(
  meta: Record<string, unknown> | undefined,
): ConversationPrimary | undefined {
  const value = meta?.[CONVERSATION_PRIMARY_META_KEY] as Partial<ConversationPrimary> | undefined;
  if (!value || typeof value !== 'object') return undefined;
  if (typeof value.providerId !== 'string' || !value.providerId) return undefined;
  if (typeof value.model !== 'string' || !value.model) return undefined;
  return { providerId: value.providerId, model: value.model };
}

export interface BuildConversationProviderDeps {
  providerRegistry: ProviderRegistry;
  modelsRegistry?: ModelsRegistry | undefined;
}

/**
 * Build the provider a conversation runs `providerId`/`modelId` on, from the
 * given config: its saved provider entry, routed through WrongProxy, with the
 * model's catalog capabilities (context window, max output) overlaid.
 *
 * Pure construction — persists nothing and mutates no context. Shared by the
 * live model switch and the fallback chain's hops so both build identically.
 */
export async function buildConversationProvider(
  deps: BuildConversationProviderDeps,
  config: Config,
  providerId: string,
  modelId: string,
): Promise<{ provider: Provider; routedCfg: ProviderConfig }> {
  const providerCfg: ProviderConfig = config.providers?.[providerId] ?? { type: providerId };
  const factoryType = providerCfg.type ?? providerId;
  // WrongProxy / WrongTrace: rewrite the provider's base URL through the
  // shared helper so the live session honors the proxy toggle. The config's
  // top-level `baseUrl` is the fallback when the saved cfg carries none.
  const routedCfg = routeProviderCfgThroughProxy(providerCfg, config.baseUrl, providerId);
  const built = deps.providerRegistry.has(factoryType)
    ? deps.providerRegistry.create({ ...routedCfg, type: providerId } as never, factoryType)
    : makeProviderFromConfig(providerId, { ...routedCfg, type: factoryType });
  // A freshly constructed provider only has the wire-family baseline, so
  // without the catalog overlay it keeps the previous model's context window
  // and loses `maxOutput` entirely.
  const provider = deps.modelsRegistry
    ? await withCatalogCapabilities(deps.modelsRegistry, providerId, built, {
        ...routedCfg,
        type: routedCfg.type ?? providerId,
        model: modelId,
      })
    : built;
  return { provider, routedCfg };
}

export interface ConversationFallbackDeps extends BuildConversationProviderDeps {
  /** The host's LIVE config (re-read on every use). */
  getConfig: () => Config;
  container: Container;
  events: EventBus;
  logger?: Logger | undefined;
  /**
   * Called after a hop or a primary restore moved the agent to another model, with that
   * model. The host refreshes what depends on the model (context window, auto-compaction).
   */
  onModelSwitch?: ((providerId: string, modelId: string) => Promise<void>) | undefined;
}

/**
 * Register a fresh `fallback-model` extension on one conversation agent.
 * No-op when the agent already has one.
 */
export function installConversationFallback(agent: Agent, deps: ConversationFallbackDeps): void {
  if (agent.extensions.has('fallback-model')) return;
  agent.extensions.register(
    createFallbackModelExtension({
      getConfig: deps.getConfig,
      fallbackProfileManager: deps.container.safeResolve(TOKENS.FallbackProfileManager),
      statusTracker: deps.container.safeResolve(TOKENS.ProviderModelStatusTracker),
      // This conversation's own pick; the config primary when it never switched.
      getPrimaryTarget: () => readConversationPrimary(agent.ctx.meta),
      // Each hop needs its own model's capabilities, not the ones the
      // conversation started with. Never persists and never touches a context.
      buildProvider: async (providerId, modelId) => {
        const config = deps.getConfig();
        const model =
          modelId ??
          (config.provider === providerId ? config.model : config.providers?.[providerId]?.model);
        return (await buildConversationProvider(deps, config, providerId, model ?? '')).provider;
      },
      events: deps.events,
      ...(deps.onModelSwitch ? { onModelSwitch: deps.onModelSwitch } : {}),
      ...(deps.logger ? { logger: deps.logger } : {}),
      fallbackGate: createFallbackGate(deps.events),
      fallbackGateSeconds: CONVERSATION_FALLBACK_GATE_SECONDS,
    }),
  );
}
