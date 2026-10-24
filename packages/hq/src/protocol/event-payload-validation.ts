import type { HqBrainEventPayload } from './brain.js';
import type { HqClientHeartbeatPayload } from './client.js';
import type { HqUsagePayload } from './common-payloads.js';
import {
  isHqFleetSnapshotPayload,
  isHqMailboxAgentSummary,
  isHqMailboxMessageSummary,
  isHqMailboxSnapshotPayload,
  isHqMcpServerHealth,
  isHqSessionSnapshotPayload,
} from './event-payload-snapshot-guards.js';
import type { HqFleetEventPayload, HqWorktreeEventPayload } from './fleet.js';
import { type HqGovernanceSnapshotPayload, isHqGovernanceSnapshotPayload } from './governance.js';
import { isHqKanbanSnapshotPayload } from './kanban.js';
import type { HqMailboxEventPayload } from './mailbox.js';
import type { HqMcpHealthSnapshotPayload, HqMcpOperationPayload } from './mcp.js';
import { isHqPeerLostPayload, isHqPeerRehydratePayload } from './peer.js';
import { isHqSageSnapshotPayload } from './sage.js';
import type {
  HqSessionEndedPayload,
  HqTranscriptAppendPayload,
  HqTranscriptEntry,
} from './session.js';
import type {
  HqApprovalRequestedPayload,
  HqApprovalResolvedPayload,
  HqToolCompletedPayload,
  HqToolStartedPayload,
  HqUserInputRequestedPayload,
  HqUserInputResolvedPayload,
} from './tool.js';

/** Known `client.event` envelope event types whose payload shape we validate. */
const KNOWN_HQ_EVENT_PAYLOAD_TYPE_LIST = [
  'mailbox.snapshot',
  'mailbox.event',
  'kanban.snapshot',
  'sage.snapshot',
  'session.snapshot',
  'session.transcript',
  'session.ended',
  'fleet.snapshot',
  'fleet.event',
  'brain.event',
  'worktree.event',
  'tool.started',
  'tool.completed',
  'approval.requested',
  'approval.resolved',
  'user_input.requested',
  'user_input.resolved',
  'session.usage',
  'client.heartbeat',
  'mcp.health.snapshot',
  'mcp.operation',
  'governance.snapshot',
  'peer.rehydrate',
  'peer.lost',
] as const;

/**
 * The event types whose payload `parseHqEventPayload` validates, derived from
 * the list above so the list, the runtime guard and the switch's exhaustiveness
 * check all read one source instead of three hand-maintained copies.
 */
type ValidatedHqEventType = (typeof KNOWN_HQ_EVENT_PAYLOAD_TYPE_LIST)[number];

const KNOWN_HQ_EVENT_PAYLOAD_TYPES = new Set<string>(KNOWN_HQ_EVENT_PAYLOAD_TYPE_LIST);

/**
 * Narrows `eventType` to {@link ValidatedHqEventType}. This is what makes the
 * `default` clause a real compile-time check: `eventType` arrives as a bare
 * `string`, over which `default` can never narrow to `never` — which is why the
 * guard used to read `eventType as never` and silently swallowed drift.
 */
function isValidatedHqEventType(eventType: string): eventType is ValidatedHqEventType {
  return KNOWN_HQ_EVENT_PAYLOAD_TYPES.has(eventType);
}

function isHqMcpHealthSnapshotPayload(x: unknown): x is HqMcpHealthSnapshotPayload {
  if (typeof x !== 'object' || x === null) return false;
  const v = x as Record<string, unknown>;
  return Array.isArray(v.servers) && v.servers.every(isHqMcpServerHealth);
}

function isHqMcpOperationPayload(x: unknown): x is HqMcpOperationPayload {
  if (typeof x !== 'object' || x === null) return false;
  const v = x as Record<string, unknown>;
  return (
    typeof v.operation === 'object' &&
    v.operation !== null &&
    Array.isArray(v.servers) &&
    v.servers.every(isHqMcpServerHealth)
  );
}

const HQ_MAILBOX_EVENT_ACTIONS = new Set<string>([
  'message.sent',
  'message.read',
  'message.completed',
  'message.updated',
  'agent.registered',
  'agent.heartbeat',
  'agent.offline',
  'agent.deregistered',
]);

function isHqMailboxEventPayload(x: unknown): x is HqMailboxEventPayload {
  if (typeof x !== 'object' || x === null) return false;
  const v = x as Record<string, unknown>;
  if (typeof v.mailboxId !== 'string') return false;
  if (typeof v.action !== 'string' || !HQ_MAILBOX_EVENT_ACTIONS.has(v.action)) return false;
  // `message` and `agent` are optional but, when present, must satisfy
  // their respective shape guard so a downstream consumer can rely on
  // the typed fields.
  if (v.message !== undefined && !isHqMailboxMessageSummary(v.message)) return false;
  if (v.agent !== undefined && !isHqMailboxAgentSummary(v.agent)) return false;
  return true;
}

const HQ_TRANSCRIPT_ROLES = new Set<string>([
  'user',
  'assistant',
  'thinking',
  'tool',
  'system',
  'error',
]);

function isHqTranscriptEntry(x: unknown): x is HqTranscriptEntry {
  if (typeof x !== 'object' || x === null) return false;
  const v = x as Record<string, unknown>;
  return (
    typeof v.ts === 'string' &&
    typeof v.role === 'string' &&
    HQ_TRANSCRIPT_ROLES.has(v.role) &&
    typeof v.text === 'string'
  );
}

function isHqTranscriptAppendPayload(x: unknown): x is HqTranscriptAppendPayload {
  if (typeof x !== 'object' || x === null) return false;
  const v = x as Record<string, unknown>;
  if (
    typeof v.sessionId !== 'string' ||
    typeof v.fromSeq !== 'number' ||
    !Array.isArray(v.entries)
  ) {
    return false;
  }
  for (const entry of v.entries) {
    if (!isHqTranscriptEntry(entry)) return false;
  }
  return true;
}

function isHqSessionEndedPayload(x: unknown): x is HqSessionEndedPayload {
  if (typeof x !== 'object' || x === null) return false;
  const v = x as Record<string, unknown>;
  return typeof v.sessionId === 'string' && typeof v.endedAt === 'string';
}

function isHqFleetEventPayload(x: unknown): x is HqFleetEventPayload {
  if (typeof x !== 'object' || x === null) return false;
  const v = x as Record<string, unknown>;
  return typeof v.runId === 'string' && typeof v.event === 'string';
}

const HQ_BRAIN_EVENT_KINDS = new Set<string>([
  'decision_requested',
  'decision_answered',
  'decision_ask_human',
  'human_answered',
  'decision_denied',
  'intervention',
]);

function isHqBrainEventPayload(x: unknown): x is HqBrainEventPayload {
  if (typeof x !== 'object' || x === null) return false;
  const v = x as Record<string, unknown>;
  if (typeof v.kind !== 'string' || !HQ_BRAIN_EVENT_KINDS.has(v.kind)) return false;
  if (typeof v.at !== 'number') return false;
  return true;
}

const HQ_WORKTREE_EVENT_KINDS = new Set<string>([
  'allocated',
  'committed',
  'merging',
  'merged',
  'conflict',
  'released',
  'failed',
]);

function isHqWorktreeEventPayload(x: unknown): x is HqWorktreeEventPayload {
  if (typeof x !== 'object' || x === null) return false;
  const v = x as Record<string, unknown>;
  if (typeof v.kind !== 'string' || !HQ_WORKTREE_EVENT_KINDS.has(v.kind)) return false;
  if (typeof v.handleId !== 'string' || typeof v.ownerId !== 'string') return false;
  return true;
}

function isHqToolStartedPayload(x: unknown): x is HqToolStartedPayload {
  if (typeof x !== 'object' || x === null) return false;
  const v = x as Record<string, unknown>;
  return typeof v.toolName === 'string';
}

function isHqToolCompletedPayload(x: unknown): x is HqToolCompletedPayload {
  if (typeof x !== 'object' || x === null) return false;
  const v = x as Record<string, unknown>;
  return (
    typeof v.toolName === 'string' &&
    typeof v.status === 'string' &&
    typeof v.durationMs === 'number'
  );
}

const HQ_APPROVAL_DECISIONS = new Set([
  'yes',
  'no',
  'always',
  'always-exact',
  'always-command',
  'always-tool',
  'deny',
  'abort',
]);
const HQ_APPROVAL_SOURCES = new Set(['brain_timeout', 'abort', 'user']);

function isHqApprovalRequestedPayload(x: unknown): x is HqApprovalRequestedPayload {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const v = x as Record<string, unknown>;
  return (
    typeof v.toolUseId === 'string' &&
    v.toolUseId.length > 0 &&
    typeof v.toolName === 'string' &&
    typeof v.suggestedPattern === 'string' &&
    // Required, not optional: the dashboard derives "still pending" purely
    // from this deadline, so a payload without one would strand a card on
    // screen forever.
    typeof v.deadlineAt === 'number' &&
    Number.isFinite(v.deadlineAt) &&
    typeof v.destructive === 'boolean' &&
    (v.writeTargets === undefined || Array.isArray(v.writeTargets))
  );
}

function isHqApprovalResolvedPayload(x: unknown): x is HqApprovalResolvedPayload {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const v = x as Record<string, unknown>;
  return (
    typeof v.toolUseId === 'string' &&
    v.toolUseId.length > 0 &&
    typeof v.toolName === 'string' &&
    typeof v.decision === 'string' &&
    HQ_APPROVAL_DECISIONS.has(v.decision) &&
    typeof v.source === 'string' &&
    HQ_APPROVAL_SOURCES.has(v.source)
  );
}

function isHqUserInputRequestedPayload(x: unknown): x is HqUserInputRequestedPayload {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const request = (x as Record<string, unknown>)['request'];
  return (
    typeof request === 'object' &&
    request !== null &&
    typeof (request as Record<string, unknown>)['id'] === 'string' &&
    Array.isArray((request as Record<string, unknown>)['tabs'])
  );
}
function isHqUserInputResolvedPayload(x: unknown): x is HqUserInputResolvedPayload {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const v = x as Record<string, unknown>;
  return (
    typeof v['requestId'] === 'string' &&
    typeof v['response'] === 'object' &&
    v['response'] !== null &&
    (v['source'] === 'user' || v['source'] === 'abort' || v['source'] === 'unattended')
  );
}

function isHqUsagePayload(x: unknown): x is HqUsagePayload {
  if (typeof x !== 'object' || x === null) return false;
  // HqUsagePayload has all-optional numeric fields; accept any object so the
  // cost signal is never dropped on a partial payload, but require it be a
  // plain object (not array/null) to keep the downstream typed.
  return !Array.isArray(x);
}

function isHqClientHeartbeatPayload(x: unknown): x is HqClientHeartbeatPayload {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const v = x as Record<string, unknown>;
  return (
    typeof v.uptimeMs === 'number' &&
    (v.activeSessionId === undefined || typeof v.activeSessionId === 'string') &&
    (v.activeRunId === undefined || typeof v.activeRunId === 'string') &&
    typeof v.status === 'string' &&
    (v.status === 'active' ||
      v.status === 'idle' ||
      v.status === 'stale' ||
      v.status === 'error') &&
    (v.activeSubagents === undefined || typeof v.activeSubagents === 'number') &&
    (v.queuedTasks === undefined || typeof v.queuedTasks === 'number')
  );
}

/**
 * Validate the `payload` field of a {@link HqEventEnvelope} for known
 * event types. Returns `{ ok: true, payload }` with a narrowed payload
 * type when the event type has a registered shape guard and the payload
 * matches it; `{ ok: true, payload: unknown }` for event types that the
 * server does not yet validate; or `{ ok: false, reason }` when the
 * payload fails the registered guard.
 *
 * Use this after {@link parseHqFrame} has produced a valid frame, when
 * the frame is `client.event` and the server is about to consume the
 * event payload.
 */
export type HqEventPayloadResult<T> =
  | { ok: true; payload: T }
  | { ok: false; reason: 'unknown-event-type' | 'malformed-payload' };

export function parseHqEventPayload(
  eventType: string,
  payload: unknown,
): HqEventPayloadResult<unknown> {
  if (!isValidatedHqEventType(eventType)) {
    // Server does not validate this event type yet — pass it through
    // untyped so the publish pipeline is not blocked. Future events
    // can opt-in by adding their type + guard here.
    return { ok: true, payload };
  }
  switch (eventType) {
    case 'mailbox.snapshot':
      return isHqMailboxSnapshotPayload(payload)
        ? { ok: true, payload }
        : { ok: false, reason: 'malformed-payload' };
    case 'mailbox.event':
      return isHqMailboxEventPayload(payload)
        ? { ok: true, payload }
        : { ok: false, reason: 'malformed-payload' };
    case 'kanban.snapshot':
      return isHqKanbanSnapshotPayload(payload)
        ? { ok: true, payload }
        : { ok: false, reason: 'malformed-payload' };
    case 'sage.snapshot':
      return isHqSageSnapshotPayload(payload)
        ? { ok: true, payload }
        : { ok: false, reason: 'malformed-payload' };
    case 'session.snapshot':
      return isHqSessionSnapshotPayload(payload)
        ? { ok: true, payload }
        : { ok: false, reason: 'malformed-payload' };
    case 'session.transcript':
      return isHqTranscriptAppendPayload(payload)
        ? { ok: true, payload }
        : { ok: false, reason: 'malformed-payload' };
    case 'session.ended':
      return isHqSessionEndedPayload(payload)
        ? { ok: true, payload }
        : { ok: false, reason: 'malformed-payload' };
    case 'fleet.snapshot':
      return isHqFleetSnapshotPayload(payload)
        ? { ok: true, payload }
        : { ok: false, reason: 'malformed-payload' };
    case 'fleet.event':
      return isHqFleetEventPayload(payload)
        ? { ok: true, payload }
        : { ok: false, reason: 'malformed-payload' };
    case 'brain.event':
      return isHqBrainEventPayload(payload)
        ? { ok: true, payload }
        : { ok: false, reason: 'malformed-payload' };
    case 'worktree.event':
      return isHqWorktreeEventPayload(payload)
        ? { ok: true, payload }
        : { ok: false, reason: 'malformed-payload' };
    case 'tool.started':
      return isHqToolStartedPayload(payload)
        ? { ok: true, payload }
        : { ok: false, reason: 'malformed-payload' };
    case 'tool.completed':
      return isHqToolCompletedPayload(payload)
        ? { ok: true, payload }
        : { ok: false, reason: 'malformed-payload' };
    case 'approval.requested':
      return isHqApprovalRequestedPayload(payload)
        ? { ok: true, payload }
        : { ok: false, reason: 'malformed-payload' };
    case 'approval.resolved':
      return isHqApprovalResolvedPayload(payload)
        ? { ok: true, payload }
        : { ok: false, reason: 'malformed-payload' };
    case 'user_input.requested':
      return isHqUserInputRequestedPayload(payload)
        ? { ok: true, payload }
        : { ok: false, reason: 'malformed-payload' };
    case 'user_input.resolved':
      return isHqUserInputResolvedPayload(payload)
        ? { ok: true, payload }
        : { ok: false, reason: 'malformed-payload' };
    case 'session.usage':
      return isHqUsagePayload(payload)
        ? { ok: true, payload }
        : { ok: false, reason: 'malformed-payload' };
    case 'client.heartbeat':
      return isHqClientHeartbeatPayload(payload)
        ? { ok: true, payload }
        : { ok: false, reason: 'malformed-payload' };
    case 'mcp.health.snapshot':
      return isHqMcpHealthSnapshotPayload(payload)
        ? { ok: true, payload }
        : { ok: false, reason: 'malformed-payload' };
    case 'mcp.operation':
      return isHqMcpOperationPayload(payload)
        ? { ok: true, payload }
        : { ok: false, reason: 'malformed-payload' };
    case 'governance.snapshot':
      return isHqGovernanceSnapshotPayload(payload)
        ? { ok: true, payload: payload as HqGovernanceSnapshotPayload }
        : { ok: false, reason: 'malformed-payload' };
    case 'peer.rehydrate':
      return isHqPeerRehydratePayload(payload)
        ? { ok: true, payload }
        : { ok: false, reason: 'malformed-payload' };
    case 'peer.lost':
      return isHqPeerLostPayload(payload)
        ? { ok: true, payload }
        : { ok: false, reason: 'malformed-payload' };
    default: {
      // Real exhaustiveness check. `eventType` is narrowed to
      // ValidatedHqEventType by the guard above, so this only compiles while
      // EVERY entry of KNOWN_HQ_EVENT_PAYLOAD_TYPE_LIST has a case here — and
      // a case label missing from the list is rejected too. Adding an event
      // type to one place but not the other is now a build error, where the
      // old `eventType as never` cast hid it and handed callers a raw string.
      const _exhaustive: never = eventType;
      void _exhaustive;
      // Unreachable while the list and the switch agree. Keep the documented
      // contract anyway: an event type this module does not validate is passed
      // through untyped, never rejected.
      return { ok: true, payload };
    }
  }
}
