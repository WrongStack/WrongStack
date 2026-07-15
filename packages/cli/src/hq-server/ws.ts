/**
 * HQ server — WebSocket handlers for browser and client connections.
 *
 * @module hq-server/ws
 */

import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import {
  HQ_PROTOCOL_VERSION,
  HQ_TRANSCRIPT_TEXT_CAP,
  parseHqEventPayload,
  parseHqFrame,
  redactHqEvent,
  resolveHqRedactionPolicy,
  tightenHqRedactionPolicy,
  tokenHasCapability,
  type HqCommandAuditLog,
  type HqEventEnvelope,
  type HqFleetSnapshotPayload,
  type HqMailboxEventPayload,
  type HqMailboxSnapshotPayload,
  type HqMcpHealthSnapshotPayload,
  type HqPersistence,
  type HqQueuedCommand,
  type HqRedactionPolicy,
  type HqSessionEndedPayload,
  type HqSessionSnapshotPayload,
  type HqToken,
  type HqTranscriptAppendPayload,
  type HqTranscriptEntry,
  type HqWelcomePayload,
} from '@wrongstack/core';
import type { ConnectedClient, HqSnapshotBroadcaster, TranscriptRing } from './types.js';
import {
  TRANSCRIPT_RING_MAX,
  MAX_TRANSCRIPT_SESSIONS,
  MAX_AGENT_RINGS,
  agentMessageToEntry,
  agentRingKey,
  evictOldest,
  recordTimeseriesSignal,
  truncateHqSummary,
} from './utils.js';
import { broadcastEvent } from './snapshot.js';

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_EVENT_LOG = 5000;

// ── handleBrowser ──────────────────────────────────────────────────────────

export function handleBrowser(
  ws: WebSocket,
  snapshotBroadcaster: HqSnapshotBroadcaster,
  browsers: Set<WebSocket>,
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

  ws.send(snapshotBroadcaster.currentSerialized());

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
      for (const [otherWs, otherClient] of clients) {
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
          (otherClient.clientId === payload.client.clientId ||
            (samePublisher && otherClient.sessions.size === 0))
        ) {
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
      };
      clients.set(ws, client);
      registered = true;

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
    // The client SDK (HqPublisher) polls every ~2s with an `afterCommandId`
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
        auditLog?.updateForClient(frame.commandId, client.clientId, {
          status: 'acked',
          ackStatus: frame.status,
          ...(frame.message !== undefined ? { ackMessage: frame.message } : {}),
          ackedAt: new Date().toISOString(),
        });
      }
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
          client.mcpSnapshots.set(sessionId, stamped);
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
        const subId = p && typeof p['subagentId'] === 'string' ? (p['subagentId'] as string) : undefined;
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
    clients.delete(ws);
    snapshotBroadcaster.broadcast();
  });
}
