/**
 * HQ server — WebSocket handlers for browser and client connections.
 *
 * @module hq-server/ws
 */

import { randomUUID } from 'node:crypto';
import type {
  HqCommandAuditLog,
  HqEventEnvelope,
  HqPersistence,
  HqQueuedCommand,
  HqRedactionPolicy,
  HqToken,
  HqTranscriptEntry,
  HqWelcomePayload,
} from '@wrongstack/core/hq';
import {
  HQ_PROTOCOL_VERSION,
  parseHqFrame,
  resolveHqRedactionPolicy,
  tightenHqRedactionPolicy,
  tokenHasCapability,
} from '@wrongstack/core/hq';
import { WebSocket } from 'ws';
import { broadcastCommandStatus, broadcastEvent, sendGuarded } from './snapshot.js';
import type { ConnectedClient, HqSnapshotBroadcaster, TranscriptRing } from './types.js';
import { recordTimeseriesSignal } from './utils.js';
import { handleIncomingClientEvent } from './ws-client-events.js';
import { computeIsLeader, detectLeaderLoss } from './ws-leader.js';
import { browserResumeClient, handleClientResume } from './ws-resume.js';

// ── Re-exports for backward compat and testing ────────────────────────────

export { fanoutKanbanDelta } from './ws-client-events.js';
export { detectLeaderLoss } from './ws-leader.js';
export { handleClientResume } from './ws-resume.js';

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_EVENT_LOG = 5000;

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

/**
 * Resolve every command the disconnecting client never picked up.
 *
 * The queue lives on the per-socket `ConnectedClient`, so it dies with the
 * socket: a command enqueued in the window between the operator's dispatch and
 * the next 500 ms `command_poll` is simply gone, and nothing re-queues it on
 * the replacement connection. Left alone, its audit row stayed `queued`
 * forever — the Control rail showed a command as pending that will never run,
 * which is the one thing an operator must not have to guess about.
 *
 * `status: 'queued'` in the audit log is the exact undelivered set: the poll
 * handler flips a command to `delivered` the moment it is put on the wire, so
 * anything still `queued` never reached the client. Delivered-but-unacked
 * commands are deliberately left alone — those DID run, and the ack may simply
 * have been in flight when the socket closed.
 */
function failUndeliveredCommands(
  lostClient: ConnectedClient,
  browsers: Set<WebSocket>,
  auditLog: HqCommandAuditLog | undefined,
): void {
  if (auditLog === undefined || lostClient.commandQueue.length === 0) return;
  const disconnectedAt = new Date().toISOString();
  for (const queued of lostClient.commandQueue) {
    if (auditLog.get(queued.commandId)?.status !== 'queued') continue;
    const updated = auditLog.updateForClient(queued.commandId, lostClient.clientId, {
      status: 'acked',
      ackStatus: 'failed',
      ackMessage: 'client disconnected before the command was delivered',
      ackedAt: disconnectedAt,
    });
    if (!updated) continue;
    const entry = auditLog.get(queued.commandId);
    if (entry !== undefined) broadcastCommandStatus(entry, browsers);
  }
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

      const supersededLeaders: ConnectedClient[] = [];
      let inheritedLeader = false;
      // One process legitimately holds SEVERAL publisher sockets: the session
      // telemetry one and the mailbox-attach one. They share pid, kind,
      // project and machine, so `samePublisher` alone cannot tell "the same
      // terminal reconnected and left a zombie socket" from "a sibling role on
      // the same process". `session.summary` is what separates the two
      // classes: a terminal surface declares it, an auxiliary socket
      // deliberately does not (see the capability comment in mailbox-attach).
      //
      // Superseding is confined to one class. Across classes it was pure
      // damage: the mailbox socket is sessionless BY DESIGN, so it was
      // eligible forever and got closed on every telemetry hello — and its
      // reconnect could land inside the telemetry client's own post-hello
      // window and close THAT one back. Every such reconnect wipes the
      // server's per-socket session state, which is what made terminals blink
      // off the fleet map.
      const isSessionSurface = acceptedCapabilities.includes('session.summary');
      for (const [otherWs, otherClient] of clients) {
        const sameClientId = otherClient.clientId === payload.client.clientId;
        const samePublisher =
          otherClient.projectId === payload.project.projectId &&
          otherClient.kind === payload.client.kind &&
          otherClient.pid !== undefined &&
          payload.client.pid !== undefined &&
          otherClient.pid === payload.client.pid &&
          (otherClient.machineId || otherClient.project.machineId) ===
            (payload.client.machineId || payload.project.machineId) &&
          isSessionSurface === otherClient.capabilities.includes('session.summary');
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
        isLeader:
          inheritedLeader ||
          computeIsLeader(clients, payload.project.projectId, acceptedCapabilities),
      };
      clients.set(ws, client);
      registered = true;

      for (const lostLeader of supersededLeaders) {
        detectLeaderLoss(lostLeader, clients, browsers, 'crash', { eventLog, persistence });
      }

      const welcome: HqWelcomePayload = {
        type: 'hq.welcome',
        protocolVersion: HQ_PROTOCOL_VERSION,
        serverTime: new Date().toISOString(),
        acceptedCapabilities,
        redactionPolicy: tightenHqRedactionPolicy(
          declaredRedactionPolicy,
          auth.getOperatorPolicy(),
        ),
      };
      ws.send(JSON.stringify(welcome));
      if (persistence !== undefined) {
        void persistence.kanban
          .load(client.projectId)
          .then((p) => {
            sendGuarded(ws, JSON.stringify({ type: 'hq.kanban_snapshot', payload: p }));
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
      handleIncomingClientEvent(
        ws,
        frame.event,
        clients,
        browsers,
        auth,
        snapshotBroadcaster,
        transcripts,
        agentMessages,
        persistence,
        persistEvent,
      );
    }
  });

  ws.on('close', () => {
    const lostClient = clients.get(ws);
    clients.delete(ws);
    if (lostClient) {
      failUndeliveredCommands(lostClient, browsers, auditLog);
      detectLeaderLoss(lostClient, clients, browsers, 'graceful', { eventLog, persistence });
    }
    snapshotBroadcaster.broadcast();
  });
}
