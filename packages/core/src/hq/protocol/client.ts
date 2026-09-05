import type { HqEventEnvelope, HqProtocolVersion } from './core.js';
import type { HqProjectIdentity, HqProjectStatus } from './project.js';
import type { HqRedactionPolicy } from './tool.js';

/**
 * The surface a publisher speaks for.
 *
 * Validated as a closed set at `client.hello` (`HQ_CLIENT_KINDS`), so a new
 * surface has to be added in BOTH places or its connection is refused.
 */
export type HqClientKind = 'tui' | 'repl' | 'webui' | 'cli' | 'acp' | 'mailbox' | 'unknown';

export type HqClientCapability =
  | 'telemetry.publish'
  | 'session.summary'
  | 'fleet.summary'
  | 'mailbox.summary'
  | 'mailbox.serve'
  | 'control.receive';

export interface HqClientIdentity {
  clientId: string;
  kind: HqClientKind;
  version?: string;
  machineId: string;
  hostname?: string;
  pid?: number;
  startedAt: string;
}

export interface HqClientHelloPayload {
  protocolVersion: HqProtocolVersion;
  client: HqClientIdentity;
  project: HqProjectIdentity;
  capabilities: readonly HqClientCapability[];
  /** Publisher-side policy already applied before telemetry leaves the client. */
  redactionPolicy?: HqRedactionPolicy;
}

export interface HqClientHeartbeatPayload {
  uptimeMs: number;
  activeSessionId?: string;
  activeRunId?: string;
  status: HqProjectStatus;
  activeSubagents?: number;
  queuedTasks?: number;
}

export interface HqClientRecord {
  clientId: string;
  kind: HqClientKind;
  machineId: string;
  hostname?: string;
  pid?: number;
  version?: string;
  connected: boolean;
  connectedAt?: string;
  lastSeenAt: string;
  projectId: string;
  sessionId?: string;
  capabilities: readonly HqClientCapability[];
}

export interface HqClientHelloMessage {
  type: 'client.hello';
  payload: HqClientHelloPayload;
}

export interface HqClientEventMessage<TPayload = unknown> {
  type: 'client.event';
  event: HqEventEnvelope<TPayload>;
}

export interface HqClientCommandPollMessage {
  type: 'client.command_poll';
  clientId: string;
  projectId: string;
  afterCommandId?: string;
  limit?: number;
}

export interface HqClientCommandAckMessage {
  type: 'client.command_ack';
  clientId: string;
  projectId: string;
  commandId: string;
  status: 'accepted' | 'completed' | 'failed' | 'rejected';
  message?: string;
}

export interface HqClientResumeMessage {
  type: 'client.resume';
  /**
   * Highest `seq` value the client has already received via prior
   * `client.event` envelopes. The server replies with `hq.resume_gap`
   * containing the missed envelopes (capped at 1000 / 1 MB) or `hq.snapshot`
   * if the gap is too large. See `docs/plans/hq-evolution-2026-08.md` §2.5.
   */
  lastSeqSeen: number;
  /**
   * Optional identity hint. When present, the server uses it to anchor
   * the resumption to the previous session's state. When absent, the server
   * falls back to the WebSocket's existing auth context.
   */
  clientId?: string;
  projectId?: string;
}

export type HqClientMessage =
  | HqClientHelloMessage
  | HqClientEventMessage
  | HqClientCommandPollMessage
  | HqClientCommandAckMessage
  | HqClientResumeMessage
  | HqClientEventPollMessage;

/**
 * Proactive gap-fill: a client can request missed envelopes by `clientId`
 * and `afterSeq` without waiting for the push path. The server replies with
 * `hq.resume_gap` (bounded list) or `hq.snapshot` when the gap is too large.
 * See `docs/plans/hq-evolution-2026-08.md` §2.2.
 */
export interface HqClientEventPollMessage {
  type: 'client.event_poll';
  clientId: string;
  projectId: string;
  afterSeq: number;
  limit?: number;
}
