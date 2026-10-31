/**
 * `leader_effort_set` for the standalone engine (CLI parity: cli/wiring/management-tools.ts).
 *
 * The engine already applies the override (core model-runtime reads it from the conversation's
 * meta), restores it on resume, forwards `leader.effort_changed` to clients, and the desktop
 * shows it — but never registered the tool, so a leader there could not raise or lower its own
 * effort. Session-only: the tool writes the conversation's meta and journal, never config.
 */

import type { EventBus } from '@wrongstack/contracts/kernel';
import type { Config, ModelsRegistry } from '@wrongstack/contracts/types';
import type { ToolRegistry } from '@wrongstack/core/registry';
import { catalogProviderIdFor } from '@wrongstack/providers';
import {
  createLeaderEffortSetTool,
  LEADER_EFFORT_SET_TOOL_NAME,
} from '@wrongstack/tools/management';

export function registerLeaderEffortTool(deps: {
  toolRegistry: Pick<ToolRegistry, 'registerDefault'>;
  /** Live config: the project effort the override is compared against. */
  getConfig: () => Config;
  modelsRegistry?: ModelsRegistry | undefined;
  events: Pick<EventBus, 'emit'>;
}): void {
  // Registered after the canonical pass, so `tools.disabledTools` must be honoured here
  // (`ToolRegistry.disable()` ignores names that were not registered yet).
  if ((deps.getConfig().tools?.disabledTools ?? []).includes(LEADER_EFFORT_SET_TOOL_NAME)) return;
  const { modelsRegistry } = deps;
  deps.toolRegistry.registerDefault(
    createLeaderEffortSetTool({
      getConfig: deps.getConfig,
      // The effort tool never writes config; the shared option bag requires the hook.
      updateConfig: async () => {
        throw new Error('leader_effort_set does not change configuration');
      },
      onEffortChanged: (change) => deps.events.emit('leader.effort_changed', change),
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
    }) as never,
  );
}
