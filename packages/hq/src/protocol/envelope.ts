/**
 * HQ protocol envelope primitives — dependency leaf.
 *
 * This module is intentionally free of imports from any other HQ protocol
 * module so that the shared envelope/version contracts can be consumed by
 * every domain module (`core`, `client`, `session`, `fleet`, `resume`, …)
 * without creating a module cycle back through `core.ts`.
 *
 * `core.ts` re-exports these symbols for backward compatibility; new modules
 * that only need the envelope shape should import from here directly.
 *
 * @module hq/protocol/envelope
 */

export const HQ_PROTOCOL_VERSION = 1 as const;

export type HqProtocolVersion = typeof HQ_PROTOCOL_VERSION;

export type HqEventType =
  | 'client.hello'
  | 'client.heartbeat'
  | 'session.started'
  | 'session.status'
  | 'session.usage'
  | 'tool.started'
  | 'tool.completed'
  | 'approval.requested'
  | 'approval.resolved'
  | 'user_input.requested'
  | 'user_input.resolved'
  | 'fleet.snapshot'
  | 'fleet.event'
  | 'mailbox.snapshot'
  | 'mailbox.event'
  | 'kanban.snapshot'
  | 'sage.snapshot'
  | 'worklist.snapshot'
  | 'git.snapshot'
  | 'agent.message'
  | 'agent.status'
  | 'session.snapshot'
  | 'session.transcript'
  | 'session.ended'
  | 'brain.event'
  | 'worktree.event'
  | 'mcp.health.snapshot'
  | 'mcp.operation'
  | 'governance.snapshot'
  | 'peer.rehydrate'
  | 'peer.lost';

export interface HqEventEnvelope<TPayload = unknown> {
  id: string;
  type: HqEventType | (string & {});
  schemaVersion: HqProtocolVersion;
  timestamp: string;
  clientId: string;
  projectId: string;
  sessionId?: string;
  runId?: string;
  /**
   * Groups envelopes that belong to one logical activity, so a consumer can
   * render a causal chain instead of independent rows.
   *
   * Producer-assigned and opaque to HQ: the id is whatever the emitting
   * bridge considers the unit of work — a Brain decision request id, a fleet
   * run id. Two envelopes sharing it are the same activity observed twice
   * (requested → answered), never a duplicate delivery, which is what
   * distinguishes this from `id` (one envelope) and `seq` (ordering).
   *
   * Optional and additive: an envelope without it is simply uncorrelated, so
   * older publishers need no change and consumers must not require it.
   */
  correlationId?: string;
  seq: number;
  payload: TPayload;
}
