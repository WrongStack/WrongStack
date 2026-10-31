/**
 * The leader's provider/model/fallback management tools for the standalone engine
 * (CLI parity: cli/wiring/management-tools.ts → `createFallbackManageTools`).
 *
 * The engine registered none of them, so a leader in the desktop could not change its model,
 * fallback chain, favorites or providers the way it can under `wstack`. Writes go through the
 * engine's serialized, encryption-preserving `updateGlobalConfig` and are applied to the live
 * config at once (the file watcher's layered reload follows). A model switch targets the
 * conversation whose leader called the tool, not the boot session.
 */

import type { EventBus } from '@wrongstack/contracts/kernel';
import type { Config, ModelsRegistry, Tool } from '@wrongstack/contracts/types';
import type { ToolRegistry } from '@wrongstack/core/registry';
import { toErrorMessage } from '@wrongstack/core/utils';
import { catalogProviderIdFor } from '@wrongstack/providers';
import {
  createFallbackManageTools,
  LEADER_EFFORT_SET_TOOL_NAME,
  type ManageToolCallerContext,
} from '@wrongstack/tools/management';

export interface EngineManagementToolsDeps {
  toolRegistry: Pick<ToolRegistry, 'registerDefault'>;
  getConfig: () => Config;
  /** Replace the live config (state + config store) after a persisted write. */
  applyConfig: (next: Config) => void;
  /** Serialized read → decrypt → mutate → encrypt → write of the profile config. */
  persist: (mutate: (config: Record<string, unknown>) => void) => Promise<void>;
  /** The live per-conversation model switch (`model.switch`). Throws on failure. */
  switchModel: (providerId: string, modelId: string, sessionId?: string) => Promise<void>;
  modelsRegistry?: ModelsRegistry | undefined;
  /**
   * The engine's event bus. Feeds `leader_tier_set`'s guards per conversation: the request size
   * (`ctx.pct`) and the turn count behind the dwell window (`iteration.started`, `index === 0`).
   */
  events?: Pick<EventBus, 'on'> | undefined;
  /** The provider and model a conversation runs (its tab may differ from the profile default). */
  sessionModel?:
    | ((sessionId?: string) => { provider: string; model: string } | undefined)
    | undefined;
}

/** Per-conversation inputs of the leader tier guards (CLI parity: one state per tab here). */
interface TierState {
  contextTokens: number;
  turns: number;
  currentTier: string | undefined;
  /** Turn count at this conversation's last tier switch; unset until it switches. */
  switchedAtTurn: number | undefined;
}

function callerSessionId(context: ManageToolCallerContext): string | undefined {
  return context?.eventSessionId?.() || context?.session?.id || undefined;
}

export function registerEngineManagementTools(deps: EngineManagementToolsDeps): string[] {
  const { modelsRegistry } = deps;
  const tierStates = new Map<string, TierState>();
  const tierState = (sessionId: string | undefined): TierState | undefined => {
    if (!sessionId) return undefined;
    let state = tierStates.get(sessionId);
    if (!state) {
      state = { contextTokens: 0, turns: 0, currentTier: undefined, switchedAtTurn: undefined };
      tierStates.set(sessionId, state);
    }
    return state;
  };
  deps.events?.on('ctx.pct', (event) => {
    const state = tierState(event.sessionId);
    if (state && typeof event.tokens === 'number' && event.tokens > 0) {
      state.contextTokens = event.tokens;
    }
  });
  // `index === 0` opens a turn: the dwell window is counted in turns, not iterations.
  deps.events?.on('iteration.started', (event) => {
    const state = event.index === 0 ? tierState(event.sessionId) : undefined;
    if (state) state.turns += 1;
  });
  const tools = createFallbackManageTools({
    getConfig: deps.getConfig,
    updateConfig: async (mutate) => {
      await deps.persist(mutate);
      const next = structuredClone(deps.getConfig()) as unknown as Record<string, unknown>;
      mutate(next);
      deps.applyConfig(next as unknown as Config);
    },
    switchProviderAndModel: async (providerId, modelId, context) => {
      try {
        await deps.switchModel(providerId, modelId, callerSessionId(context));
        return null;
      } catch (error) {
        return toErrorMessage(error);
      }
    },
    getCurrentTier: (context: ManageToolCallerContext) =>
      tierStates.get(callerSessionId(context) ?? '')?.currentTier,
    getContextTokens: (context: ManageToolCallerContext) => {
      const tokens = tierStates.get(callerSessionId(context) ?? '')?.contextTokens ?? 0;
      return tokens > 0 ? tokens : undefined;
    },
    // A conversation that never switched reads as "long ago" (undefined): the dwell guard
    // only holds a conversation back after its own switch.
    getTurnsSinceTierSwitch: (context: ManageToolCallerContext) => {
      const state = tierStates.get(callerSessionId(context) ?? '');
      return state?.switchedAtTurn === undefined ? undefined : state.turns - state.switchedAtTurn;
    },
    onTierSwitched: (tier: string, context: ManageToolCallerContext) => {
      const state = tierState(callerSessionId(context));
      if (!state) return;
      state.currentTier = tier;
      state.switchedAtTurn = state.turns;
    },
    ...(deps.sessionModel
      ? {
          getCurrentModel: (context: ManageToolCallerContext) =>
            deps.sessionModel?.(callerSessionId(context)),
        }
      : {}),
    ...(modelsRegistry
      ? {
          getModelEconomics: async (providerId: string, modelId: string) => {
            try {
              const catalogId = catalogProviderIdFor(
                providerId,
                deps.getConfig().providers?.[providerId]?.type,
              );
              const model = await modelsRegistry.getModel(catalogId, modelId);
              if (!model) return undefined;
              const cost = model.cost;
              return {
                ...(typeof cost?.input === 'number' ? { inputPerMTok: cost.input } : {}),
                ...(typeof cost?.output === 'number' ? { outputPerMTok: cost.output } : {}),
                ...(typeof cost?.cache_read === 'number'
                  ? { cacheReadPerMTok: cost.cache_read }
                  : {}),
                ...(typeof cost?.cache_write === 'number'
                  ? { cacheWritePerMTok: cost.cache_write }
                  : {}),
                ...(typeof model.capabilities?.maxContext === 'number' &&
                model.capabilities.maxContext > 0
                  ? { maxContext: model.capabilities.maxContext }
                  : {}),
              };
            } catch {
              // No pricing: the policy judges on its structural guards alone.
              return undefined;
            }
          },
          getReasoningConfig: async (providerId: string, modelId: string) => {
            const catalogId = catalogProviderIdFor(
              providerId,
              deps.getConfig().providers?.[providerId]?.type,
            );
            return (await modelsRegistry.getModel(catalogId, modelId))?.capabilities
              ?.reasoningConfig;
          },
        }
      : {}),
  }) as Tool[];
  // Registered after the canonical pass: `tools.disabledTools` is honoured here
  // (`ToolRegistry.disable()` ignores names that were not registered yet).
  // `leader_effort_set` is registered on its own (leader-effort-tool.ts).
  const disabled = new Set([
    ...(deps.getConfig().tools?.disabledTools ?? []),
    LEADER_EFFORT_SET_TOOL_NAME,
  ]);
  const registered: string[] = [];
  for (const tool of tools) {
    if (disabled.has(tool.name)) continue;
    deps.toolRegistry.registerDefault(tool as never);
    registered.push(tool.name);
  }
  return registered;
}
