/**
 * Leader-deposed detector (`detectLeaderLoss` in `hq-server/ws.ts`).
 *
 * Asserts the user's named requirement: when the leader's TCP closes
 * (graceful) the surviving clients/browsers learn about it via the
 * `peer.rehydrate` envelope within 1 s. Implemented as a focused unit
 * test of `detectLeaderLoss` so the test is deterministic in CI (no
 * 120 s sleep, no timer-flaky heartbeat-timeout path).
 *
 * The browser-side broadcast is exercised end-to-end by the integration
 * suite; here we verify the envelope shape and dedup behavior.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

// Mock the snapshot broadcast path so the test can capture the envelope.
const broadcastEventMock = vi.fn();
vi.mock('../src/hq-server/snapshot.js', () => ({
  broadcastEvent: broadcastEventMock,
  sendGuarded: vi.fn(),
}));

// Import after the mock.
const { detectLeaderLoss } = await import('../src/hq-server/ws.js');
const { HQ_PROTOCOL_VERSION } = await import('@wrongstack/core/hq');

import type { ConnectedClient } from '../src/hq-server/types.js';

/** Build a fake `ConnectedClient` with the minimum fields `detectLeaderLoss` reads. */
function makeClient(opts: {
  clientId: string;
  projectId: string;
  isLeader: boolean;
  machineId?: string | undefined;
  capabilities?: readonly string[];
}): ConnectedClient {
  return {
    ws: { close: vi.fn() } as unknown as WebSocket,
    clientId: opts.clientId,
    projectId: opts.projectId,
    project: {
      projectId: opts.projectId,
      projectName: opts.projectId,
      projectRoot: `/tmp/${opts.projectId}`,
      machineId: opts.machineId ?? `machine-${opts.clientId}`,
      workspaceKind: 'git',
    },
    kind: 'tui',
    connectedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    capabilities: opts.capabilities ?? ['control.receive'],
    declaredRedactionPolicy: {
      rawContent: false,
      toolArgs: 'summary',
      paths: 'project-relative',
    },
    lastEventSeq: 0,
    mailboxes: new Map(),
    machineId: opts.machineId ?? `machine-${opts.clientId}`,
    sessions: new Map(),
    fleets: new Map(),
    mcpSnapshots: new Map(),
    commandQueue: [],
    isLeader: opts.isLeader,
  } as ConnectedClient;
}

describe('detectLeaderLoss', () => {
  beforeEach(() => {
    broadcastEventMock.mockClear();
  });

  it('emits peer.rehydrate with reason=graceful when the leader closes and a follower survives', () => {
    const leaderWs = { close: vi.fn() } as unknown as WebSocket;
    const followerWs = { close: vi.fn() } as unknown as WebSocket;
    const leader = makeClient({
      clientId: 'leader-1',
      projectId: 'proj-1',
      isLeader: true,
      machineId: 'm1',
    });
    const follower = makeClient({
      clientId: 'follower-1',
      projectId: 'proj-1',
      isLeader: false,
      machineId: 'm1',
    });
    const clients = new Map<WebSocket, ConnectedClient>([
      [leaderWs, leader],
      [followerWs, follower],
    ]);
    const browsers = new Set<WebSocket>();

    const start = Date.now();
    const result = detectLeaderLoss(leader, clients, browsers, 'graceful');
    const elapsed = Date.now() - start;

    expect(result).toBe(true);
    expect(elapsed).toBeLessThan(1000);
    expect(broadcastEventMock).toHaveBeenCalledTimes(1);
    const [envelope, broadcastTargets] = broadcastEventMock.mock.calls[0]!;
    expect(envelope.type).toBe('peer.rehydrate');
    expect(envelope.schemaVersion).toBe(HQ_PROTOCOL_VERSION);
    expect((envelope.payload as { reason: string }).reason).toBe('graceful');
    expect((envelope.payload as { projectId: string }).projectId).toBe('proj-1');
    expect((envelope.payload as { leaderClientId: string }).leaderClientId).toBe('leader-1');
    expect((envelope.payload as { previousLeaderHandle: string }).previousLeaderHandle).toBe(
      'leader-1',
    );
    expect(broadcastTargets).toBe(browsers);
    // After emit, the follower is the new leader.
    expect(follower.isLeader).toBe(true);
  });

  it('emits peer.lost when the leader closes and no follower survives', () => {
    const leaderWs = { close: vi.fn() } as unknown as WebSocket;
    const leader = makeClient({
      clientId: 'leader-2',
      projectId: 'proj-2',
      isLeader: true,
    });
    const clients = new Map<WebSocket, ConnectedClient>([[leaderWs, leader]]);
    const browsers = new Set<WebSocket>();

    const result = detectLeaderLoss(leader, clients, browsers, 'heartbeat-timeout');

    expect(result).toBe(true);
    expect(broadcastEventMock).toHaveBeenCalledTimes(1);
    const [envelope] = broadcastEventMock.mock.calls[0]!;
    expect(envelope.type).toBe('peer.lost');
    expect((envelope.payload as { reason: string }).reason).toBe('heartbeat-timeout');
  });

  it('returns false (no broadcast) when the lost client is not the leader', () => {
    const followerWs = { close: vi.fn() } as unknown as WebSocket;
    const follower = makeClient({
      clientId: 'follower-3',
      projectId: 'proj-3',
      isLeader: false,
    });
    const clients = new Map<WebSocket, ConnectedClient>([[followerWs, follower]]);
    const browsers = new Set<WebSocket>();

    const result = detectLeaderLoss(follower, clients, browsers, 'graceful');

    expect(result).toBe(false);
    expect(broadcastEventMock).not.toHaveBeenCalled();
  });

  it('does not broadcast again for the same leader handle within 1 h (dedup window)', () => {
    const leaderWs = { close: vi.fn() } as unknown as WebSocket;
    const followerWs = { close: vi.fn() } as unknown as WebSocket;
    const leader = makeClient({
      clientId: 'leader-4',
      projectId: 'proj-4',
      isLeader: true,
    });
    const follower = makeClient({
      clientId: 'follower-4',
      projectId: 'proj-4',
      isLeader: false,
    });
    const clients = new Map<WebSocket, ConnectedClient>([
      [leaderWs, leader],
      [followerWs, follower],
    ]);
    const browsers = new Set<WebSocket>();

    // First emit succeeds.
    const first = detectLeaderLoss(leader, clients, browsers, 'graceful');
    expect(first).toBe(true);
    expect(broadcastEventMock).toHaveBeenCalledTimes(1);

    // A different client with the same handle is detected as a leader loss
    // for the same project → deduped.
    const again = detectLeaderLoss(leader, clients, browsers, 'graceful');
    expect(again).toBe(false);
    expect(broadcastEventMock).toHaveBeenCalledTimes(1);
  });
});
