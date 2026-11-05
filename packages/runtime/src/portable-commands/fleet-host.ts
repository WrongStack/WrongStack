import { AgentError } from '@wrongstack/contracts/types';
import {
  areSubagentsAllowedForSession,
  type Director,
  FLEET_ROSTER,
} from '@wrongstack/coordination';
import type { FleetCommandHost, SpawnCommandOptions } from './host.js';

/** The part of a fleet host (`MultiAgentHost`) the fleet commands start workers through. */
export interface FleetSpawnBackend {
  spawn(
    description: string,
    options?: SpawnCommandOptions,
  ): Promise<{ subagentId: string; taskId: string }>;
  ensureDirector(): Promise<Director | null>;
}

/**
 * `/spawn`, `/delegate` and `/director` over a fleet host, shared by the TUI and the engines.
 * A worker belongs to the conversation that asked, else to `getSessionId()`.
 */
export function fleetSpawnCallbacks(input: {
  host: FleetSpawnBackend;
  /** The Director already running; without one, the host brings it up. */
  getDirector: () => Director | null | undefined;
  getSessionId: () => string;
}): { [K in 'onSpawn' | 'onFleetSpawn' | 'onDirector']-?: NonNullable<FleetCommandHost[K]> } {
  return {
    onSpawn: async (description, options) => {
      const { subagentId, taskId } = await input.host.spawn(description, options);
      const tags = [
        options?.provider,
        options?.model,
        options?.name ? `"${options.name}"` : undefined,
      ].filter((tag): tag is string => Boolean(tag));
      const suffix = tags.length > 0 ? ` (${tags.join(' / ')})` : '';
      return `Spawned subagent ${subagentId}${suffix} for task ${taskId}. Use /agents to track progress.`;
    },
    onFleetSpawn: async (role, origin) => {
      const originSessionId = origin ?? input.getSessionId();
      if (!areSubagentsAllowedForSession(originSessionId)) {
        throw new Error('Subagents are disabled for this session.');
      }
      const director = input.getDirector() ?? (await input.host.ensureDirector());
      if (!director) {
        throw new AgentError({
          message: 'Director is not available.',
          code: 'AGENT_RUN_FAILED',
          context: { phase: 'fleet-spawn', role },
        });
      }
      return director.spawn({
        ...(FLEET_ROSTER[role] ?? {
          id: `manual-${Date.now()}`,
          name: role,
          maxIterations: 50,
          maxToolCalls: 200,
        }),
        originSessionId,
      });
    },
    onDirector: async () => {
      const director = await input.host.ensureDirector();
      return director ? 'Director mode is active.' : 'Director is not available.';
    },
  };
}
