/**
 * HQ server — Inbound client event handling and Kanban fanout.
 *
 * @module hq-server/ws-client-events
 */

import type {
  HqEventEnvelope,
  HqFleetSnapshotPayload,
  HqGovernanceSnapshotPayload,
  HqKanbanSnapshotPayload,
  HqMailboxEventPayload,
  HqMailboxSnapshotPayload,
  HqMcpHealthSnapshotPayload,
  HqPersistence,
  HqRedactionPolicy,
  HqSessionEndedPayload,
  HqSessionSnapshotPayload,
  HqToken,
  HqTranscriptAppendPayload,
  HqTranscriptEntry,
} from '@wrongstack/core/hq';
import {
  HQ_TRANSCRIPT_TEXT_CAP,
  parseHqEventPayload,
  redactHqEvent,
  tightenHqRedactionPolicy,
  tokenHasCapability,
} from '@wrongstack/core/hq';
import type { WebSocket } from 'ws';
import { broadcastEvent, sendGuarded } from './snapshot.js';
import type { ConnectedClient, HqSnapshotBroadcaster, TranscriptRing } from './types.js';
import {
  agentMessageToEntry,
  agentRingKey,
  evictOldest,
  MAX_AGENT_RINGS,
  MAX_TRANSCRIPT_SESSIONS,
  TRANSCRIPT_RING_MAX,
  truncateHqSummary,
} from './utils.js';

/**
 * Server-side fanout of a `hq.kanban_snapshot` envelope after a merge.
 *
 * C2 — broadcasts the post-merge `delta` payload to every client whose
 * `projectId` matches `projectId`.
 *
 * Exported for direct unit testing in `tests/hq-kanban-fanout.test.ts`.
 */
export function fanoutKanbanDelta(
  message: string,
  clients: Map<WebSocket, ConnectedClient>,
  _browsers: Set<WebSocket>,
  projectId: string,
): { clientsNotified: number; browsersNotified: number } {
  let clientsNotified = 0;
  for (const peer of clients.values()) {
    if (peer.projectId === projectId) {
      sendGuarded(peer.ws, message);
      clientsNotified++;
    }
  }
  return { clientsNotified, browsersNotified: 0 };
}

export function handleIncomingClientEvent(
  ws: WebSocket,
  incomingEvent: HqEventEnvelope,
  clients: Map<WebSocket, ConnectedClient>,
  browsers: Set<WebSocket>,
  auth: {
    token?: HqToken | undefined;
    getOperatorPolicy: () => Partial<HqRedactionPolicy> | undefined;
  },
  snapshotBroadcaster: HqSnapshotBroadcaster,
  transcripts: Map<string, TranscriptRing>,
  agentMessages: Map<string, HqTranscriptEntry[]>,
  persistence: HqPersistence | undefined,
  persistEvent: (event: HqEventEnvelope) => void,
): void {
  const client = clients.get(ws);
  if (!client) return;
  if (incomingEvent.clientId !== client.clientId || incomingEvent.projectId !== client.projectId) {
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
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'hq.event_payload_rejected',
        eventType: incomingEvent.type,
        clientId: client.clientId,
        projectId: client.projectId,
        timestamp: new Date().toISOString(),
      }),
    );
    return;
  }
  client.lastEventSeq = incomingEvent.seq;
  client.lastSeenAt = new Date().toISOString();
  const event = redactHqEvent(
    { ...incomingEvent, payload: parsedPayload.payload },
    {
      policy: tightenHqRedactionPolicy(client.declaredRedactionPolicy, auth.getOperatorPolicy()),
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

  if (event.type === 'mailbox.snapshot') {
    const payloadResult = parseHqEventPayload(event.type, event.payload);
    if (payloadResult.ok) {
      const payload = payloadResult.payload as HqMailboxSnapshotPayload;
      client.mailboxes.set(client.projectId + ':' + payload.mailboxId, payload);
      persistEvent(event);
      snapshotBroadcaster.broadcast();
      broadcastEvent(event, browsers);
      return;
    }
    return;
  }

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

  if (event.type === 'session.snapshot') {
    const result = parseHqEventPayload(event.type, event.payload);
    if (result.ok) {
      const payload = result.payload as HqSessionSnapshotPayload;
      client.sessions.set(payload.sessionId, { payload, receivedAt: Date.now() });
      snapshotBroadcaster.broadcast();
    }
    return;
  }

  if (event.type === 'session.ended') {
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

  if (event.type === 'fleet.snapshot') {
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

  if (event.type === 'mcp.health.snapshot') {
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

  if (event.type === 'governance.snapshot') {
    if (!client.isLeader) return;
    const result = parseHqEventPayload(event.type, event.payload);
    if (result.ok) {
      const payload = result.payload as HqGovernanceSnapshotPayload;
      if (payload.projectId !== client.projectId) return;
      client.governanceSnapshot = { payload, receivedAt: Date.now() };
      snapshotBroadcaster.broadcast();
    }
    return;
  }

  if (event.type === 'session.transcript') {
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
      transcripts.delete(payload.sessionId);
      transcripts.set(payload.sessionId, ring);
      evictOldest(transcripts, MAX_TRANSCRIPT_SESSIONS);
      broadcastEvent(event, browsers);
    }
    return;
  }

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

  persistEvent(event);
  broadcastEvent(event, browsers);
}
