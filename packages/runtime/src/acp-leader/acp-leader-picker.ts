/**
 * The ACP leader as a pickable provider for the WebUI: `acp`, with one
 * "model" per ACP agent installed here. It has no saved record and no
 * models.dev entry, so the WebUI pickers only offer it through this list.
 */
import { findAgentDescriptor } from '@wrongstack/acp';
import type { Config, Provider, ProviderConfig } from '@wrongstack/contracts/types';
import { acpAgentName } from '@wrongstack/contracts/types/agent-identity';
import type { ProviderRegistry } from '@wrongstack/core/registry';
import { installedBridgeAgents } from '@wrongstack/fleet';
import { ACP_LEADER_PROVIDER_ID, isHostBuiltLeader } from './acp-leader-host.js';

export interface PickableHostProvider {
  id: string;
  type: string;
  refreshQuota?: () => Promise<boolean>;
  models: Array<{
    id: string;
    name: string;
    description: string;
    contextWindow?: number;
    reasoningEffortLevels?: string[];
    effortSupported?: boolean;
  }>;
}

/** The `acp` entry, or none when no ACP agent is installed. */
export function acpLeaderPickable(config: Config | undefined): PickableHostProvider[] {
  const agents = installedBridgeAgents(config?.acp);
  if (agents.length === 0) return [];
  return [
    {
      id: ACP_LEADER_PROVIDER_ID,
      type: ACP_LEADER_PROVIDER_ID,
      models: agents.map((id) => {
        const descriptor = findAgentDescriptor(id);
        return {
          id,
          name: descriptor?.displayName ?? acpAgentName(id),
          description: 'Installed coding agent · session leader or subagent',
          ...(descriptor?.contextWindow ? { contextWindow: descriptor.contextWindow } : {}),
        };
      }),
    },
  ];
}

/**
 * Build a host-registered leader (the ACP leader, WrongForge) from the host's
 * provider registry, where its factory is registered; undefined for every
 * other provider, which the WebUI builds as before.
 */
export function buildAcpLeaderProvider(
  registry: Pick<ProviderRegistry, 'has' | 'create'> | undefined,
  providerId: string,
  config: ProviderConfig,
): Provider | undefined {
  const type = config.type ?? providerId;
  if (!isHostBuiltLeader(type) || !registry?.has(type)) return undefined;
  return registry.create({ ...config, type: providerId }, type);
}
