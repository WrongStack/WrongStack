/**
 * HQ server — Leader tracking, promotion, and leader loss detection.
 *
 * @module hq-server/ws-leader
 */

import type {
  HqEventEnvelope,
  HqPeerLostPayload,
  HqPeerRehydratePayload,
  HqPeerRehydrateReason,
  HqPersistence,
} from '@wrongstack/core/hq';
import { HQ_BROWSER_PEER_RESUME_CLIENT_ID, HQ_PROTOCOL_VERSION } from '@wrongstack/core/hq';
import type { WebSocket } from 'ws';
import { broadcastEvent, sendGuarded } from './snapshot.js';
import type { ConnectedClient } from './types.js';

const MAX_EVENT_LOG = 5000;

/**
 * Window during which a subsequent `peer.rehydrate` for the same
 * `(projectId, previousLeaderHandle)` pair is suppressed. Per the
 * hq-evolution-2026-08 plan §10.1 ("Dedup by previousLeaderHandle:
 * same handle emitted twice in 1 h → second is suppressed").
 */
const PEER_DEDUP_WINDOW_MS = 60 * 60 * 1000;

/**
 * Dedup map: `(projectId || ':' || previousLeaderHandle) → epoch ms of last
 * emit`. Cleared when older than `PEER_DEDUP_WINDOW_MS`.
 */
const peerDedupMap = new Map<string, number>();

function peerDedupKey(projectId: string, previousLeaderHandle: string): string {
  return `${projectId}::${previousLeaderHandle}`;
}

/**
 * Returns `true` if a `peer.rehydrate` for the same
 * `(projectId, previousLeaderHandle)` was emitted within the last hour.
 * Side effect: prunes expired entries.
 */
function checkPeerDedup(projectId: string, previousLeaderHandle: string): boolean {
  const key = peerDedupKey(projectId, previousLeaderHandle);
  const now = Date.now();
  // Prune expired entries (cheap iteration; expected size is small).
  for (const [k, ts] of peerDedupMap) {
    if (now - ts > PEER_DEDUP_WINDOW_MS) peerDedupMap.delete(k);
  }
  const last = peerDedupMap.get(key);
  return last !== undefined && now - last <= PEER_DEDUP_WINDOW_MS;
}

function recordPeerEmit(projectId: string, previousLeaderHandle: string): void {
  peerDedupMap.set(peerDedupKey(projectId, previousLeaderHandle), Date.now());
}

/** Monotonic counter for peer.rehydrate / peer.lost envelope seq values. */
let peerEventSeq = 0;

function nextPeerEventSeq(eventLog?: readonly HqEventEnvelope[]): number {
  if (eventLog !== undefined) {
    for (const env of eventLog) {
      if (env.clientId === HQ_BROWSER_PEER_RESUME_CLIENT_ID && env.seq > peerEventSeq) {
        peerEventSeq = env.seq;
      }
    }
  }
  peerEventSeq += 1;
  return peerEventSeq;
}

/**
 * Leader tracking: the project leader is the unique client with
 * `control.receive` capability. The first client to register with that
 * capability wins (`isLeader = true`); subsequent clients with the same
 * capability are followers (`isLeader = false`). When the leader's
 * connection is lost, the next-most-recent client with `control.receive`
 * is promoted via `promoteNewLeader` (see `detectLeaderLoss`).
 */
export function computeIsLeader(
  clients: Map<WebSocket, ConnectedClient>,
  projectId: string,
  acceptedCapabilities: readonly string[],
): boolean {
  if (!acceptedCapabilities.includes('control.receive')) return false;
  for (const other of clients.values()) {
    if (other.projectId === projectId && other.capabilities.includes('control.receive')) {
      return false;
    }
  }
  return true;
}

/**
 * After a leader is removed, promote the most recent surviving client with
 * `control.receive` to leader. Returns the promoted client id, or null if
 * no surviving client has `control.receive`.
 */
function promoteNewLeader(
  clients: Map<WebSocket, ConnectedClient>,
  projectId: string,
  excludeWs: WebSocket,
  excludeClient: ConnectedClient,
): string | null {
  const survivors: ConnectedClient[] = [];
  for (const [otherWs, otherClient] of clients) {
    if (otherWs === excludeWs || otherClient === excludeClient) continue;
    if (otherClient.projectId !== projectId) continue;
    if (!otherClient.capabilities.includes('control.receive')) continue;
    survivors.push(otherClient);
  }
  if (survivors.length === 0) return null;
  // Most recent survivor wins.
  survivors.sort((a, b) => Date.parse(b.connectedAt) - Date.parse(a.connectedAt));
  const promoted = survivors[0];
  if (promoted) {
    promoted.isLeader = true;
    return promoted.clientId;
  }
  return null;
}

/**
 * Detect leader loss and emit the appropriate envelope. Currently wired
 * on `client.closed` (graceful close) and the two heartbeat-timeout sites
 * in `hq-server.ts`. An `auth-revoked` call site is a planned follow-up;
 * the `reason` parameter already accepts it.
 *
 * Returns `true` when a leader-loss event was actually emitted. Note:
 * the dedup gate (`PEER_DEDUP_WINDOW_MS`) suppresses re-emit for the same
 * `(projectId, previousLeaderHandle)` and is intentionally NOT considered
 * a "not the leader" outcome — the lost client is still the leader; the
 * function returns `false` purely because there is nothing new to broadcast.
 * Callers that need to log the loss should consult `lostClient.isLeader`
 * separately.
 *
 * Dedup: a `peer.rehydrate` for the same `(projectId, previousLeaderHandle)`
 * is suppressed if one was emitted within `PEER_DEDUP_WINDOW_MS` (1 h).
 * `peer.lost` is not deduped — a project losing its last surviving client
 * is significant enough to emit every time the topology changes.
 */
export function detectLeaderLoss(
  lostClient: ConnectedClient,
  clients: Map<WebSocket, ConnectedClient>,
  browsers: Set<WebSocket>,
  reason: HqPeerRehydrateReason,
  eventSink?: { eventLog: HqEventEnvelope[]; persistence?: HqPersistence | undefined },
): boolean {
  if (!lostClient.isLeader) return false;
  const detectedAt = new Date().toISOString();
  // Promote a control-capable survivor before deciding which envelope to emit.
  const promotedLeaderId = promoteNewLeader(
    clients,
    lostClient.projectId,
    lostClient.ws,
    lostClient,
  );
  const hasSurvivors = promotedLeaderId !== null;
  const machineId =
    lostClient.machineId?.trim() || lostClient.project.machineId.trim() || 'unknown';
  const previousLeaderHandle = lostClient.clientId;
  // Build the envelope JSON once and fan it out to both browsers (the
  // dashboard) AND surviving same-project clients (the protocol target per
  // `packages/core/src/hq/protocol/peer.ts` and plan §10.1). Clients receive
  // it directly on their WS; the envelope shape matches the existing
  // `hq.event` wrapper used everywhere else (see `broadcastEvent` below) so
  // a future client-side `peer.*` listener can dispatch on
  // `message.event.type`.
  const seq = nextPeerEventSeq(eventSink?.eventLog);
  let envelope: HqEventEnvelope;
  if (hasSurvivors) {
    // Dedup gate: same leader handle within 1 h → suppress.
    if (checkPeerDedup(lostClient.projectId, previousLeaderHandle)) {
      return false;
    }
    const payload: HqPeerRehydratePayload = {
      projectId: lostClient.projectId,
      machineId,
      leaderClientId: lostClient.clientId,
      previousLeaderHandle,
      reason,
      detectedAt,
    };
    envelope = {
      id: `peer-${lostClient.clientId}-${Date.now()}`,
      type: 'peer.rehydrate',
      schemaVersion: HQ_PROTOCOL_VERSION,
      timestamp: detectedAt,
      clientId: HQ_BROWSER_PEER_RESUME_CLIENT_ID,
      projectId: lostClient.projectId,
      seq,
      payload,
    };
    recordPeerEmit(lostClient.projectId, previousLeaderHandle);
  } else {
    const payload: HqPeerLostPayload = {
      projectId: lostClient.projectId,
      machineId,
      leaderClientId: lostClient.clientId,
      previousLeaderHandle,
      reason,
      detectedAt,
    };
    envelope = {
      id: `peer-${lostClient.clientId}-${Date.now()}`,
      type: 'peer.lost',
      schemaVersion: HQ_PROTOCOL_VERSION,
      timestamp: detectedAt,
      clientId: HQ_BROWSER_PEER_RESUME_CLIENT_ID,
      projectId: lostClient.projectId,
      seq,
      payload,
    };
  }
  if (eventSink !== undefined) {
    eventSink.eventLog.push(envelope);
    if (eventSink.eventLog.length > MAX_EVENT_LOG) {
      eventSink.eventLog.splice(0, eventSink.eventLog.length - MAX_EVENT_LOG);
    }
    eventSink.persistence?.eventLog.append(envelope);
  }
  broadcastEvent(envelope, browsers);
  // Deliver the same envelope to every surviving same-project client on
  // its existing WS. Mirrors the kanban-delta fanout below and uses
  // `sendGuarded` for per-client backpressure. Current publishers ignore
  // unknown `hq.event` wrappers, so a future peer listener can opt in
  // without protocol churn.
  for (const [peerWs, peerClient] of clients) {
    if (peerWs === lostClient.ws) continue;
    if (peerClient.projectId !== lostClient.projectId) continue;
    sendGuarded(peerWs, JSON.stringify({ type: 'hq.event', event: envelope }));
  }
  return true;
}
