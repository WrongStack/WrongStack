import type {
  HqClientCapability,
  HqClientCommandAckMessage,
  HqClientCommandPollMessage,
  HqClientEventPollMessage,
  HqClientHelloPayload,
  HqClientIdentity,
  HqClientKind,
  HqClientMessage,
  HqClientResumeMessage,
} from './client.js';
import {
  HQ_PROTOCOL_VERSION,
  type HqEventEnvelope,
  type HqEventType,
  type HqProtocolVersion,
} from './envelope.js';
import type { HqQueuedCommand } from './fleet.js';
import type { HqServerKanbanSnapshotMessage } from './kanban.js';
import type { HqProjectIdentity, HqWorkspaceKind } from './project.js';
import type { HqResumeMessage } from './resume.js';
import type { HqRedactionPolicy } from './tool.js';

export type { HqEventEnvelope, HqEventType, HqProtocolVersion };
export { HQ_PROTOCOL_VERSION };

export interface HqWelcomePayload {
  type: 'hq.welcome';
  protocolVersion: HqProtocolVersion;
  serverTime: string;
  acceptedCapabilities: readonly HqClientCapability[];
  redactionPolicy: HqRedactionPolicy;
}

export interface HqGitSnapshotPayload {
  branch?: string;
  dirtyFiles?: number;
  stagedFiles?: number;
  ahead?: number;
  behind?: number;
}

export interface HqAlertMessage {
  type: 'hq.alert';
  severity: 'info' | 'warn' | 'error';
  message: string;
  timestamp: string;
}

export interface HqHeartbeatMessage {
  type: 'hq.heartbeat';
  serverTime: string;
}

export interface HqServerCommandBatchMessage {
  type: 'hq.command_batch';
  commands: readonly HqQueuedCommand[];
}

export type HqServerMessage =
  | HqServerCommandBatchMessage
  | HqServerKanbanSnapshotMessage
  | HqWelcomePayload
  | HqResumeMessage;

/**
 * Discriminated parse result for {@link parseHqFrame}. The `reason` field
 * is only present when `ok` is `false`; consumers should narrow on `ok`
 * before accessing `frame` or `reason`.
 */
export type HqParseResult =
  | { ok: true; frame: HqClientMessage }
  | { ok: false; reason: 'invalid-json' | 'unknown-type' | 'malformed' };

/**
 * Known client → server frame `type` discriminators — the single source for the
 * allow-list.
 *
 * A `Record<HqClientMessage['type'], true>` map is used rather than an array
 * literal so BOTH drift directions fail the build: forgetting a member is a
 * "missing property" error, and listing one that the union never had is an
 * excess-property error. An `as const satisfies readonly …[]` list would only
 * pin the second direction. `parseHqFrame`'s `default` keeps a real `never`
 * check, which is the third tie (every listed member must also have a case).
 *
 * This set and that switch were two separate hand-written sources, and the drift
 * between them was the `client.event_poll` bug: the type was allow-listed but had
 * no case, so `parseHqFrame` handed consumers a raw string and both `ws.ts` call
 * sites closed the socket with `invalid frame: undefined`.
 *
 * Exported so the parity test can iterate the real allow-list instead of a
 * literal copy of it; a test that re-lists the types cannot see a new member.
 */
const HQ_CLIENT_FRAME_COVERAGE: Record<HqClientMessage['type'], true> = {
  'client.hello': true,
  'client.event': true,
  'client.command_poll': true,
  'client.command_ack': true,
  'client.resume': true,
  'client.event_poll': true,
};

export const KNOWN_HQ_CLIENT_FRAME_TYPES = new Set<HqClientMessage['type']>(
  // `Object.keys` widens to `string[]`; the cast is safe because the `Record`
  // annotation above already makes a missing key (TS2741) and an extra key
  // (TS2353) compile errors, so these keys ARE exactly the union members.
  Object.keys(HQ_CLIENT_FRAME_COVERAGE) as HqClientMessage['type'][],
);

const HQ_CLIENT_KINDS = new Set<HqClientKind>([
  'tui',
  'repl',
  'webui',
  'cli',
  'acp',
  'mailbox',
  'unknown',
]);
const HQ_WORKSPACE_KINDS = new Set<HqWorkspaceKind>(['git', 'directory', 'unknown']);
const HQ_CLIENT_CAPABILITIES = new Set<HqClientCapability>([
  'telemetry.publish',
  'session.summary',
  'fleet.summary',
  'mailbox.summary',
  'mailbox.serve',
  'control.receive',
  'control.approve',
  'kanban.dispatch',
]);
const HQ_COMMAND_ACK_STATUSES = new Set<HqClientCommandAckMessage['status']>([
  'accepted',
  'completed',
  'failed',
  'rejected',
]);

/** Top-level object + string `type` guard. */
function hasStringType(x: unknown): x is { type: string } {
  return typeof x === 'object' && x !== null && typeof (x as { type?: unknown }).type === 'string';
}

function isHqClientIdentity(x: unknown): x is HqClientIdentity {
  if (typeof x !== 'object' || x === null) return false;
  const v = x as Record<string, unknown>;
  return (
    typeof v.clientId === 'string' &&
    typeof v.kind === 'string' &&
    HQ_CLIENT_KINDS.has(v.kind as HqClientKind) &&
    typeof v.machineId === 'string' &&
    typeof v.startedAt === 'string'
  );
}

function isHqProjectIdentity(x: unknown): x is HqProjectIdentity {
  if (typeof x !== 'object' || x === null) return false;
  const v = x as Record<string, unknown>;
  return (
    typeof v.projectId === 'string' &&
    typeof v.projectRoot === 'string' &&
    typeof v.projectName === 'string' &&
    typeof v.machineId === 'string' &&
    typeof v.workspaceKind === 'string' &&
    HQ_WORKSPACE_KINDS.has(v.workspaceKind as HqWorkspaceKind)
  );
}

function isHqRedactionPolicy(x: unknown): x is HqRedactionPolicy {
  if (typeof x !== 'object' || x === null) return false;
  const v = x as Record<string, unknown>;
  return (
    typeof v.rawContent === 'boolean' &&
    (v.toolArgs === 'none' ||
      v.toolArgs === 'summary' ||
      v.toolArgs === 'redacted' ||
      v.toolArgs === 'full') &&
    (v.paths === 'none' ||
      v.paths === 'project-relative' ||
      v.paths === 'redacted' ||
      v.paths === 'full')
  );
}

function isHqClientHelloPayload(x: unknown): x is HqClientHelloPayload {
  if (typeof x !== 'object' || x === null) return false;
  const v = x as Record<string, unknown>;
  return (
    typeof v.protocolVersion === 'number' &&
    isHqClientIdentity(v.client) &&
    isHqProjectIdentity(v.project) &&
    Array.isArray(v.capabilities) &&
    v.capabilities.every(
      (capability) =>
        typeof capability === 'string' &&
        HQ_CLIENT_CAPABILITIES.has(capability as HqClientCapability),
    ) &&
    (v.redactionPolicy === undefined || isHqRedactionPolicy(v.redactionPolicy))
  );
}

function isHqEventEnvelope(x: unknown): x is HqEventEnvelope {
  if (typeof x !== 'object' || x === null) return false;
  const v = x as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.type === 'string' &&
    v.schemaVersion === HQ_PROTOCOL_VERSION &&
    typeof v.timestamp === 'string' &&
    typeof v.clientId === 'string' &&
    typeof v.projectId === 'string' &&
    Number.isSafeInteger(v.seq) &&
    (v.seq as number) >= 0 &&
    Object.hasOwn(v, 'payload')
  );
}

function isHqClientCommandPollMessage(x: unknown): x is HqClientCommandPollMessage {
  if (typeof x !== 'object' || x === null) return false;
  const v = x as Record<string, unknown>;
  return (
    typeof v.clientId === 'string' &&
    typeof v.projectId === 'string' &&
    (v.afterCommandId === undefined || typeof v.afterCommandId === 'string') &&
    (v.limit === undefined ||
      (Number.isSafeInteger(v.limit) && (v.limit as number) > 0 && (v.limit as number) <= 200))
  );
}

function isHqClientCommandAckMessage(x: unknown): x is HqClientCommandAckMessage {
  if (typeof x !== 'object' || x === null) return false;
  const v = x as Record<string, unknown>;
  return (
    typeof v.clientId === 'string' &&
    typeof v.projectId === 'string' &&
    typeof v.commandId === 'string' &&
    typeof v.status === 'string' &&
    HQ_COMMAND_ACK_STATUSES.has(v.status as HqClientCommandAckMessage['status']) &&
    (v.message === undefined || typeof v.message === 'string')
  );
}

function isHqClientResumeMessage(x: unknown): x is HqClientResumeMessage {
  if (typeof x !== 'object' || x === null) return false;
  const v = x as Record<string, unknown>;
  return (
    typeof v.type === 'string' &&
    v.type === 'client.resume' &&
    Number.isSafeInteger(v.lastSeqSeen) &&
    (v.lastSeqSeen as number) >= 0 &&
    (v.clientId === undefined || typeof v.clientId === 'string') &&
    (v.projectId === undefined || typeof v.projectId === 'string')
  );
}

function isHqClientEventPollMessage(x: unknown): x is HqClientEventPollMessage {
  if (typeof x !== 'object' || x === null) return false;
  const v = x as Record<string, unknown>;
  return (
    typeof v.type === 'string' &&
    v.type === 'client.event_poll' &&
    typeof v.clientId === 'string' &&
    typeof v.projectId === 'string' &&
    Number.isSafeInteger(v.afterSeq) &&
    (v.afterSeq as number) >= 0 &&
    (v.limit === undefined || typeof v.limit === 'number')
  );
}

/**
 * Strictly parse a raw client → server frame into a {@link HqParseResult}.
 *
 * Validates, in order:
 *  1. JSON syntax (`invalid-json` on failure)
 *  2. Top-level object with string `type` discriminator
 *  3. `type` is one of {@link HqClientMessage} union members (`unknown-type`)
 *  4. Per-type field-shape presence checks (`malformed` on failure)
 *
 * On success, `frame` is narrowed to {@link HqClientMessage} and consumers
 * can switch on `frame.type` for type-safe access to per-union-member
 * fields without `as` casts.
 */
export function parseHqFrame(raw: string | Buffer): HqParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }

  if (!hasStringType(parsed)) {
    return { ok: false, reason: 'malformed' };
  }
  const obj = parsed as { type: string } & Record<string, unknown>;

  // Narrow the discriminator ONCE so the `default` clause below is a real
  // compile-time exhaustiveness check over `HqClientMessage`.
  const type = obj.type as HqClientMessage['type'];

  if (!KNOWN_HQ_CLIENT_FRAME_TYPES.has(type)) {
    return { ok: false, reason: 'unknown-type' };
  }

  switch (type) {
    case 'client.hello':
      if (!isHqClientHelloPayload(obj.payload)) {
        return { ok: false, reason: 'malformed' };
      }
      return { ok: true, frame: { type: 'client.hello', payload: obj.payload } };
    case 'client.event':
      if (!isHqEventEnvelope(obj.event)) {
        return { ok: false, reason: 'malformed' };
      }
      return { ok: true, frame: { type: 'client.event', event: obj.event } };
    case 'client.command_poll':
      if (!isHqClientCommandPollMessage(obj)) {
        return { ok: false, reason: 'malformed' };
      }
      return {
        ok: true,
        frame: {
          type: 'client.command_poll',
          clientId: obj.clientId,
          projectId: obj.projectId,
          ...(typeof obj.afterCommandId === 'string' ? { afterCommandId: obj.afterCommandId } : {}),
          ...(typeof obj.limit === 'number' ? { limit: obj.limit } : {}),
        },
      };
    case 'client.command_ack':
      if (!isHqClientCommandAckMessage(obj)) {
        return { ok: false, reason: 'malformed' };
      }
      return {
        ok: true,
        frame: {
          type: 'client.command_ack',
          clientId: obj.clientId,
          projectId: obj.projectId,
          commandId: obj.commandId,
          status: obj.status as HqClientCommandAckMessage['status'],
          ...(typeof obj.message === 'string' ? { message: obj.message } : {}),
        },
      };
    case 'client.resume':
      if (!isHqClientResumeMessage(obj)) {
        return { ok: false, reason: 'malformed' };
      }
      return {
        ok: true,
        frame: {
          type: 'client.resume',
          lastSeqSeen: obj.lastSeqSeen,
          ...(typeof obj.clientId === 'string' ? { clientId: obj.clientId } : {}),
          ...(typeof obj.projectId === 'string' ? { projectId: obj.projectId } : {}),
        },
      };
    case 'client.event_poll':
      if (!isHqClientEventPollMessage(obj)) {
        return { ok: false, reason: 'malformed' };
      }
      return {
        ok: true,
        frame: {
          type: 'client.event_poll',
          clientId: obj.clientId,
          projectId: obj.projectId,
          afterSeq: obj.afterSeq,
          ...(typeof obj.limit === 'number' ? { limit: obj.limit } : {}),
        },
      };
    default: {
      // Exhaustiveness guard. `type` narrows to `never` here ONLY while every
      // `HqClientMessage` member has a case above, so adding a union member
      // without a case is a COMPILE ERROR. It used to be `obj.type as never`,
      // whose cast silenced that check and let an allow-listed type fall
      // through to `return _exhaustive` — i.e. `parseHqFrame` handing back a
      // raw string instead of an `HqParseResult`. The explicit rejection below
      // keeps the declared return contract total even if a non-JSON boundary
      // value reaches this point.
      const _exhaustive: never = type;
      void _exhaustive;
      return { ok: false, reason: 'unknown-type' };
    }
  }
}

export function createHqEventEnvelope<TPayload>(input: {
  id: string;
  type: HqEventType | (string & {});
  timestamp: string;
  clientId: string;
  projectId: string;
  seq: number;
  payload: TPayload;
  sessionId?: string;
  runId?: string;
  correlationId?: string;
}): HqEventEnvelope<TPayload> {
  return {
    id: input.id,
    type: input.type,
    schemaVersion: HQ_PROTOCOL_VERSION,
    timestamp: input.timestamp,
    clientId: input.clientId,
    projectId: input.projectId,
    seq: input.seq,
    payload: input.payload,
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
  };
}
export type { HqMachineRecord, HqUsagePayload } from './common-payloads.js';
export type { HqEventPayloadResult } from './event-payload-validation.js';
export { parseHqEventPayload } from './event-payload-validation.js';
