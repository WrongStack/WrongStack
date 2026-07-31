/**
 * HQ server — WebSocket handlers for browser and client connections.
 *
 * @module hq-server/ws
 */

import { randomUUID } from 'node:crypto';
import type {
  HqClientResumeMessage,
  HqCommandAuditLog,
  HqEventEnvelope,
  HqFleetSnapshotPayload,
  HqKanbanSnapshotPayload,
  HqMailboxEventPayload,
  HqMailboxSnapshotPayload,
  HqMcpHealthSnapshotPayload,
  HqPeerLostPayload,
  HqPeerRehydratePayload,
  HqPeerRehydrateReason,
  HqPersistence,
  HqQueuedCommand,
  HqRedactionPolicy,
  HqSessionEndedPayload,
  HqSessionSnapshotPayload,
  HqToken,
  HqTranscriptAppendPayload,
  HqTranscriptEntry,
  HqWelcomePayload,
} from '@wrongstack/core/hq';
import {
  HQ_BROWSER_PEER_RESUME_CLIENT_ID,
  HQ_PROTOCOL_VERSION,
  HQ_RESUME_GAP_MAX_BYTES,
  HQ_RESUME_GAP_MAX_ENVELOPES,
  HQ_RESUME_GAP_MAX_STALE_MS,
  HQ_TRANSCRIPT_TEXT_CAP,
  parseHqEventPayload,
  parseHqFrame,
  redactHqEvent,
  resolveHqRedactionPolicy,
  tightenHqRedactionPolicy,
  tokenHasCapability,
} from '@wrongstack/core/hq';
import { WebSocket } from 'ws';
import { broadcastCommandStatus, broadcastEvent, sendGuarded } from './snapshot.js';
import type { ConnectedClient, HqSnapshotBroadcaster, TranscriptRing } from './types.js';
import {
  agentMessageToEntry,
  agentRingKey,
  evictOldest,
  MAX_AGENT_RINGS,
  MAX_TRANSCRIPT_SESSIONS,
  recordTimeseriesSignal,
  TRANSCRIPT_RING_MAX,
  truncateHqSummary,
} from './utils.js';

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_EVENT_LOG = 5000;

/**
 * Leader tracking: the project leader is the unique client with
 * `control.receive` capability. The first client to register with that
 * capability wins (`isLeader = true`); subsequent clients with the same
 * capability are followers (`isLeader = false`). When the leader's
 * connection is lost, the next-most-recent client with `control.receive`
 * is promoted via `promoteNewLeader` (see `detectLeaderLoss`).
 */
function computeIsLeader(
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
 * Server-side fanout of a `hq.kanban_snapshot` envelope after a merge.
 *
 * C2 — broadcasts the post-merge `delta` payload to:
 *  - every client whose `projectId` matches `projectId`, and
 *  - every browser in `browsers` (browsers are not project-scoped at the
 *    WS level; the browser-side projection filters by project when it
 *    applies the snapshot).
 *
 * The `delta` payload is the same touched-only payload the merge handler
 * builds (full-set broadcasts drive V8 heap exhaustion on long-lived
 * boards — see the merge handler's comment).
 *
 * Exported for direct unit testing in `tests/hq-kanban-fanout.test.ts`.
 */
export function fanoutKanbanDelta(
  message: string,
  clients: Map<WebSocket, ConnectedClient>,
  browsers: Set<WebSocket>,
  projectId: string,
): { clientsNotified: number; browsersNotified: number } {
  let clientsNotified = 0;
  for (const peer of clients.values()) {
    if (peer.projectId === projectId) {
      sendGuarded(peer.ws, message);
      clientsNotified++;
    }
  }
  let browsersNotified = 0;
  for (const browserWs of browsers) {
    sendGuarded(browserWs, message);
    browsersNotified++;
  }
  return { clientsNotified, browsersNotified };
}

/**
 * Server-side handler for `client.resume` frames.
 *
 * Wired from `handleClient` (line 511) when the client frame type is
 * `client.resume`. The handler:
 *  - Validates identity (clientId/projectId match against the WS).
 *  - Updates `client.lastSeenAt`.
 *  - Computes the cursor (what the client has received).
 *  - Filters `eventLog` for envelopes with `clientId === client.clientId && env.seq > cursor`.
 *  - Checks the log cannot serve the gap (log_unavailable).
 *  - Checks the gap is fresh (last_seen_too_old).
 *  - Checks the gap is not too large (gap_too_large).
 *  - Sends `hq.resume_gap` on success.
 *
 * Exported for direct unit testing in `tests/hq-resume-handler.test.ts`.
 */
export function handleClientResume(
  ws: WebSocket,
  clients: Map<WebSocket, ConnectedClient>,
  eventLog: HqEventEnvelope[],
  frame: HqClientResumeMessage,
  snapshotBroadcaster?: HqSnapshotBroadcaster,
): void {
  const client = clients.get(ws);
  if (!client) return;
  // Identity check: the optional clientId/projectId on the frame must
  // match the WebSocket's registered identity, when present. Per
  // §2.5, the resume is anchored to the existing WS context if those
  // are absent.
  if (frame.clientId !== undefined && frame.clientId !== client.clientId) {
    ws.close(1008, 'resume clientId mismatch');
    return;
  }
  // For browser-kind clients the synthetic `ConnectedClient` is built with
  // `projectId: ''` (see `browserResumeClient`), but the protocol doc
  // (`@wrongstack/core/hq` `HqClientResumeMessage`) permits the frame to
  // carry an optional `projectId` hint. Browsers never use the field for
  // authorization — they subscribe to peer envelopes against the synthetic
  // bucket — so a hint mismatch is informational, not a security violation.
  // Close the socket only when a non-browser client sends a hint that
  // disagrees with its registered identity.
  if (
    client.kind !== 'browser' &&
    frame.projectId !== undefined &&
    frame.projectId !== client.projectId
  ) {
    ws.close(1008, 'resume projectId mismatch');
    return;
  }
  client.lastSeenAt = new Date().toISOString();
  // The resume cursor is what the client has received (frame.lastSeqSeen).
  // Note: `client.lastEventSeq` is the highest seq the client has
  // PUBLISHED to the server (inbound `client.event` envelopes), not what
  // it has received. Using `Math.max(frame.lastSeqSeen, client.lastEventSeq)`
  // would silently skip events when the publisher seq is ahead of the
  // received seq — that's wrong. The cursor is `frame.lastSeqSeen`.
  const cursor = frame.lastSeqSeen;
  const now = Date.now();
  // Build the matching history and missed-envelope set in one bounded pass.
  // For non-zero cursors, require the retained log to still contain the exact
  // `lastSeqSeen` envelope. That proves the cursor belongs to this server seq
  // epoch; otherwise a client-side cursor from before server restart or log
  // rotation could be misread as "caught up" and silently miss events.
  const recent: HqEventEnvelope[] = [];
  let cursorTimestamp: string | undefined;
  // The browser tracks `peer.*` envelopes under its own synthetic
  // `clientId` (browser-side `HQ_BROWSER_PEER_RESUME_CLIENT_ID`). When
  // a real publisher's resume frame collides with that id (it should
  // never — see `handleBrowser`'s `clientId` length check — but the
  // resume-loop is cheap to harden), `peer.*` envelopes are server-minted
  // lifecycle notices, not per-publisher events, so the gap-fill must
  // skip them. A browser resume against the synthetic bucket, however,
  // needs them in the gap so the dashboard can surface the peer-lifecycle
  // banner after a reconnect.
  const skipPeerEnvelopes = client.clientId !== HQ_BROWSER_PEER_RESUME_CLIENT_ID;
  for (const env of eventLog) {
    if (env.clientId !== client.clientId) continue;
    if (skipPeerEnvelopes && (env.type === 'peer.rehydrate' || env.type === 'peer.lost')) {
      continue;
    }
    if (env.seq === cursor) cursorTimestamp = env.timestamp;
    if (env.seq > cursor) {
      recent.push(env);
    }
  }
  if (cursor > 0 && cursorTimestamp === undefined) {
    if (snapshotBroadcaster !== undefined) {
      sendGuarded(ws, snapshotBroadcaster.currentSerialized());
      return;
    }
    const nowIso = new Date().toISOString();
    sendGuarded(
      ws,
      JSON.stringify({
        type: 'hq.resume_reject',
        reason: 'log_unavailable',
        detectedAt: nowIso,
      }),
    );
    return;
  }
  // Last-seen-too-old check measures the age of the reported cursor envelope,
  // not the age of the missed gap envelopes. A fresh cursor should not be
  // rejected just because low-frequency post-cursor events are old.
  const hasStale =
    cursorTimestamp !== undefined && now - Date.parse(cursorTimestamp) > HQ_RESUME_GAP_MAX_STALE_MS;
  if (hasStale) {
    const nowIso = new Date().toISOString();
    sendGuarded(
      ws,
      JSON.stringify({
        type: 'hq.resume_reject',
        reason: 'last_seen_too_old',
        detectedAt: nowIso,
      }),
    );
    return;
  }
  // Gap-too-large check: if the gap is > HQ_RESUME_GAP_MAX_ENVELOPES
  // (1000) OR if the serialized reply would exceed HQ_RESUME_GAP_MAX_BYTES
  // (1 MiB), reject. Large `session.transcript`/`agent.message` envelopes
  // can exceed the byte cap well before the count cap, so the byte check
  // has to measure the actual serialized payload rather than a per-item
  // estimate.
  let serializedByteLength = 0;
  for (const env of recent) {
    serializedByteLength += Buffer.byteLength(JSON.stringify(env), 'utf8');
    if (serializedByteLength > HQ_RESUME_GAP_MAX_BYTES) break;
  }
  const gapIsTooLarge =
    recent.length > HQ_RESUME_GAP_MAX_ENVELOPES || serializedByteLength > HQ_RESUME_GAP_MAX_BYTES;
  if (gapIsTooLarge) {
    if (snapshotBroadcaster !== undefined) {
      sendGuarded(ws, snapshotBroadcaster.currentSerialized());
      return;
    }
    const nowIso = new Date().toISOString();
    sendGuarded(
      ws,
      JSON.stringify({
        type: 'hq.resume_reject',
        reason: 'gap_too_large',
        detectedAt: nowIso,
      }),
    );
    return;
  }
  // Sort by seq ascending so the client can apply in order.
  recent.sort((a, b) => a.seq - b.seq);
  sendGuarded(
    ws,
    JSON.stringify({
      type: 'hq.resume_gap',
      lastSeqSeen: cursor,
      envelopes: recent,
      truncated: false,
    }),
  );
  return;
}

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

function browserResumeClient(ws: WebSocket, clientId: string): Map<WebSocket, ConnectedClient> {
  return new Map<WebSocket, ConnectedClient>([
    [
      ws,
      {
        ws,
        clientId,
        projectId: '',
        project: {
          projectId: '',
          projectName: '',
          projectRoot: '',
          machineId: '',
          workspaceKind: 'git',
        },
        kind: 'browser',
        connectedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        capabilities: [],
        declaredRedactionPolicy: {
          rawContent: false,
          toolArgs: 'summary',
          paths: 'project-relative',
        },
        lastEventSeq: 0,
        mailboxes: new Map(),
        sessions: new Map(),
        fleets: new Map(),
        mcpSnapshots: new Map(),
        commandQueue: [],
        isLeader: false,
      },
    ],
  ]);
}

// ── handleBrowser ──────────────────────────────────────────────────────────

export function handleBrowser(
  ws: WebSocket,
  snapshotBroadcaster: HqSnapshotBroadcaster,
  browsers: Set<WebSocket>,
  eventLog: HqEventEnvelope[],
): void {
  browsers.add(ws);

  // Per-connection error handler. An oversized inbound frame makes the `ws`
  // receiver throw (`RangeError: Max payload size exceeded`, close 1009) and
  // emit 'error' on this socket — unhandled, that crashes the whole process.
  ws.on('error', (err) => {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'hq.browser_socket_error',
        message: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      }),
    );
  });

  sendGuarded(ws, snapshotBroadcaster.currentSerialized());

  ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
    let raw: Buffer;
    if (typeof data === 'string') {
      raw = Buffer.from(data, 'utf8');
    } else if (Buffer.isBuffer(data)) {
      raw = data;
    } else if (Array.isArray(data)) {
      // The browser WS server may deliver a fragmented frame as `Buffer[]`.
      // Concatenate so JSON.parse sees the full payload instead of only the
      // head of the first fragment.
      raw = Buffer.concat(data);
    } else {
      raw = Buffer.from(new TextDecoder().decode(data as ArrayBuffer), 'utf8');
    }
    const parsed = parseHqFrame(raw);
    if (!parsed.ok) {
      const code = parsed.reason === 'invalid-json' ? 1003 : 1008;
      ws.close(code, `invalid frame: ${parsed.reason}`);
      return;
    }
    const frame = parsed.frame;
    if (frame.type !== 'client.resume') {
      ws.close(1008, 'browser frame must be client.resume');
      return;
    }
    if (frame.clientId === undefined || frame.clientId.length === 0) {
      ws.close(1008, 'browser resume requires clientId');
      return;
    }
    handleClientResume(
      ws,
      browserResumeClient(ws, frame.clientId),
      eventLog,
      frame,
      snapshotBroadcaster,
    );
  });

  ws.on('close', () => {
    browsers.delete(ws);
  });
}

// ── handleClient ───────────────────────────────────────────────────────────

export function handleClient(
  ws: WebSocket,
  clients: Map<WebSocket, ConnectedClient>,
  browsers: Set<WebSocket>,
  eventLog: HqEventEnvelope[],
  auth: {
    token?: HqToken | undefined;
    getOperatorPolicy: () => Partial<HqRedactionPolicy> | undefined;
  },
  snapshotBroadcaster: HqSnapshotBroadcaster,
  transcripts: Map<string, TranscriptRing>,
  agentMessages: Map<string, HqTranscriptEntry[]>,
  persistence?: HqPersistence,
  auditLog?: HqCommandAuditLog,
): void {
  let registered = false;

  /**
   * Record an event into both the in-memory ring and the persistent log, and
   * fold any cost/tool signal into the timeseries store. Best-effort: never
   * throws into the message handler.
   */
  function persistEvent(event: HqEventEnvelope): void {
    eventLog.push(event);
    if (eventLog.length > MAX_EVENT_LOG) eventLog.splice(0, eventLog.length - MAX_EVENT_LOG);
    if (persistence !== undefined) {
      persistence.eventLog.append(event);
      recordTimeseriesSignal(persistence, event);
    }
  }

  // Per-connection error handler. An oversized inbound frame makes the `ws`
  // receiver throw (`RangeError: Max payload size exceeded`, close 1009) and
  // emit 'error' on this socket — unhandled, that crashes the whole process.
  ws.on('error', (err) => {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'hq.client_socket_error',
        message: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      }),
    );
  });

  ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
    const raw =
      typeof data === 'string'
        ? data
        : Buffer.isBuffer(data)
          ? data
          : new TextDecoder().decode(data as ArrayBuffer);
    const parsed = parseHqFrame(raw);
    if (!parsed.ok) {
      // RFC 6455 §7.4.1: 1003 = invalid payload (not processable),
      // 1008 = policy violation (unknown type or malformed shape).
      const code = parsed.reason === 'invalid-json' ? 1003 : 1008;
      ws.close(code, `invalid frame: ${parsed.reason}`);
      return;
    }
    const frame = parsed.frame;

    if (frame.type === 'client.hello') {
      if (registered) {
        ws.close(1008, 'duplicate client.hello');
        return;
      }
      const payload = frame.payload;
      if (payload.protocolVersion !== HQ_PROTOCOL_VERSION) {
        ws.close(1008, 'protocol version mismatch');
        return;
      }

      const canPublishTelemetry =
        auth.token === undefined || tokenHasCapability(auth.token, 'telemetry.publish');
      const acceptedCapabilities = payload.capabilities.filter(
        (capability: string) => capability === 'control.receive' || canPublishTelemetry,
      );
      const declaredRedactionPolicy = resolveHqRedactionPolicy(payload.redactionPolicy);

      // A reconnect reuses the SAME clientId (the publisher identity is fixed
      // at construction), so an exact clientId match always supersedes the old
      // zombie socket. Same-process/same-kind duplicates with a DIFFERENT
      // clientId are distinct publisher instances (one process legitimately
      // holds a telemetry socket plus auxiliary mailbox sockets) — those are
      // only superseded while they hold no live session telemetry. Killing a
      // socket that is actively refreshing session snapshots would drop the
      // terminal from the fleet tree and ping-pong forever (both sides
      // auto-reconnect and re-hello), which showed up as agents/terminals
      // flapping in the HQ map.
      //
      // Capture superseded leaders BEFORE deleting them so the
      // leader-loss detector can promote a survivor and emit the
      // `peer.rehydrate` / `peer.lost` envelope. Without this, a
      // same-clientId reconnect that evicts a sitting leader would
      // leave no client with `isLeader=true` whenever a `control.receive`
      // follower is present (the new socket's `computeIsLeader` returns
      // false because the follower still owns the slot, and the follower
      // was never promoted — see `detectLeaderLoss`).
      const supersededLeaders: ConnectedClient[] = [];
      let inheritedLeader = false;
      for (const [otherWs, otherClient] of clients) {
        const sameClientId = otherClient.clientId === payload.client.clientId;
        const samePublisher =
          otherClient.projectId === payload.project.projectId &&
          otherClient.kind === payload.client.kind &&
          otherClient.pid !== undefined &&
          payload.client.pid !== undefined &&
          otherClient.pid === payload.client.pid &&
          (otherClient.machineId || otherClient.project.machineId) ===
            (payload.client.machineId || payload.project.machineId);
        if (
          otherWs !== ws &&
          (sameClientId || (samePublisher && otherClient.sessions.size === 0))
        ) {
          if (otherClient.isLeader) {
            if (sameClientId) inheritedLeader = true;
            else supersededLeaders.push(otherClient);
          }
          clients.delete(otherWs);
          otherWs.close(4001, 'superseded by a newer HQ connection');
        }
      }

      const client: ConnectedClient = {
        ws,
        clientId: payload.client.clientId,
        projectId: payload.project.projectId,
        project: payload.project,
        kind: payload.client.kind,
        connectedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        ...(payload.client.hostname ? { hostname: payload.client.hostname } : {}),
        ...(payload.client.pid ? { pid: payload.client.pid } : {}),
        ...(payload.client.version ? { version: payload.client.version } : {}),
        capabilities: acceptedCapabilities,
        ...(auth.token !== undefined ? { authToken: auth.token } : {}),
        declaredRedactionPolicy,
        lastEventSeq: 0,
        mailboxes: new Map(),
        machineId: payload.client.machineId || payload.project.machineId,
        sessions: new Map(),
        fleets: new Map(),
        mcpSnapshots: new Map(),
        commandQueue: [],
        // Leader for the project is the unique client with `control.receive`
        // capability. First such client wins; subsequent clients with the
        // capability are followers. Same-clientId reconnects inherit this
        // flag from the superseded socket because that identity never really
        // disappeared; different-client supersedes still use the loss detector.
        isLeader:
          inheritedLeader ||
          computeIsLeader(clients, payload.project.projectId, acceptedCapabilities),
      };
      clients.set(ws, client);
      registered = true;

      // Run the leader-loss detector for each superseded leader. This
      // promotes the most-recent surviving `control.receive` client (if
      // any) and emits `peer.rehydrate` / `peer.lost` so browsers and
      // other same-project clients learn the topology changed. Without
      // this call a same-clientId reconnect that evicts a sitting leader
      // would leave the project with `isLeader=false` everywhere.
      for (const lostLeader of supersededLeaders) {
        detectLeaderLoss(lostLeader, clients, browsers, 'crash', { eventLog, persistence });
      }

      // Server-to-client acknowledgement: the client learns which capabilities
      // the server accepted and the active redaction policy. Command delivery
      // happens later over `client.command_poll` frames on this same socket.
      const welcome: HqWelcomePayload = {
        type: 'hq.welcome',
        protocolVersion: HQ_PROTOCOL_VERSION,
        serverTime: new Date().toISOString(),
        acceptedCapabilities,
        // The operator-configured override (from <dataDir>/auth.json) wins
        // over the default. The client learns the *effective* policy.
        redactionPolicy: tightenHqRedactionPolicy(
          declaredRedactionPolicy,
          auth.getOperatorPolicy(),
        ),
      };
      ws.send(JSON.stringify(welcome));
      if (persistence !== undefined) {
        void persistence.kanban
          .load(client.projectId)
          .then((payload) => {
            sendGuarded(ws, JSON.stringify({ type: 'hq.kanban_snapshot', payload }));
          })
          .catch(() => undefined);
      }

      const event: HqEventEnvelope = {
        id: randomUUID(),
        type: 'client.hello',
        schemaVersion: HQ_PROTOCOL_VERSION,
        timestamp: new Date().toISOString(),
        clientId: payload.client.clientId,
        projectId: payload.project.projectId,
        seq: 0,
        payload: { client: payload.client, project: payload.project },
      };
      persistEvent(event);
      snapshotBroadcaster.broadcast();
      broadcastEvent(event, browsers);
      return;
    }

    if (!registered) return;

    // ── Phase 3 control plane: client polls for commands & acks them ──────
    // The client SDK (HqPublisher) polls every ~500ms with an `afterCommandId`
    // cursor; we drain the per-client queue back to it as a `hq.command_batch`.
    if (frame.type === 'client.command_poll') {
      const client = clients.get(ws);
      if (client) {
        if (frame.clientId !== client.clientId || frame.projectId !== client.projectId) {
          ws.close(1008, 'command poll identity mismatch');
          return;
        }
        client.lastSeenAt = new Date().toISOString();
        const afterId = frame.afterCommandId;
        const limit = frame.limit ?? 25;
        let toSend: HqQueuedCommand[];
        if (afterId === undefined) {
          toSend = client.commandQueue.slice(0, limit);
        } else {
          const idx = client.commandQueue.findIndex((c) => c.commandId === afterId);
          toSend = (idx >= 0 ? client.commandQueue.slice(idx + 1) : client.commandQueue).slice(
            0,
            limit,
          );
        }
        if (toSend.length > 0) {
          const batch = JSON.stringify({ type: 'hq.command_batch', commands: toSend });
          if (ws.readyState === WebSocket.OPEN) ws.send(batch);
          for (const cmd of toSend) {
            auditLog?.update(cmd.commandId, { status: 'delivered' });
            const updated = auditLog?.get(cmd.commandId);
            if (updated !== undefined) broadcastCommandStatus(updated, browsers);
          }
        }
      }
      return;
    }

    if (frame.type === 'client.command_ack') {
      const client = clients.get(ws);
      if (client) {
        if (frame.clientId !== client.clientId || frame.projectId !== client.projectId) {
          ws.close(1008, 'command ack identity mismatch');
          return;
        }
        client.lastSeenAt = new Date().toISOString();
      }
      if (client) {
        const updated = auditLog?.updateForClient(frame.commandId, client.clientId, {
          status: 'acked',
          ackStatus: frame.status,
          ...(frame.message !== undefined ? { ackMessage: frame.message } : {}),
          ackedAt: new Date().toISOString(),
        });
        if (updated === true) {
          const entry = auditLog?.get(frame.commandId);
          if (entry !== undefined) broadcastCommandStatus(entry, browsers);
        }
      }
      return;
    }

    if (frame.type === 'client.resume') {
      handleClientResume(ws, clients, eventLog, frame, snapshotBroadcaster);
      return;
    }

    if (frame.type === 'client.event') {
      const client = clients.get(ws);
      if (!client) return;
      const incomingEvent = frame.event;
      if (
        incomingEvent.clientId !== client.clientId ||
        incomingEvent.projectId !== client.projectId
      ) {
        ws.close(1008, 'event identity mismatch');
        return;
      }
      if (!tokenHasCapability(client.authToken, 'telemetry.publish') && auth.token !== undefined) {
        ws.close(1008, 'client token lacks telemetry.publish capability');
        return;
      }
      if (incomingEvent.seq <= client.lastEventSeq) {
        ws.close(1008, 'event sequence must increase monotonically');
        return;
      }
      const parsedPayload = parseHqEventPayload(incomingEvent.type, incomingEvent.payload);
      if (!parsedPayload.ok) {
        // A single malformed telemetry payload must not take down an otherwise
        // healthy publisher connection. Drop it before sequence advancement;
        // identity/auth violations above still close the socket.
        return;
      }
      client.lastEventSeq = incomingEvent.seq;
      client.lastSeenAt = new Date().toISOString();
      const event = redactHqEvent(
        { ...incomingEvent, payload: parsedPayload.payload },
        {
          policy: tightenHqRedactionPolicy(
            client.declaredRedactionPolicy,
            auth.getOperatorPolicy(),
          ),
          projectRoot: client.project.projectRoot,
          // Chat-transcript events carry full turns — the generic 500-char
          // summary cap would truncate them a second time after the
          // publisher already applied the transcript cap.
          ...(incomingEvent.type === 'session.transcript' || incomingEvent.type === 'agent.message'
            ? { maxSummaryLength: HQ_TRANSCRIPT_TEXT_CAP }
            : {}),
        },
      ).value;

      if (event.type === 'client.heartbeat') {
        return;
      }

      if (event.type === 'kanban.snapshot') {
        const payload = event.payload as HqKanbanSnapshotPayload;
        if (payload.projectId !== client.projectId || persistence === undefined) return;
        void persistence.kanban
          .merge(payload)
          .then((merged) => {
            // Broadcast only the post-merge authoritative records for the
            // boards this delta touched — NEVER the full merged project set.
            // A project accumulates thousands of boards (run mirrors), so the
            // full set grows into multi-MB JSON; re-broadcasting it to every
            // same-project client on every delta was a broadcast storm that
            // drove connected TUIs into V8 heap exhaustion. Clients apply
            // snapshots per-record by revision, so a touched-only payload is
            // semantically identical; the full set still goes out once per
            // connection at hello time.
            const touched = new Set<string>();
            for (const record of payload.boards) touched.add(record.boardId);
            for (const record of payload.tombstones) touched.add(record.boardId);
            const delta: HqKanbanSnapshotPayload = {
              projectId: merged.projectId,
              generatedAt: merged.generatedAt,
              boards: merged.boards.filter((record) => touched.has(record.boardId)),
              tombstones: merged.tombstones.filter((record) => touched.has(record.boardId)),
            };
            const message = JSON.stringify({ type: 'hq.kanban_snapshot', payload: delta });
            fanoutKanbanDelta(message, clients, browsers, client.projectId);
          })
          .catch((error: unknown) => {
            console.warn(
              JSON.stringify({
                level: 'warn',
                event: 'hq.kanban_merge_failed',
                message: error instanceof Error ? error.message : String(error),
                timestamp: new Date().toISOString(),
              }),
            );
          });
        persistEvent(event);
        broadcastEvent(event, browsers);
        return;
      }

      // Mailbox snapshots are authoritative rollups — adopt them into the
      // per-client mailbox map and re-broadcast the global snapshot so the
      // browser counters reflect the latest rollup. We validate the
      // payload via `parseHqEventPayload` so a malformed snapshot cannot
      // poison the per-client mailbox map; other event types are not
      // validated yet and pass through unchanged.
      if (event.type === 'mailbox.snapshot' && client !== undefined) {
        const payloadResult = parseHqEventPayload(event.type, event.payload);
        if (payloadResult.ok) {
          const payload = payloadResult.payload as HqMailboxSnapshotPayload;
          client.mailboxes.set(client.projectId + ':' + payload.mailboxId, payload);
          persistEvent(event);
          snapshotBroadcaster.broadcast();
          broadcastEvent(event, browsers);
          return;
        }
        // Malformed mailbox.snapshot: drop without logging or broadcasting so
        // it cannot poison the per-client mailbox map.
        return;
      }

      // Mailbox events are transient — validate the payload so a malformed
      // envelope cannot leak garbage to the browser live feed, and truncate
      // the optional `summary` preview before storing it in the event log and
      // broadcasting to browsers.
      if (event.type === 'mailbox.event') {
        const payloadResult = parseHqEventPayload(event.type, event.payload);
        if (!payloadResult.ok) {
          return;
        }
        const payload = payloadResult.payload as HqMailboxEventPayload;
        const sanitizedSummary = truncateHqSummary(payload.summary, 280);
        const sanitizedEvent =
          sanitizedSummary === undefined
            ? event
            : { ...event, payload: { ...payload, summary: sanitizedSummary } };
        persistEvent(sanitizedEvent);
        broadcastEvent(sanitizedEvent, browsers);
        return;
      }

      // ── Session telemetry — the spine of the fleet tree ────────────────
      if (event.type === 'session.snapshot' && client !== undefined) {
        const result = parseHqEventPayload(event.type, event.payload);
        if (result.ok) {
          const payload = result.payload as HqSessionSnapshotPayload;
          client.sessions.set(payload.sessionId, { payload, receivedAt: Date.now() });
          snapshotBroadcaster.broadcast();
        }
        return;
      }

      if (event.type === 'session.ended' && client !== undefined) {
        const result = parseHqEventPayload(event.type, event.payload);
        if (result.ok) {
          const payload = result.payload as HqSessionEndedPayload;
          client.sessions.delete(payload.sessionId);
          client.mcpSnapshots.delete(payload.sessionId);
          for (const [runId, fleet] of client.fleets) {
            if (fleet.sessionId === payload.sessionId) client.fleets.delete(runId);
          }
          snapshotBroadcaster.broadcast();
        }
        return;
      }

      // Fleet snapshots — authoritative coordinator rollups. Store per
      // (client, runId) so buildSnapshot can populate fleets[] the same way
      // it folds sessions. Validate via parseHqEventPayload so a malformed
      // snapshot cannot poison the map.
      if (event.type === 'fleet.snapshot' && client !== undefined) {
        const result = parseHqEventPayload(event.type, event.payload);
        if (result.ok) {
          const payload = result.payload as HqFleetSnapshotPayload;
          client.fleets.set(payload.runId, {
            payload,
            ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
            receivedAt: Date.now(),
          });
          snapshotBroadcaster.broadcast();
        }
        return;
      }

      // MCP health snapshots — authoritative per-session rollups. Store per
      // (client, sessionId) so buildSnapshot can populate mcpServers[].
      if (event.type === 'mcp.health.snapshot' && client !== undefined) {
        const result = parseHqEventPayload(event.type, event.payload);
        if (result.ok) {
          const payload = result.payload as HqMcpHealthSnapshotPayload;
          const sessionId = event.sessionId || 'unknown';
          const stamped = payload.servers.map((s) => ({
            ...s,
            projectId: client.projectId,
            clientId: client.clientId,
          }));
          client.mcpSnapshots.set(sessionId, { servers: stamped, receivedAt: Date.now() });
          snapshotBroadcaster.broadcast();
        }
        return;
      }

      if (event.type === 'session.transcript' && client !== undefined) {
        const result = parseHqEventPayload(event.type, event.payload);
        if (result.ok) {
          const payload = result.payload as HqTranscriptAppendPayload;
          let ring = transcripts.get(payload.sessionId);
          if (!ring) {
            ring = { entries: [], ...(client.machineId ? { machineId: client.machineId } : {}) };
          }
          for (const entry of payload.entries) ring.entries.push(entry);
          if (ring.entries.length > TRANSCRIPT_RING_MAX) {
            ring.entries.splice(0, ring.entries.length - TRANSCRIPT_RING_MAX);
          }
          // Re-insert to keep LRU order, then bound the number of sessions kept.
          transcripts.delete(payload.sessionId);
          transcripts.set(payload.sessionId, ring);
          evictOldest(transcripts, MAX_TRANSCRIPT_SESSIONS);
          // Forward to browsers so an open history pane streams live.
          broadcastEvent(event, browsers);
        }
        return;
      }

      // Subagent conversation — buffer per (sessionId, subagentId) so
      // late-connecting browsers (incl. on other machines) can replay the
      // full history. Scoping by session is essential: every session's
      // leader uses the default id 'leader', so a bare-subId key would merge
      // every leader's transcript into one shared ring.
      if (event.type === 'agent.message') {
        const p = event.payload as Record<string, unknown> | undefined;
        const subId =
          p && typeof p['subagentId'] === 'string' ? (p['subagentId'] as string) : undefined;
        if (subId) {
          const key = agentRingKey(event.sessionId, subId);
          let ring = agentMessages.get(key);
          if (!ring) ring = [];
          ring.push(agentMessageToEntry(p as Record<string, unknown>));
          if (ring.length > TRANSCRIPT_RING_MAX) ring.splice(0, ring.length - TRANSCRIPT_RING_MAX);
          agentMessages.delete(key);
          agentMessages.set(key, ring);
          evictOldest(agentMessages, MAX_AGENT_RINGS);
        }
        persistEvent(event);
        broadcastEvent(event, browsers);
        return;
      }

      // Other event types pass through unchanged.
      persistEvent(event);
      broadcastEvent(event, browsers);
    }
  });

  ws.on('close', () => {
    // Capture the lost client before deletion so the leader-deposed
    // detector can decide whether to emit `peer.rehydrate` / `peer.lost`.
    const lostClient = clients.get(ws);
    clients.delete(ws);
    if (lostClient) {
      detectLeaderLoss(lostClient, clients, browsers, 'graceful', { eventLog, persistence });
    }
    snapshotBroadcaster.broadcast();
  });
}
