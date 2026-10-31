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

import type { Config, ModelsRegistry, Tool } from '@wrongstack/contracts/types';
import type { ToolRegistry } from '@wrongstack/core/registry';
import { catalogProviderIdFor } from '@wrongstack/providers';
import {
  createFallbackManageTools,
  LEADER_EFFORT_SET_TOOL_NAME,
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
}

export function registerEngineManagementTools(deps: EngineManagementToolsDeps): string[] {
  const { modelsRegistry } = deps;
  const tools = createFallbackManageTools({
    getConfig: deps.getConfig,
    updateConfig: async (mutate) => {
      await deps.persist(mutate);
      const next = structuredClone(deps.getConfig()) as unknown as Record<string, unknown>;
      mutate(next);
      deps.applyConfig(next as unknown as Config);
    },
    switchProviderAndModel: async (providerId, modelId, context) => {
      const sessionId = context?.eventSessionId?.() || context?.session?.id || undefined;
      try {
        await deps.switchModel(providerId, modelId, sessionId);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    ...(modelsRegistry
      ? {
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
