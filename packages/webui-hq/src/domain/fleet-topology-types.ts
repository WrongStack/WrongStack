import type { HqSessionAgentSummary, HqSessionSnapshotPayload } from '@wrongstack/hq';

export type FleetTopologyNodeKind = 'machine' | 'project' | 'terminal' | 'agent';

export interface FleetTopologyNode extends Record<string, unknown> {
  id: string;
  kind: FleetTopologyNodeKind;
  label: string;
  sub?: string;
  status?: string;
  chips: string[];
  machineId?: string;
  projectId?: string;
  clientId?: string;
  sessionId?: string;
  agentId?: string;
  clientKind?: string;
  version?: string;
  agent?: HqSessionAgentSummary;
  session?: HqSessionSnapshotPayload;
  isSyntheticSession?: boolean;
  serviceMode?: 'mailbox-serve';
  /** Carried over from an earlier snapshot that no longer lists this node. */
  retained?: boolean;
}

export interface FleetTopologyEdge {
  id: string;
  source: string;
  target: string;
}

export interface FleetTopology {
  nodes: FleetTopologyNode[];
  edges: FleetTopologyEdge[];
}

export type FleetTopologyScope = 'all' | 'machine' | 'project';
