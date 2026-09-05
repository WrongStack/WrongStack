/**
 * Tests for the `handleClientResume` server-side handler in
 * `packages/cli/src/hq-server/ws.ts`.
 *
 * Covers four paths:
 *  1. Gap-fill: server emits `hq.resume_gap` with bounded envelopes.
 *  2. Gap-reject (gap_too_large): gap > 1000 envelopes → `hq.resume_reject`.
 *  3. Log-unavailable: no envelopes at or below cursor → `hq.resume_reject`.
 *  4. Cursor=0: client first connects, no gap → `hq.resume_gap` with empty list.
 */

import type { HqClientResumeMessage, HqEventEnvelope } from '@wrongstack/core/hq';
import { HQ_PROTOCOL_VERSION } from '@wrongstack/core/hq';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { ConnectedClient } from '../src/hq-server/types.js';
import { handleBrowser, handleClientResume } from '../src/hq-server/ws.js';

const HQ_BROWSER_PEER_RESUME_CLIENT_ID = '__hq_peer__';

/** Minimal WebSocket stub that captures `send` calls. */
function makeFakeWs() {
  const sent: string[] = [];
  const closed: { code: number | undefined; reason: string | undefined } = {
    code: undefined,
    reason: undefined,
  };
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const ws = {
    readyState: 1, // OPEN
    send: vi.fn((data: string) => sent.push(data)),
    close: vi.fn((code?: number, reason?: string) => {
      closed.code = code;
      closed.reason = reason;
    }),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
    }),
  };
  return { ws: ws as unknown as WebSocket, sent, closed, handlers };
}

function makeClient(overrides: Partial<ConnectedClient> = {}): ConnectedClient {
  return {
    clientId: 'c1',
    projectId: 'p1',
    project: {
      projectId: 'p1',
      projectName: 'Test',
      projectRoot: '/test',
      machineId: 'm1',
      workspaceKind: 'git',
    },
    kind: 'tui',
    connectedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    capabilities: ['control.receive'],
    declaredRedactionPolicy: {
      rawContent: false,
      toolArgs: 'summary',
      paths: 'project-relative',
    },
    lastEventSeq: 0,
    mailboxes: new Map(),
    machineId: 'm1',
    sessions: new Map(),
    fleets: new Map(),
    mcpSnapshots: new Map(),
    commandQueue: [],
    isLeader: false,
    ...overrides,
  } as ConnectedClient;
}

function makeEnvelope(seq: number, timestamp: string): HqEventEnvelope {
  return {
    id: `e-${seq}`,
    type: 'session.usage',
    schemaVersion: HQ_PROTOCOL_VERSION,
    timestamp,
    clientId: 'c1',
    projectId: 'p1',
    seq,
    payload: {},
  };
}

function makeFrame(lastSeqSeen: number): HqClientResumeMessage {
  return { type: 'client.resume', lastSeqSeen };
}

describe('handleClientResume', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  // ── 1. Gap-fill path ──────────────────────────────────────────────────

  it('emits hq.resume_gap with the missed envelopes when the log has the cursor anchor', () => {
    const { ws, sent } = makeFakeWs();
    const client = makeClient();
    const clients = new Map<WebSocket, ConnectedClient>([[ws, client]]);
    // Log has the reported cursor at seq 1 plus missed envelopes at seq 2 and 3.
    const now = new Date().toISOString();
    const eventLog: HqEventEnvelope[] = [
      makeEnvelope(1, now),
      makeEnvelope(2, now),
      makeEnvelope(3, now),
    ];
    const frame = makeFrame(1);

    handleClientResume(ws, clients, eventLog, frame);

    expect(sent).toHaveLength(1);
    const reply = JSON.parse(sent[0]!);
    expect(reply.type).toBe('hq.resume_gap');
    expect(reply.lastSeqSeen).toBe(1);
    expect(reply.envelopes).toHaveLength(2);
    expect(reply.envelopes.map((e: HqEventEnvelope) => e.seq)).toEqual([2, 3]);
    expect(reply.truncated).toBe(false);
  });

  // ── 2. Gap-reject path (gap_too_large) ─────────────────────────────────

  it('emits hq.resume_reject { reason: gap_too_large } when the serialized gap exceeds the byte cap', () => {
    const { ws, sent } = makeFakeWs();
    const client = makeClient();
    const clients = new Map<WebSocket, ConnectedClient>([[ws, client]]);
    const now = new Date().toISOString();
    const eventLog: HqEventEnvelope[] = [
      makeEnvelope(1, now),
      {
        ...makeEnvelope(2, now),
        payload: { text: 'x'.repeat(1_048_576) },
      },
    ];
    const frame = makeFrame(1);

    handleClientResume(ws, clients, eventLog, frame);

    expect(sent).toHaveLength(1);
    const reply = JSON.parse(sent[0]!);
    expect(reply.type).toBe('hq.resume_reject');
    expect(reply.reason).toBe('gap_too_large');
  });

  it('emits hq.resume_reject { reason: gap_too_large } when the gap is > 1000', () => {
    const { ws, sent } = makeFakeWs();
    const client = makeClient();
    const clients = new Map<WebSocket, ConnectedClient>([[ws, client]]);
    // Build a log with 1001 envelopes.
    const now = new Date().toISOString();
    const eventLog: HqEventEnvelope[] = Array.from({ length: 1001 }, (_, i) =>
      makeEnvelope(i + 1, now),
    );
    const frame = makeFrame(0);

    handleClientResume(ws, clients, eventLog, frame);

    expect(sent).toHaveLength(1);
    const reply = JSON.parse(sent[0]!);
    expect(reply.type).toBe('hq.resume_reject');
    expect(reply.reason).toBe('gap_too_large');
  });

  // ── 3. Log-unavailable path ───────────────────────────────────────────

  it('emits hq.resume_reject { reason: log_unavailable } when the log has no history for this client', () => {
    const { ws, sent } = makeFakeWs();
    const client = makeClient();
    const clients = new Map<WebSocket, ConnectedClient>([[ws, client]]);
    // Log has NO envelopes for c1 — caller asks for seq 50. We can't
    // serve the gap because we have zero history for this client.
    const now = new Date().toISOString();
    const eventLog: HqEventEnvelope[] = [{ ...makeEnvelope(100, now), clientId: 'other' }];
    const frame = makeFrame(50);

    handleClientResume(ws, clients, eventLog, frame);

    expect(sent).toHaveLength(1);
    const reply = JSON.parse(sent[0]!);
    expect(reply.type).toBe('hq.resume_reject');
    expect(reply.reason).toBe('log_unavailable');
  });

  // ── 3b. Partial fill: log has post-cursor envelopes but no pre-cursor ──

  it('rejects resume when the log has post-cursor envelopes but not the cursor anchor', () => {
    const { ws, sent } = makeFakeWs();
    const client = makeClient();
    const clients = new Map<WebSocket, ConnectedClient>([[ws, client]]);
    // Log has only seq 100 for c1 — no seq 50 cursor anchor. This can happen
    // after log rotation or server restart, so the client must snapshot instead
    // of treating seq 100 as a safe partial fill.
    const now = new Date().toISOString();
    const eventLog: HqEventEnvelope[] = [makeEnvelope(100, now)];
    const frame = makeFrame(50);

    handleClientResume(ws, clients, eventLog, frame);

    expect(sent).toHaveLength(1);
    const reply = JSON.parse(sent[0]!);
    expect(reply.type).toBe('hq.resume_reject');
    expect(reply.reason).toBe('log_unavailable');
  });

  // ── 3c. Cursor seq the log never held (broadcast-only event types) ────

  it('gap-fills when the cursor seq itself was never logged', () => {
    const { ws, sent } = makeFakeWs();
    const client = makeClient();
    const clients = new Map<WebSocket, ConnectedClient>([[ws, client]]);
    // `session.transcript` is broadcast to browsers but never appended to
    // `eventLog`, while the browser's cursor advances on EVERY applied
    // envelope. So on an active session the reported cursor routinely names a
    // seq the log has never held. Requiring that exact envelope rejected every
    // reconnect and dropped the tool/mailbox/brain envelopes in the gap; the
    // anchor only has to prove the log SPANS the cursor.
    const now = new Date().toISOString();
    const eventLog: HqEventEnvelope[] = [makeEnvelope(40, now), makeEnvelope(60, now)];
    const frame = makeFrame(50);

    handleClientResume(ws, clients, eventLog, frame);

    expect(sent).toHaveLength(1);
    const reply = JSON.parse(sent[0]!);
    expect(reply.type).toBe('hq.resume_gap');
    expect(reply.envelopes.map((e: HqEventEnvelope) => e.seq)).toEqual([60]);
  });

  it('anchors on client.hello (seq 0) after a reconnect', () => {
    const { ws, sent } = makeFakeWs();
    const client = makeClient();
    const clients = new Map<WebSocket, ConnectedClient>([[ws, client]]);
    // A reconnecting publisher keeps its seq counter, so the fresh log holds
    // the seq-0 hello plus everything after — enough to serve the gap.
    const now = new Date().toISOString();
    const eventLog: HqEventEnvelope[] = [
      makeEnvelope(0, now),
      makeEnvelope(501, now),
      makeEnvelope(502, now),
    ];
    const frame = makeFrame(500);

    handleClientResume(ws, clients, eventLog, frame);

    const reply = JSON.parse(sent[0]!);
    expect(reply.type).toBe('hq.resume_gap');
    expect(reply.envelopes.map((e: HqEventEnvelope) => e.seq)).toEqual([501, 502]);
  });

  // ── 4. cursor=0 (no gap) ──────────────────────────────────────────────

  it('emits hq.resume_gap with empty envelopes when cursor is 0 and log is empty', () => {
    const { ws, sent } = makeFakeWs();
    const client = makeClient();
    const clients = new Map<WebSocket, ConnectedClient>([[ws, client]]);
    const eventLog: HqEventEnvelope[] = [];
    const frame = makeFrame(0);

    handleClientResume(ws, clients, eventLog, frame);

    expect(sent).toHaveLength(1);
    const reply = JSON.parse(sent[0]!);
    expect(reply.type).toBe('hq.resume_gap');
    expect(reply.lastSeqSeen).toBe(0);
    expect(reply.envelopes).toEqual([]);
    expect(reply.truncated).toBe(false);
  });

  // ── 5. cursor age (last_seen_too_old) ─────────────────────────────────

  it('emits hq.resume_reject { reason: last_seen_too_old } when the cursor envelope is > 24 h old', () => {
    const { ws, sent } = makeFakeWs();
    const client = makeClient();
    const clients = new Map<WebSocket, ConnectedClient>([[ws, client]]);
    const longAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();
    const eventLog: HqEventEnvelope[] = [makeEnvelope(1, longAgo), makeEnvelope(2, now)];
    const frame = makeFrame(1);

    handleClientResume(ws, clients, eventLog, frame);

    expect(sent).toHaveLength(1);
    const reply = JSON.parse(sent[0]!);
    expect(reply.type).toBe('hq.resume_reject');
    expect(reply.reason).toBe('last_seen_too_old');
  });

  it('does not reject a fresh cursor because an older post-cursor gap envelope is stale', () => {
    const { ws, sent } = makeFakeWs();
    const client = makeClient();
    const clients = new Map<WebSocket, ConnectedClient>([[ws, client]]);
    const now = new Date().toISOString();
    const longAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const eventLog: HqEventEnvelope[] = [makeEnvelope(1, now), makeEnvelope(2, longAgo)];
    const frame = makeFrame(1);

    handleClientResume(ws, clients, eventLog, frame);

    expect(sent).toHaveLength(1);
    const reply = JSON.parse(sent[0]!);
    expect(reply.type).toBe('hq.resume_gap');
    expect(reply.envelopes.map((e: HqEventEnvelope) => e.seq)).toEqual([2]);
  });

  // ── 6. Identity check ──────────────────────────────────────────────────

  it('closes the socket (1008) when frame.clientId does not match the WS', () => {
    const { ws, sent, closed } = makeFakeWs();
    const client = makeClient({ clientId: 'c1' });
    const clients = new Map<WebSocket, ConnectedClient>([[ws, client]]);
    const eventLog: HqEventEnvelope[] = [];
    const frame = {
      type: 'client.resume',
      lastSeqSeen: 0,
      clientId: 'c2',
    } as HqClientResumeMessage;

    handleClientResume(ws, clients, eventLog, frame);

    expect(closed.code).toBe(1008);
    expect(closed.reason).toBe('resume clientId mismatch');
    expect(sent).toHaveLength(0);
  });

  // ── 7. No WS in clients map ───────────────────────────────────────────

  it('returns silently when the ws is not in the clients map', () => {
    const { ws, sent } = makeFakeWs();
    const clients = new Map<WebSocket, ConnectedClient>();
    const eventLog: HqEventEnvelope[] = [];
    const frame = makeFrame(0);

    handleClientResume(ws, clients, eventLog, frame);

    expect(sent).toHaveLength(0);
  });

  // ── 8. lastSeqSeen boundary: cursor=0 with empty log ──────────────────

  it('accepts cursor=0 with no pre-cursor history (succeeds with empty envelopes)', () => {
    const { ws, sent } = makeFakeWs();
    const client = makeClient();
    const clients = new Map<WebSocket, ConnectedClient>([[ws, client]]);
    const eventLog: HqEventEnvelope[] = [];
    const frame = makeFrame(0);

    handleClientResume(ws, clients, eventLog, frame);

    expect(sent).toHaveLength(1);
    const reply = JSON.parse(sent[0]!);
    expect(reply.type).toBe('hq.resume_gap');
    expect(reply.lastSeqSeen).toBe(0);
    expect(reply.envelopes).toEqual([]);
  });

  // ── 9. Update lastSeenAt ───────────────────────────────────────────────

  it('updates client.lastSeenAt on the success path', () => {
    const { ws, sent } = makeFakeWs();
    const before = '2026-01-01T00:00:00.000Z';
    const client = makeClient({ lastSeenAt: before });
    const clients = new Map<WebSocket, ConnectedClient>([[ws, client]]);
    const eventLog: HqEventEnvelope[] = [];
    const frame = makeFrame(0);

    handleClientResume(ws, clients, eventLog, frame);

    expect(sent).toHaveLength(1);
    expect(client.lastSeenAt).not.toBe(before);
    expect(Date.parse(client.lastSeenAt)).toBeGreaterThanOrEqual(Date.now() - 1000);
  });

  it('serves browser client.resume frames from the shared event log', () => {
    const { ws, sent, handlers } = makeFakeWs();
    const browsers = new Set<WebSocket>();
    const now = new Date().toISOString();
    const eventLog: HqEventEnvelope[] = [makeEnvelope(1, now), makeEnvelope(2, now)];

    handleBrowser(
      ws,
      {
        currentSerialized: () => JSON.stringify({ type: 'hq.snapshot', snapshot: {} }),
        broadcast: vi.fn(),
        close: vi.fn(),
      },
      browsers,
      eventLog,
    );
    sent.length = 0;
    handlers.get('message')?.(
      Buffer.from(JSON.stringify({ type: 'client.resume', clientId: 'c1', lastSeqSeen: 1 })),
    );

    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toEqual({
      type: 'hq.resume_gap',
      lastSeqSeen: 1,
      envelopes: [expect.objectContaining({ id: 'e-2', seq: 2 })],
      truncated: false,
    });
  });

  it('serves missed peer lifecycle envelopes through the browser peer resume cursor', () => {
    const { ws, sent, handlers } = makeFakeWs();
    const browsers = new Set<WebSocket>();
    const now = new Date().toISOString();
    const peerEvent: HqEventEnvelope = {
      id: 'peer-leader-1',
      type: 'peer.rehydrate',
      schemaVersion: HQ_PROTOCOL_VERSION,
      timestamp: now,
      clientId: HQ_BROWSER_PEER_RESUME_CLIENT_ID,
      projectId: 'p1',
      seq: 2,
      payload: {
        projectId: 'p1',
        machineId: 'm1',
        leaderClientId: 'leader-1',
        previousLeaderHandle: 'leader-1',
        reason: 'crash',
        detectedAt: now,
      },
    };
    const eventLog: HqEventEnvelope[] = [
      makeEnvelope(2, now),
      { ...peerEvent, seq: 1, id: 'already-seen-peer' },
      peerEvent,
    ];

    handleBrowser(
      ws,
      {
        currentSerialized: () => JSON.stringify({ type: 'hq.snapshot', snapshot: {} }),
        broadcast: vi.fn(),
        close: vi.fn(),
      },
      browsers,
      eventLog,
    );
    sent.length = 0;
    handlers.get('message')?.(
      Buffer.from(
        JSON.stringify({
          type: 'client.resume',
          clientId: HQ_BROWSER_PEER_RESUME_CLIENT_ID,
          lastSeqSeen: 1,
        }),
      ),
    );

    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toEqual({
      type: 'hq.resume_gap',
      lastSeqSeen: 1,
      envelopes: [expect.objectContaining({ id: 'peer-leader-1', seq: 2 })],
      truncated: false,
    });
  });

  // ── B5: Snapshot handoff escalation ──────────────────────────────────

  it('escalates to hq.snapshot when the log has no retained cursor for the client', () => {
    const { ws, sent } = makeFakeWs();
    const client = makeClient();
    const clients = new Map<WebSocket, ConnectedClient>([[ws, client]]);
    const eventLog: HqEventEnvelope[] = [];
    const snapshotFrame = JSON.stringify({
      type: 'hq.snapshot',
      generatedAt: '2026-07-31T12:00:00.000Z',
      snapshot: {
        generatedAt: '2026-07-31T12:00:00.000Z',
        clients: [],
        projects: [],
        sessions: [],
        fleets: [],
        mailboxes: [],
        totals: {
          activeProjects: 0,
          activeClients: 0,
          activeSessions: 0,
          activeSubagents: 0,
          unreadMailboxMessages: 0,
          incompleteMailboxMessages: 0,
          totalCostUsd: 0,
        },
      },
    });
    const broadcaster = {
      currentSerialized: () => snapshotFrame,
      broadcast: vi.fn(),
      close: vi.fn(),
    };
    const frame = makeFrame(50);

    handleClientResume(ws, clients, eventLog, frame, broadcaster);

    expect(sent).toEqual([snapshotFrame]);
  });

  it('escalates to hq.snapshot when the gap is too large for the bounded reply', () => {
    const { ws, sent } = makeFakeWs();
    const client = makeClient();
    const clients = new Map<WebSocket, ConnectedClient>([[ws, client]]);
    const now = new Date().toISOString();
    const eventLog: HqEventEnvelope[] = Array.from({ length: 1001 }, (_, i) =>
      makeEnvelope(i + 1, now),
    );
    const snapshotFrame = JSON.stringify({ type: 'hq.snapshot', snapshot: {} });
    const broadcaster = {
      currentSerialized: () => snapshotFrame,
      broadcast: vi.fn(),
      close: vi.fn(),
    };
    const frame = makeFrame(0);

    handleClientResume(ws, clients, eventLog, frame, broadcaster);

    expect(sent).toEqual([snapshotFrame]);
  });

  it('still rejects with hq.resume_reject when the cursor is older than 24 h even with a snapshot broadcaster', () => {
    const { ws, sent } = makeFakeWs();
    const client = makeClient();
    const clients = new Map<WebSocket, ConnectedClient>([[ws, client]]);
    const longAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const eventLog: HqEventEnvelope[] = [makeEnvelope(1, longAgo), makeEnvelope(2, longAgo)];
    const broadcaster = {
      currentSerialized: vi.fn(() => {
        throw new Error('must not be called when last_seen_too_old');
      }),
      broadcast: vi.fn(),
      close: vi.fn(),
    };
    const frame = makeFrame(1);

    handleClientResume(ws, clients, eventLog, frame, broadcaster);

    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toMatchObject({
      type: 'hq.resume_reject',
      reason: 'last_seen_too_old',
    });
  });
});
