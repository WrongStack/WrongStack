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

export type HqBrowserMessage =
  | HqBrowserSnapshotMessage
  | HqBrowserEventMessage
  | HqBrowserCommandStatusMessage
  | HqResumeMessage
  | HqAlertMessage
  | HqHeartbeatMessage;
