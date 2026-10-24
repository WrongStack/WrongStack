import type { HqFleetSnapshotPayload } from './fleet.js';
import type {
  HqMailboxAgentSummary,
  HqMailboxMessageSummary,
  HqMailboxSnapshotPayload,
} from './mailbox.js';
import type {
  HqMcpFailureCounts,
  HqMcpHealthCheck,
  HqMcpLatencySummary,
  HqMcpServerHealth,
} from './mcp.js';
import type {
  HqSessionAgentSummary,
  HqSessionSnapshotPayload,
  HqSubagentSummary,
} from './session.js';

function isHqMcpLatencySummary(x: unknown): x is HqMcpLatencySummary {
  if (typeof x !== 'object' || x === null) return false;
  const v = x as Record<string, unknown>;
  return (
    typeof v.count === 'number' &&
    (v.lastMs === undefined || typeof v.lastMs === 'number') &&
    (v.minMs === undefined || typeof v.minMs === 'number') &&
    (v.maxMs === undefined || typeof v.maxMs === 'number') &&
    (v.p50Ms === undefined || typeof v.p50Ms === 'number') &&
    (v.p95Ms === undefined || typeof v.p95Ms === 'number')
  );
}

function isHqMcpFailureCounts(x: unknown): x is HqMcpFailureCounts {
  if (typeof x !== 'object' || x === null) return false;
  const v = x as Record<string, unknown>;
  return (
    typeof v.transport === 'number' && typeof v.protocol === 'number' && typeof v.tool === 'number'
  );
}

function isHqMcpHealthCheck(x: unknown): x is HqMcpHealthCheck {
  if (typeof x !== 'object' || x === null) return false;
  const v = x as Record<string, unknown>;
  return (
    typeof v.name === 'string' &&
    typeof v.passed === 'boolean' &&
    (v.value === undefined || typeof v.value === 'number') &&
    (v.threshold === undefined || typeof v.threshold === 'number')
  );
}

const HQ_MCP_HEALTH_STATES = new Set<string>([
  'disabled',
  'dormant',
  'connecting',
  'healthy',
  'degraded',
  'failed',
]);

const HQ_MCP_CONNECTION_STATES = new Set<string>([
  'idle',
  'dormant',
  'connecting',
  'connected',
  'reconnecting',
  'disconnected',
  'failed',
]);

export function isHqMcpServerHealth(x: unknown): x is HqMcpServerHealth {
  if (typeof x !== 'object' || x === null) return false;
  const v = x as Record<string, unknown>;
  return (
    typeof v.name === 'string' &&
    // HQ stamps projectId/clientId from the authenticated connection right
    // after validation; requiring the publisher to send them rejected every
    // snapshot from a client with at least one MCP server configured.
    (v.projectId === undefined || typeof v.projectId === 'string') &&
    (v.clientId === undefined || typeof v.clientId === 'string') &&
    typeof v.connectionState === 'string' &&
    HQ_MCP_CONNECTION_STATES.has(v.connectionState) &&
    typeof v.healthState === 'string' &&
    HQ_MCP_HEALTH_STATES.has(v.healthState) &&
    (v.lastSuccessAt === undefined || typeof v.lastSuccessAt === 'string') &&
    (v.lastFailureAt === undefined || typeof v.lastFailureAt === 'string') &&
    (v.lastFailureKind === undefined ||
      v.lastFailureKind === 'transport' ||
      v.lastFailureKind === 'protocol' ||
      v.lastFailureKind === 'tool') &&
    typeof v.consecutiveFailures === 'number' &&
    isHqMcpFailureCounts(v.failures) &&
    typeof v.reconnectCount === 'number' &&
    typeof v.wakeCount === 'number' &&
    typeof v.sleepCount === 'number' &&
    typeof v.restartCount === 'number' &&
    isHqMcpLatencySummary(v.connectionLatency) &&
    isHqMcpLatencySummary(v.discoveryLatency) &&
    isHqMcpLatencySummary(v.callLatency) &&
    typeof v.inFlightCalls === 'number' &&
    typeof v.peakInFlightCalls === 'number' &&
    Array.isArray(v.healthChecks) &&
    v.healthChecks.every(isHqMcpHealthCheck)
  );
}

export function isHqMailboxMessageSummary(x: unknown): x is HqMailboxMessageSummary {
  if (typeof x !== 'object' || x === null) return false;
  const v = x as Record<string, unknown>;
  return (
    typeof v.messageId === 'string' &&
    typeof v.from === 'string' &&
    typeof v.to === 'string' &&
    typeof v.subject === 'string' &&
    typeof v.priority === 'string' &&
    typeof v.timestamp === 'string' &&
    typeof v.completed === 'boolean' &&
    typeof v.hasBody === 'boolean'
  );
}

export function isHqMailboxAgentSummary(x: unknown): x is HqMailboxAgentSummary {
  if (typeof x !== 'object' || x === null) return false;
  const v = x as Record<string, unknown>;
  return (
    typeof v.agentId === 'string' &&
    typeof v.name === 'string' &&
    typeof v.sessionId === 'string' &&
    typeof v.status === 'string' &&
    typeof v.iterations === 'number' &&
    typeof v.toolCalls === 'number' &&
    typeof v.lastActivityAt === 'string' &&
    typeof v.lastSeenAt === 'string' &&
    typeof v.online === 'boolean'
  );
}

export function isHqMailboxSnapshotPayload(x: unknown): x is HqMailboxSnapshotPayload {
  if (typeof x !== 'object' || x === null) return false;
  const v = x as Record<string, unknown>;
  if (
    typeof v.mailboxId !== 'string' ||
    (v.scope !== 'project' && v.scope !== 'global') ||
    !Array.isArray(v.messages) ||
    !Array.isArray(v.agents) ||
    typeof v.totals !== 'object' ||
    v.totals === null
  ) {
    return false;
  }
  const totals = v.totals as Record<string, unknown>;
  if (
    typeof totals.messages !== 'number' ||
    typeof totals.unread !== 'number' ||
    typeof totals.incomplete !== 'number' ||
    typeof totals.highPriority !== 'number' ||
    typeof totals.onlineAgents !== 'number'
  ) {
    return false;
  }
  for (const message of v.messages) {
    if (!isHqMailboxMessageSummary(message)) return false;
  }
  for (const agent of v.agents) {
    if (!isHqMailboxAgentSummary(agent)) return false;
  }
  return true;
}

const HQ_SESSION_AGENT_STATUSES = new Set<string>([
  'idle',
  'running',
  'streaming',
  'waiting_user',
  'error',
]);

function isHqSessionAgentSummary(x: unknown): x is HqSessionAgentSummary {
  if (typeof x !== 'object' || x === null) return false;
  const v = x as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.status === 'string' &&
    HQ_SESSION_AGENT_STATUSES.has(v.status) &&
    typeof v.iterations === 'number' &&
    typeof v.toolCalls === 'number' &&
    typeof v.lastActivityAt === 'string'
  );
}

const HQ_SESSION_STATUSES = new Set<string>(['active', 'idle', 'closing', 'stale']);

export function isHqSessionSnapshotPayload(x: unknown): x is HqSessionSnapshotPayload {
  if (typeof x !== 'object' || x === null) return false;
  const v = x as Record<string, unknown>;
  if (
    typeof v.sessionId !== 'string' ||
    typeof v.clientKind !== 'string' ||
    typeof v.machineId !== 'string' ||
    typeof v.projectId !== 'string' ||
    typeof v.projectName !== 'string' ||
    typeof v.projectRoot !== 'string' ||
    typeof v.status !== 'string' ||
    !HQ_SESSION_STATUSES.has(v.status) ||
    typeof v.startedAt !== 'string' ||
    typeof v.lastActivityAt !== 'string' ||
    typeof v.agentCount !== 'number' ||
    !Array.isArray(v.agents)
  ) {
    return false;
  }
  for (const agent of v.agents) {
    if (!isHqSessionAgentSummary(agent)) return false;
  }
  return true;
}

const HQ_FLEET_SUBAGENT_STATUS = new Set<string>([
  'pending',
  'running',
  'idle',
  'completed',
  'failed',
  'stopped',
]);

function isHqSubagentSummary(x: unknown): x is HqSubagentSummary {
  if (typeof x !== 'object' || x === null) return false;
  const v = x as Record<string, unknown>;
  return (
    typeof v.subagentId === 'string' &&
    typeof v.status === 'string' &&
    HQ_FLEET_SUBAGENT_STATUS.has(v.status) &&
    (v.model === undefined || typeof v.model === 'string')
  );
}

function isOptionalFiniteNumber(x: unknown): boolean {
  return x === undefined || (typeof x === 'number' && Number.isFinite(x));
}

export function isHqFleetSnapshotPayload(x: unknown): x is HqFleetSnapshotPayload {
  if (typeof x !== 'object' || x === null) return false;
  const v = x as Record<string, unknown>;
  if (
    typeof v.runId !== 'string' ||
    typeof v.activeSubagents !== 'number' ||
    typeof v.queuedTasks !== 'number' ||
    typeof v.completedTasks !== 'number' ||
    typeof v.failedTasks !== 'number' ||
    !Array.isArray(v.subagents)
  ) {
    return false;
  }
  for (const s of v.subagents) {
    if (!isHqSubagentSummary(s)) return false;
  }
  // Optional lifetime-spawn / concurrency budget fields (issue #323).
  if (!isOptionalFiniteNumber(v.maxConcurrent)) return false;
  if (!isOptionalFiniteNumber(v.maxSpawns)) return false;
  if (!isOptionalFiniteNumber(v.usedSpawns)) return false;
  if (!isOptionalFiniteNumber(v.remainingSpawns)) return false;
  if (!isOptionalFiniteNumber(v.checkpointMaxSpawns)) return false;
  if (v.effectiveSource !== undefined && typeof v.effectiveSource !== 'string') return false;
  if (v.ceilingMismatch !== undefined && typeof v.ceilingMismatch !== 'boolean') return false;
  return true;
}
