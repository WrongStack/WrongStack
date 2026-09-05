/**
 * Staleness reaping of HQ per-client snapshot maps.
 *
 * `sessions` / `fleets` / `mcpSnapshots` were only ever emptied by an explicit
 * `session.ended`, so a session that died without sending one stayed in its
 * client's map for the life of the socket — retained memory, and permanent
 * weight in every snapshot broadcast to every browser. `receivedAt` was
 * already stamped and documented as "freshness authority for the cleanup
 * timer"; these tests pin the cleanup that comment promised.
 *
 * The safety property that matters most is the negative one: a live but idle
 * session must never be reaped. `session-bridge.ts` force-publishes every
 * 2.5s regardless of change, which is what makes `receivedAt` a liveness
 * signal rather than a change signal.
 */
import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import {
  buildSnapshot,
  HQ_STALE_SNAPSHOT_MS,
  reapStaleClientState,
} from '../src/hq-server/snapshot.js';
import type { ConnectedClient } from '../src/hq-server/types.js';

const NOW = 1_800_000_000_000;

function makeClient(overrides: {
  sessions?: Array<[string, number]>;
  fleets?: Array<[string, number]>;
  mcp?: Array<[string, number]>;
}): ConnectedClient {
  return {
    clientId: 'c1',
    projectId: 'p1',
    sessions: new Map(
      (overrides.sessions ?? []).map(([id, receivedAt]) => [
        id,
        { payload: { sessionId: id } as never, receivedAt },
      ]),
    ),
    fleets: new Map(
      (overrides.fleets ?? []).map(([runId, receivedAt]) => [
        runId,
        { payload: { runId } as never, receivedAt },
      ]),
    ),
    mcpSnapshots: new Map(
      (overrides.mcp ?? []).map(([sessionId, receivedAt]) => [
        sessionId,
        { servers: [], receivedAt },
      ]),
    ),
    mailboxes: new Map(),
    commandQueue: [],
  } as never as ConnectedClient;
}

function clientsOf(client: ConnectedClient): Map<WebSocket, ConnectedClient> {
  return new Map([[{} as WebSocket, client]]);
}

const fresh = NOW - 10_000;
const stale = NOW - HQ_STALE_SNAPSHOT_MS - 1;

describe('reapStaleClientState', () => {
  it('drops sessions whose publisher stopped refreshing them', () => {
    const client = makeClient({
      sessions: [
        ['live', fresh],
        ['dead', stale],
      ],
    });

    reapStaleClientState(clientsOf(client), NOW);

    expect([...client.sessions.keys()]).toEqual(['live']);
  });

  it('never reaps a session that is merely idle', () => {
    // A live session force-publishes every 2.5s, so anything inside the
    // window is alive by definition — no matter how quiet the user is.
    const idle = NOW - HQ_STALE_SNAPSHOT_MS + 1_000;
    const client = makeClient({ sessions: [['idle-but-alive', idle]] });

    reapStaleClientState(clientsOf(client), NOW);

    expect(client.sessions.has('idle-but-alive')).toBe(true);
  });

  it('drops stale fleet snapshots on the same clock', () => {
    const client = makeClient({
      fleets: [
        ['run-live', fresh],
        ['run-dead', stale],
      ],
    });

    reapStaleClientState(clientsOf(client), NOW);

    expect([...client.fleets.keys()]).toEqual(['run-live']);
  });

  it('ages MCP health on its own clock, not its session membership', () => {
    // MCP health can arrive before the session's first snapshot, and is keyed
    // 'unknown' when the envelope carries no sessionId. Tying its lifetime to
    // `sessions` would drop it in exactly that window.
    const client = makeClient({
      sessions: [],
      mcp: [
        ['unknown', fresh],
        ['gone', stale],
      ],
    });

    reapStaleClientState(clientsOf(client), NOW);

    expect([...client.mcpSnapshots.keys()]).toEqual(['unknown']);
  });

  it('leaves a fully fresh client untouched', () => {
    const client = makeClient({
      sessions: [['s', fresh]],
      fleets: [['r', fresh]],
      mcp: [['s', fresh]],
    });

    reapStaleClientState(clientsOf(client), NOW);

    expect(client.sessions.size).toBe(1);
    expect(client.fleets.size).toBe(1);
    expect(client.mcpSnapshots.size).toBe(1);
  });
});

describe('buildSnapshot agent pass-through', () => {
  /**
   * The publisher owns which agents exist. `AgentStatusTracker.sweep` removes a
   * FINISHED subagent 30 s after it stops, and `downgradeStaleAgentStatuses`
   * relabels a stale busy one as idle while keeping it visible. HQ used to
   * additionally DROP any subagent quiet for 5 minutes, which fought both:
   * an agent inside one long tool call, or parked on `waiting_user`,
   * disappeared from the fleet map and popped back on its next event.
   */
  function clientWithAgents(agents: unknown[]): Map<WebSocket, ConnectedClient> {
    const client = {
      clientId: 'c1',
      projectId: 'p1',
      kind: 'tui',
      machineId: 'm1',
      hostname: 'box',
      pid: 42,
      connectedAt: new Date(NOW).toISOString(),
      lastSeenAt: new Date(NOW).toISOString(),
      capabilities: ['telemetry.publish', 'session.summary'],
      project: {
        projectId: 'p1',
        projectRoot: '/repo',
        projectName: 'repo',
        machineId: 'm1',
        workspaceKind: 'git',
      },
      sessions: new Map([
        [
          's1',
          {
            payload: {
              sessionId: 's1',
              clientKind: 'tui',
              machineId: 'm1',
              hostname: 'box',
              projectId: 'p1',
              projectName: 'repo',
              projectRoot: '/repo',
              status: 'active',
              startedAt: new Date(NOW).toISOString(),
              lastActivityAt: new Date(NOW).toISOString(),
              agentCount: agents.length,
              agents,
            },
            receivedAt: Date.now(),
          },
        ],
      ]),
      fleets: new Map(),
      mcpSnapshots: new Map(),
      mailboxes: new Map(),
      commandQueue: [],
    } as never as ConnectedClient;
    return clientsOf(client);
  }

  const longQuiet = new Date(Date.now() - 20 * 60_000).toISOString();

  it('keeps a subagent the publisher still reports, however long it has been quiet', () => {
    const snapshot = buildSnapshot(
      clientWithAgents([
        {
          id: 'leader',
          name: 'leader',
          status: 'idle',
          iterations: 0,
          toolCalls: 0,
          lastActivityAt: longQuiet,
        },
        {
          id: 'reviewer-1',
          name: 'reviewer-1',
          status: 'waiting_user',
          iterations: 3,
          toolCalls: 9,
          lastActivityAt: longQuiet,
        },
        {
          id: 'builder-2',
          name: 'builder-2',
          status: 'running',
          iterations: 7,
          toolCalls: 2,
          lastActivityAt: longQuiet,
        },
      ]),
    );

    const session = snapshot.liveSessions?.[0];
    expect(session?.agents.map((agent) => agent.id)).toEqual(['leader', 'reviewer-1', 'builder-2']);
    expect(session?.agentCount).toBe(3);
    expect(snapshot.totals.activeSubagents).toBe(2);
  });

  it('reports no agents when the publisher reports none', () => {
    const snapshot = buildSnapshot(clientWithAgents([]));
    expect(snapshot.liveSessions?.[0]?.agents).toEqual([]);
    expect(snapshot.liveSessions?.[0]?.agentCount).toBe(0);
  });
});
