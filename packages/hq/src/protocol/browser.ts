import type { HqCommandAuditEntry } from '../commands.js';
import type { HqAlertMessage, HqEventEnvelope, HqHeartbeatMessage } from './core.js';
import type { HqResumeMessage } from './resume.js';
import type { HqSnapshot } from './session.js';

export interface HqBrowserSnapshotMessage {
  type: 'hq.snapshot';
  snapshot: HqSnapshot;
}

export interface HqBrowserEventMessage<TPayload = unknown> {
  type: 'hq.event';
  event: HqEventEnvelope<TPayload>;
}

/** Live control-plane lifecycle update. Emitted for every queued, delivered,
 * and acknowledged command so operator surfaces never need to poll to learn
 * whether a steer/interrupt reached its target. */
export interface HqBrowserCommandStatusMessage {
  type: 'hq.command_status';
  command: HqCommandAuditEntry;
}

/**
 * Sent when the operator revokes browser tokens. The affected session no
 * longer authenticates and its socket is about to close, so the surface should
 * clear its stored credential and show the auth gate rather than sit on a
 * connection that will silently stop delivering telemetry.
 *
 * Carries token KEYS (stored verifiers) only, never the secret. A key is not a
 * credential — it is the hash HQ keeps at rest and already writes to the auth
 * audit log — so putting it on the wire cannot be replayed as a login.
 */
export interface HqBrowserAuthRevokedMessage {
  type: 'hq.auth_revoked';
  revokedTokenKeys: readonly string[];
}

export type HqBrowserMessage =
  | HqBrowserSnapshotMessage
  | HqBrowserEventMessage
  | HqBrowserCommandStatusMessage
  | HqBrowserAuthRevokedMessage
  | HqResumeMessage
  | HqAlertMessage
  | HqHeartbeatMessage;
