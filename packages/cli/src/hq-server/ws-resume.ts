/**
 * HQ server — Client resume protocol handler.
 *
 * @module hq-server/ws-resume
 */

import type { HqClientResumeMessage, HqEventEnvelope } from '@wrongstack/core/hq';
import {
  HQ_BROWSER_PEER_RESUME_CLIENT_ID,
  HQ_RESUME_GAP_MAX_BYTES,
  HQ_RESUME_GAP_MAX_ENVELOPES,
  HQ_RESUME_GAP_MAX_STALE_MS,
} from '@wrongstack/core/hq';
import type { WebSocket } from 'ws';
import { sendGuarded } from './snapshot.js';
import type { ConnectedClient, HqSnapshotBroadcaster } from './types.js';

export function browserResumeClient(
  ws: WebSocket,
  clientId: string,
): Map<WebSocket, ConnectedClient> {
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

/**
 * Server-side handler for `client.resume` frames.
 *
 * Wired from `handleClient` when the client frame type is `client.resume`.
 * The handler:
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
}
