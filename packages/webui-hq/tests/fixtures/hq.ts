/** Shared HQ protocol fixtures for the data-layer tests. */
import type {
  HqAlertMessage,
  HqClientRecord,
  HqCommandAuditEntry,
  HqEventEnvelope,
  HqSessionSnapshotPayload,
  HqSnapshot,
} from '@wrongstack/core/hq';
import type { HqFleetState, HqSelectionState } from '../../src/data/store/types.js';

export const T0 = '2026-07-14T12:00:00.000Z';

export function snapshot(generatedAt: string = T0): HqSnapshot {
  return {
    generatedAt,
    clients: [],
    projects: [],
    sessions: [],
    fleets: [],
    mailboxes: [],
    totals: {
      activeProjects: 0,
      activeClients: 0,
      activeSessions: 0,
      activeSubagents: 0,
      unreadMailboxMessages: 0,
      incompleteMailboxMessages: 0,
      totalCostUsd: 0,
    },
  };
}

export function liveSnapshot(
  sessionId: string,
  agentIds: readonly string[],
  generatedAt: string = T0,
): HqSnapshot {
  const agents = agentIds.map((id) => ({
    id,
    name: `agent-${id}`,
    status: 'idle' as const,
    iterations: 0,
    toolCalls: 0,
    lastActivityAt: generatedAt,
  }));
  const session: HqSessionSnapshotPayload = {
    sessionId,
    clientKind: 'cli',
    machineId: 'machine-1',
    projectId: 'project-1',
    projectName: 'Project 1',
    projectRoot: '/tmp/project',
    status: 'active',
    startedAt: generatedAt,
    lastActivityAt: generatedAt,
    agentCount: agents.length,
    agents,
  };
  return { ...snapshot(generatedAt), liveSessions: [session] };
}

export function snapshotWithClient(clientId: string, generatedAt: string = T0): HqSnapshot {
  const client: HqClientRecord = {
    clientId,
    machineId: 'machine-1',
    kind: 'cli',
    connected: true,
    connectedAt: generatedAt,
    lastSeenAt: generatedAt,
    capabilities: [],
    projectId: 'project-1',
  };
  return { ...snapshot(generatedAt), clients: [client] };
}

export function event(id: string, overrides: Partial<HqEventEnvelope> = {}): HqEventEnvelope {
  return {
    id,
    type: 'fleet.event',
    schemaVersion: 1,
    timestamp: T0,
    clientId: 'client-1',
    projectId: 'project-1',
    seq: 1,
    payload: {},
    ...overrides,
  } as HqEventEnvelope;
}

/** A payload that satisfies `isHqPeerRehydratePayload` / `isHqPeerLostPayload`. */
export function peerPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: 'project-1',
    machineId: 'machine-1',
    leaderClientId: 'client-1',
    previousLeaderHandle: 'leader@cli',
    reason: 'crash',
    detectedAt: T0,
    ...overrides,
  };
}

/** `HqAlertMessage` IS the wire frame — `type` is inline, not a wrapper. */
export function alert(overrides: Partial<HqAlertMessage> = {}): HqAlertMessage {
  return {
    type: 'hq.alert',
    timestamp: T0,
    severity: 'warn',
    message: 'disk pressure',
    ...overrides,
  };
}

export function commandEntry(
  commandId: string,
  overrides: Partial<HqCommandAuditEntry> = {},
): HqCommandAuditEntry {
  return {
    commandId,
    type: 'steer',
    clientId: 'client-1',
    enqueuedBy: 'operator',
    enqueuedAt: T0,
    status: 'queued',
    ...overrides,
  } as HqCommandAuditEntry;
}

/** A minimal, fully-defaulted slice for the pure reducers. */
export function fleetState(
  overrides: Partial<HqFleetState & HqSelectionState> = {},
): HqFleetState & HqSelectionState {
  return {
    snapshot: null,
    events: [],
    alerts: [],
    commandStatuses: [],
    resumeCursors: {},
    needsSnapshotRefresh: false,
    peerEnvelope: null,
    connected: false,
    authRequired: false,
    selectedSessionId: null,
    selectedAgentId: null,
    selectedClientId: null,
    ...overrides,
  };
}
