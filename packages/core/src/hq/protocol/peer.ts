/**
 * Peer lifecycle envelopes — broadcast from the HQ server to surviving clients
 * when a project's leader session terminates. Carries no runnable command by
 * default; the broadcast is informational. The envelope is piggybacked on
 * the existing client WS channel via `client.command_poll` (per
 * `docs/plans/hq-evolution-2026-08.md` §10.1).
 *
 * Two event types:
 *  - `peer.rehydrate` — the project lost its leader AND has at least one
 *    surviving client. Envelope carries project id, machine id, leader
 *    client id, reason, and an opaque `rehydrateHint` (≤ 280 chars).
 *  - `peer.lost` — the project lost its leader AND has no surviving clients.
 *    Envelope is informational; the server still emits it so the cockpit and
 *    any future reconnecting client can see the leader is gone.
 *
 * Both events are v1-protocol additive (no `protocolVersion: 2` bump required).
 *
 * @module hq/protocol/peer
 */

export type HqPeerRehydrateReason = 'graceful' | 'crash' | 'heartbeat-timeout' | 'auth-revoked';

export const HQ_PEER_REHYDRATE_REASONS = new Set<HqPeerRehydrateReason>([
  'graceful',
  'crash',
  'heartbeat-timeout',
  'auth-revoked',
]);

/** Maximum length of the opaque `rehydrateHint` field. */
export const HQ_PEER_REHYDRATE_HINT_MAX_CHARS = 280;

/**
 * Synthetic `clientId` the HQ server uses on `peer.rehydrate` / `peer.lost`
 * envelopes. It is *not* a real publisher identity — it identifies the
 * browser-side cursor bucket the dashboard uses to dedupe / replay peer
 * lifecycle envelopes across reconnects. Both the server (`hq-server/ws.ts`)
 * and the browser (`webui-hq`) must agree on this literal; hoisting it here
 * keeps a single source of truth.
 */
export const HQ_BROWSER_PEER_RESUME_CLIENT_ID = '__hq_peer__';

export interface HqPeerRehydratePayload {
  projectId: string;
  machineId: string;
  leaderClientId: string;
  previousLeaderHandle: string;
  reason: HqPeerRehydrateReason;
  detectedAt: string;
  /** Opaque, project-specific. Client decides what to do with it. */
  rehydrateHint?: string;
  /** Optional, only if the previous leader explicitly registered a command. */
  rehydrateCommandId?: string;
}

export interface HqPeerLostPayload {
  projectId: string;
  machineId: string;
  leaderClientId: string;
  previousLeaderHandle: string;
  reason: HqPeerRehydrateReason;
  detectedAt: string;
}

function isStringOrUndefined(x: unknown): x is string | undefined {
  return x === undefined || typeof x === 'string';
}

export function isHqPeerRehydratePayload(x: unknown): x is HqPeerRehydratePayload {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const v = x as Record<string, unknown>;
  if (typeof v.projectId !== 'string' || v.projectId.length === 0) return false;
  if (typeof v.machineId !== 'string' || v.machineId.length === 0) return false;
  if (typeof v.leaderClientId !== 'string' || v.leaderClientId.length === 0) return false;
  if (typeof v.previousLeaderHandle !== 'string' || v.previousLeaderHandle.length === 0)
    return false;
  if (
    typeof v.reason !== 'string' ||
    !HQ_PEER_REHYDRATE_REASONS.has(v.reason as HqPeerRehydrateReason)
  )
    return false;
  if (typeof v.detectedAt !== 'string' || !Number.isFinite(Date.parse(v.detectedAt))) return false;
  if (!isStringOrUndefined(v.rehydrateHint)) return false;
  if (v.rehydrateHint !== undefined && v.rehydrateHint.length > HQ_PEER_REHYDRATE_HINT_MAX_CHARS)
    return false;
  if (!isStringOrUndefined(v.rehydrateCommandId)) return false;
  return true;
}

export function isHqPeerLostPayload(x: unknown): x is HqPeerLostPayload {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const v = x as Record<string, unknown>;
  if (typeof v.projectId !== 'string' || v.projectId.length === 0) return false;
  if (typeof v.machineId !== 'string' || v.machineId.length === 0) return false;
  if (typeof v.leaderClientId !== 'string' || v.leaderClientId.length === 0) return false;
  if (typeof v.previousLeaderHandle !== 'string' || v.previousLeaderHandle.length === 0)
    return false;
  if (
    typeof v.reason !== 'string' ||
    !HQ_PEER_REHYDRATE_REASONS.has(v.reason as HqPeerRehydrateReason)
  )
    return false;
  if (typeof v.detectedAt !== 'string' || !Number.isFinite(Date.parse(v.detectedAt))) return false;
  return true;
}
