/**
 * Which topology nodes can open a live chat drawer.
 *
 * Service-mode nodes (daemons, HQ itself) and synthetic sessions have no
 * transcript to stream — clicking them must do nothing rather than open an
 * empty panel.
 */
import type { FleetTopologyNode } from './fleet-topology.js';

export interface FleetChatTarget {
  sessionId: string;
  agentId: string | null;
  label: string;
  status?: string | undefined;
}

export function chatTargetFromNode(node: FleetTopologyNode): FleetChatTarget | null {
  if (
    node.sessionId === undefined ||
    node.serviceMode !== undefined ||
    node.isSyntheticSession === true
  ) {
    return null;
  }
  return {
    sessionId: node.sessionId,
    agentId: node.agentId ?? null,
    label: node.label,
    status: node.status,
  };
}
