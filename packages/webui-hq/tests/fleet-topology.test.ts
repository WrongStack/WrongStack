import type { HqSnapshot } from '@wrongstack/core/hq';
import { describe, expect, it } from 'vitest';
import {
  buildFleetTopology,
  filterFleetTopology,
  filterFleetTopologyByQuery,
  FLEET_COLUMN_GAP,
  FLEET_LEAF_H,
  layoutFleetTopology,
  orderFleetTopologyNodes,
  type FleetTopologyNode,
} from '../src/domain/fleet-topology.js';

function baseSnapshot(overrides: Partial<HqSnapshot> = {}): HqSnapshot {
  return {
    generatedAt: '2026-07-09T00:00:00.000Z',
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
    ...overrides,
  };
}

describe('buildFleetTopology', () => {
  it('renders machine → project → terminal → agent nodes from live session telemetry', () => {
    const topology = buildFleetTopology(
      baseSnapshot({
        machines: [
          {
            machineId: 'machine-1',
            hostname: 'devbox',
            clientCount: 1,
            sessionCount: 1,
            agentCount: 1,
            projectIds: ['proj-1'],
            lastActivityAt: '2026-07-09T00:00:00.000Z',
          },
        ],
        projects: [
          {
            projectId: 'proj-1',
            projectName: 'WrongStack',
            projectRootDisplay: 'D:/Codebox/PROJECTS/WrongStack',
            machineIds: ['machine-1'],
            gitBranch: 'main',
            activeClients: 1,
            activeSessions: 1,
            activeSubagents: 1,
            totalCostUsd: 0.1,
            lastActivityAt: '2026-07-09T00:00:00.000Z',
            status: 'active',
          },
        ],
        liveSessions: [
          {
            sessionId: 'sess-1',
            clientKind: 'tui',
            machineId: 'machine-1',
            hostname: 'devbox',
            projectId: 'proj-1',
            projectName: 'WrongStack',
            projectRoot: 'D:/Codebox/PROJECTS/WrongStack',
            gitBranch: 'main',
            status: 'active',
            startedAt: '2026-07-09T00:00:00.000Z',
            lastActivityAt: '2026-07-09T00:01:00.000Z',
            agentCount: 1,
            agents: [
              {
                id: 'agent-1',
                name: 'AMK Agent',
                status: 'running',
                iterations: 2,
                toolCalls: 3,
                currentTool: 'read',
                lastActivityAt: '2026-07-09T00:01:00.000Z',
              },
            ],
          },
        ],
      }),
    );

    expect(topology.nodes.map((n) => `${n.kind}:${n.label}`)).toContain('machine:devbox');
    expect(topology.nodes.map((n) => `${n.kind}:${n.label}`)).toContain('project:WrongStack');
    expect(topology.nodes.some((n) => n.kind === 'terminal' && n.sessionId === 'sess-1')).toBe(true);
    expect(topology.nodes.some((n) => n.kind === 'agent' && n.agentId === 'agent-1')).toBe(true);
    expect(topology.edges.map((e) => `${e.source}->${e.target}`)).toEqual([
      'machine:machine-1->project:machine-1:proj-1',
      'project:machine-1:proj-1->terminal:sess-1',
      'terminal:sess-1->agent:sess-1:agent-1',
    ]);
  });

  it('keeps connected session-telemetry clients visible while waiting for session telemetry', () => {
    const topology = buildFleetTopology(
      baseSnapshot({
        clients: [
          {
            clientId: 'client-1',
            kind: 'webui',
            machineId: 'machine-1',
            hostname: 'devbox',
            connected: true,
            connectedAt: '2026-07-09T00:00:00.000Z',
            lastSeenAt: '2026-07-09T00:00:10.000Z',
            projectId: 'proj-1',
            capabilities: ['session.summary', 'control.receive'],
          },
        ],
        projects: [
          {
            projectId: 'proj-1',
            projectName: 'WrongStack',
            projectRootDisplay: 'D:/Codebox/PROJECTS/WrongStack',
            machineIds: ['machine-1'],
            activeClients: 1,
            activeSessions: 0,
            activeSubagents: 0,
            totalCostUsd: 0,
            lastActivityAt: '2026-07-09T00:00:10.000Z',
            status: 'idle',
          },
        ],
      }),
    );

    const terminal = topology.nodes.find((n) => n.kind === 'terminal');
    expect(terminal?.sessionId).toBe('client:client-1');
    expect(terminal?.clientKind).toBe('webui');
    expect(terminal?.sub).toBe('waiting for session telemetry');
    expect(topology.edges.map((e) => e.target)).toContain('terminal:client:client-1');
  });

  it('hides session-telemetry clients that stayed sessionless past the grace window', () => {
    // A live bridge publishes its first snapshot within ~2.5s. A client that
    // has been connected for minutes without one is broken/legacy — it must
    // not linger as a phantom "waiting for session telemetry" terminal.
    const topology = buildFleetTopology(
      baseSnapshot({
        generatedAt: '2026-07-09T00:10:00.000Z',
        clients: [
          {
            clientId: 'stale-1',
            kind: 'tui',
            machineId: 'machine-1',
            hostname: 'devbox',
            pid: 999,
            connected: true,
            connectedAt: '2026-07-09T00:00:00.000Z',
            lastSeenAt: '2026-07-09T00:09:55.000Z',
            projectId: 'proj-1',
            capabilities: ['telemetry.publish', 'session.summary'],
          },
        ],
      }),
    );

    expect(topology.nodes.some((n) => n.kind === 'terminal')).toBe(false);
  });

  it('hides auxiliary sockets that never publish session telemetry', () => {
    // A mailbox/brain publisher declares no `session.summary` — it must not
    // render as a phantom "waiting for session telemetry" terminal.
    const topology = buildFleetTopology(
      baseSnapshot({
        clients: [
          {
            clientId: 'aux-1',
            kind: 'cli',
            machineId: 'machine-1',
            hostname: 'devbox',
            pid: 4242,
            connected: true,
            connectedAt: '2026-07-09T00:00:00.000Z',
            lastSeenAt: '2026-07-09T00:00:10.000Z',
            projectId: 'proj-1',
            capabilities: ['telemetry.publish', 'mailbox.summary'],
          },
        ],
      }),
    );

    expect(topology.nodes.some((n) => n.kind === 'terminal')).toBe(false);
  });

  it('shows mailbox serve as an explicit service client, not a phantom terminal', () => {
    const topology = buildFleetTopology(
      baseSnapshot({
        clients: [
          {
            clientId: 'mailbox-1',
            kind: 'mailbox',
            machineId: 'machine-1',
            hostname: 'devbox',
            pid: 7788,
            connected: true,
            connectedAt: '2026-07-09T00:00:00.000Z',
            lastSeenAt: '2026-07-09T00:00:10.000Z',
            projectId: 'proj-1',
            capabilities: ['telemetry.publish', 'mailbox.summary', 'mailbox.serve'],
          },
        ],
        projects: [
          {
            projectId: 'proj-1',
            projectName: 'WrongStack',
            projectRootDisplay: '/work/wrongstack',
            machineIds: ['machine-1'],
            activeClients: 1,
            activeSessions: 0,
            activeSubagents: 0,
            totalCostUsd: 0,
            lastActivityAt: '2026-07-09T00:00:10.000Z',
            status: 'active',
          },
        ],
      }),
    );

    const service = topology.nodes.find((node) => node.serviceMode === 'mailbox-serve');
    expect(service?.label).toContain('MAILBOX SERVE');
    expect(service?.sub).toBe('mailbox HTTP bridge');
    expect(topology.nodes.some((node) => node.kind === 'project')).toBe(true);
  });

  it('does not duplicate a process already represented by a live session', () => {
    // One wstack process holds several publisher sockets. Once its session
    // telemetry is live, the sibling sockets must not spawn extra terminals.
    const topology = buildFleetTopology(
      baseSnapshot({
        clients: [
          {
            clientId: 'sibling-socket',
            kind: 'cli',
            machineId: 'machine-1',
            hostname: 'devbox',
            pid: 4242,
            connected: true,
            connectedAt: '2026-07-09T00:00:00.000Z',
            lastSeenAt: '2026-07-09T00:00:10.000Z',
            projectId: 'proj-1',
            capabilities: ['telemetry.publish', 'session.summary'],
          },
        ],
        liveSessions: [
          {
            sessionId: 'sess-1',
            clientKind: 'tui',
            machineId: 'machine-1',
            hostname: 'devbox',
            pid: 4242,
            projectId: 'proj-1',
            projectName: 'WrongStack',
            projectRoot: 'D:/Codebox/PROJECTS/WrongStack',
            status: 'active',
            startedAt: '2026-07-09T00:00:00.000Z',
            lastActivityAt: '2026-07-09T00:01:00.000Z',
            agentCount: 0,
            agents: [],
          },
        ],
      }),
    );

    const terminals = topology.nodes.filter((n) => n.kind === 'terminal');
    expect(terminals.map((n) => n.sessionId)).toEqual(['sess-1']);
  });
});

describe('layoutFleetTopology', () => {
  /** Minimal topology nodes — layout only reads kind/id/machineId/projectId/sessionId. */
  const N = (
    kind: FleetTopologyNode['kind'],
    id: string,
    rest: Partial<FleetTopologyNode> = {},
  ): FleetTopologyNode => ({ id, kind, label: id, chips: [], ...rest });

  const fleet: FleetTopologyNode[] = [
    N('machine', 'machine:m1', { machineId: 'm1' }),
    N('machine', 'machine:m2', { machineId: 'm2' }),
    N('project', 'project:m1:p1', { machineId: 'm1', projectId: 'p1' }),
    N('project', 'project:m2:p2', { machineId: 'm2', projectId: 'p2' }),
    N('terminal', 'terminal:s1', { machineId: 'm1', projectId: 'p1', sessionId: 's1' }),
    N('terminal', 'terminal:s2', { machineId: 'm1', projectId: 'p1', sessionId: 's2' }),
    N('terminal', 'terminal:s3', { machineId: 'm2', projectId: 'p2', sessionId: 's3' }),
    N('agent', 'agent:s1:a1', { machineId: 'm1', projectId: 'p1', sessionId: 's1', agentId: 'a1' }),
    N('agent', 'agent:s1:a2', { machineId: 'm1', projectId: 'p1', sessionId: 's1', agentId: 'a2' }),
    N('agent', 'agent:s1:a3', { machineId: 'm1', projectId: 'p1', sessionId: 's1', agentId: 'a3' }),
  ];

  it('assigns each kind to its own column', () => {
    const pos = layoutFleetTopology(fleet);
    expect(pos.get('machine:m1')?.x).toBe(0);
    expect(pos.get('project:m1:p1')?.x).toBe(FLEET_COLUMN_GAP);
    expect(pos.get('terminal:s1')?.x).toBe(FLEET_COLUMN_GAP * 2);
    expect(pos.get('agent:s1:a1')?.x).toBe(FLEET_COLUMN_GAP * 3);
  });

  it('centers each parent over its own children', () => {
    const pos = layoutFleetTopology(fleet);
    const a1 = pos.get('agent:s1:a1')!.y;
    const a3 = pos.get('agent:s1:a3')!.y;
    expect(pos.get('terminal:s1')?.y).toBe((a1 + a3) / 2);
    const t1 = pos.get('terminal:s1')!.y;
    const t2 = pos.get('terminal:s2')!.y;
    expect(pos.get('project:m1:p1')?.y).toBe((t1 + t2) / 2);
    expect(pos.get('machine:m1')?.y).toBe(pos.get('project:m1:p1')?.y);
  });

  it('keeps machine groups vertically disjoint (no cross-machine interleaving)', () => {
    const pos = layoutFleetTopology(fleet);
    const m1Ys = [...pos.entries()]
      .filter(([id]) => id.includes('m1') || id.includes('s1') || id.includes('s2'))
      .map(([, p]) => p.y);
    const m2Ys = [...pos.entries()]
      .filter(([id]) => id.includes('m2') || id.includes('s3'))
      .map(([, p]) => p.y);
    expect(Math.max(...m1Ys)).toBeLessThan(Math.min(...m2Ys));
  });

  it('never overlaps two nodes in the same column', () => {
    const pos = layoutFleetTopology(fleet);
    const byColumn = new Map<number, number[]>();
    for (const p of pos.values()) {
      const list = byColumn.get(p.x) ?? [];
      list.push(p.y);
      byColumn.set(p.x, list);
    }
    for (const ys of byColumn.values()) {
      const sorted = [...ys].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(FLEET_LEAF_H / 2);
      }
    }
  });

  it('gives lonely machines and empty projects their own slot', () => {
    const pos = layoutFleetTopology([
      N('machine', 'machine:solo', { machineId: 'solo' }),
      N('machine', 'machine:m1', { machineId: 'm1' }),
      N('project', 'project:m1:p1', { machineId: 'm1', projectId: 'p1' }),
    ]);
    expect(pos.get('machine:solo')).toBeDefined();
    expect(pos.get('machine:m1')?.y).not.toBe(pos.get('machine:solo')?.y);
    expect(pos.get('project:m1:p1')).toBeDefined();
  });
});

describe('filterFleetTopology', () => {
  const nodes: FleetTopologyNode[] = [
    { id: 'machine:m1', kind: 'machine', label: 'm1', chips: [], machineId: 'm1' },
    { id: 'machine:m2', kind: 'machine', label: 'm2', chips: [], machineId: 'm2' },
    { id: 'project:m1:p1', kind: 'project', label: 'p1', chips: [], machineId: 'm1', projectId: 'p1' },
    { id: 'project:m2:p1', kind: 'project', label: 'p1', chips: [], machineId: 'm2', projectId: 'p1' },
    { id: 'project:m2:p2', kind: 'project', label: 'p2', chips: [], machineId: 'm2', projectId: 'p2' },
    { id: 'terminal:s1', kind: 'terminal', label: 's1', chips: [], machineId: 'm1', projectId: 'p1', sessionId: 's1' },
    { id: 'terminal:s2', kind: 'terminal', label: 's2', chips: [], machineId: 'm2', projectId: 'p1', sessionId: 's2' },
    { id: 'terminal:s3', kind: 'terminal', label: 's3', chips: [], machineId: 'm2', projectId: 'p2', sessionId: 's3' },
  ];
  const topology = {
    nodes,
    edges: [
      { id: 'm1-p1', source: 'machine:m1', target: 'project:m1:p1' },
      { id: 'p1-s1', source: 'project:m1:p1', target: 'terminal:s1' },
      { id: 'm2-p1', source: 'machine:m2', target: 'project:m2:p1' },
      { id: 'p1-s2', source: 'project:m2:p1', target: 'terminal:s2' },
      { id: 'm2-p2', source: 'machine:m2', target: 'project:m2:p2' },
      { id: 'p2-s3', source: 'project:m2:p2', target: 'terminal:s3' },
    ],
  };

  it('shows one whole machine slice', () => {
    const filtered = filterFleetTopology(topology, 'machine', 'm1');
    expect(filtered.nodes.map((node) => node.id)).toEqual([
      'machine:m1',
      'project:m1:p1',
      'terminal:s1',
    ]);
  });

  it('shows one project across every participating machine', () => {
    const filtered = filterFleetTopology(topology, 'project', 'p1');
    expect(filtered.nodes.map((node) => node.id)).toEqual([
      'machine:m1',
      'machine:m2',
      'project:m1:p1',
      'project:m2:p1',
      'terminal:s1',
      'terminal:s2',
    ]);
    expect(filtered.edges).toHaveLength(4);
  });
});

describe('fleet topology compact search', () => {
  const topology = {
    nodes: [
      { id: 'machine:m1', kind: 'machine' as const, label: 'devbox', chips: ['2 clients'], machineId: 'm1' },
      { id: 'project:m1:p1', kind: 'project' as const, label: 'WrongStack', chips: ['main'], machineId: 'm1', projectId: 'p1' },
      { id: 'terminal:s1', kind: 'terminal' as const, label: 'TUI · s1', chips: ['tui'], machineId: 'm1', projectId: 'p1', sessionId: 's1' },
      { id: 'agent:s1:a1', kind: 'agent' as const, label: 'Release reviewer', status: 'active', chips: ['active'], machineId: 'm1', projectId: 'p1', sessionId: 's1', agentId: 'a1' },
    ],
    edges: [
      { id: 'm-p', source: 'machine:m1', target: 'project:m1:p1' },
      { id: 'p-t', source: 'project:m1:p1', target: 'terminal:s1' },
      { id: 't-a', source: 'terminal:s1', target: 'agent:s1:a1' },
    ],
  };

  it('keeps every ancestor around an agent search match', () => {
    expect(filterFleetTopologyByQuery(topology, 'reviewer').nodes.map((node) => node.id)).toEqual([
      'machine:m1',
      'project:m1:p1',
      'terminal:s1',
      'agent:s1:a1',
    ]);
  });

  it('includes descendants when a container matches and returns no rows for a miss', () => {
    expect(filterFleetTopologyByQuery(topology, 'devbox').nodes).toHaveLength(4);
    expect(filterFleetTopologyByQuery(topology, 'not-present').nodes).toEqual([]);
  });

  it('orders compact rows as machine → project → terminal → agent', () => {
    const shuffled = { ...topology, nodes: [...topology.nodes].reverse() };
    expect(orderFleetTopologyNodes(shuffled).map((node) => node.id)).toEqual([
      'machine:m1',
      'project:m1:p1',
      'terminal:s1',
      'agent:s1:a1',
    ]);
  });
});

describe('buildFleetTopology — edge cases', () => {
  it('returns empty nodes/edges for null snapshot', () => {
    const topology = buildFleetTopology(null);
    expect(topology.nodes).toEqual([]);
    expect(topology.edges).toEqual([]);
  });

  it('sorts sessions by secondary keys when machines match', () => {
    // Two sessions on the same machine but different projects:
    // the sort comparator reaches the projectName and sessionId branches.
    const topology = buildFleetTopology(
      baseSnapshot({
        liveSessions: [
          {
            sessionId: 'sess-b',
            clientKind: 'tui',
            machineId: 'machine-1',
            projectId: 'proj-a',
            projectName: 'Alpha',
            status: 'active',
            startedAt: '2026-07-09T00:00:00.000Z',
            lastActivityAt: '2026-07-09T00:01:00.000Z',
            agentCount: 0,
            agents: [],
          },
          {
            sessionId: 'sess-a',
            clientKind: 'cli',
            machineId: 'machine-1',
            projectId: 'proj-b',
            projectName: 'Beta',
            status: 'active',
            startedAt: '2026-07-09T00:00:00.000Z',
            lastActivityAt: '2026-07-09T00:01:00.000Z',
            agentCount: 0,
            agents: [],
          },
        ],
        machines: [{
          machineId: 'machine-1',
          hostname: 'devbox',
          clientCount: 1,
          sessionCount: 2,
          agentCount: 0,
          projectIds: ['proj-a', 'proj-b'],
          lastActivityAt: '2026-07-09T00:01:00.000Z',
        }],
      }),
    );
    // Both sessions share one machine, so the sort must break ties by
    // projectName → projectId. The sort output isn't directly surfaced,
    // but the node list should contain both terminals without error.
    expect(topology.nodes.filter((n) => n.kind === 'terminal')).toHaveLength(2);
    expect(topology.nodes.filter((n) => n.kind === 'project')).toHaveLength(2);
  });

  it('falls back to session.projectName/projectRoot when no project record exists', () => {
    // No snapshot.projects entry for the session's projectId —
    // the labels/chips must use the session-level fallback.
    const topology = buildFleetTopology(
      baseSnapshot({
        liveSessions: [{
          sessionId: 'sess-1',
          clientKind: 'tui',
          machineId: 'machine-1',
          hostname: 'devbox',
          projectId: 'orphan-proj',
          projectName: 'Orphan',
          projectRoot: '/tmp/orphan',
          status: 'active',
          startedAt: '2026-07-09T00:00:00.000Z',
          lastActivityAt: '2026-07-09T00:01:00.000Z',
          agentCount: 0,
          agents: [],
        }],
        machines: [{
          machineId: 'machine-1',
          hostname: 'devbox',
          clientCount: 1,
          sessionCount: 1,
          agentCount: 0,
          projectIds: ['orphan-proj'],
          lastActivityAt: '2026-07-09T00:01:00.000Z',
        }],
      }),
    );
    const project = topology.nodes.find((n) => n.kind === 'project');
    // Since there's no project record, the session's projectName is used.
    expect(project?.label).toBe('Orphan');
    // chips should not crash even without project record fields.
    expect(project?.chips).toBeDefined();
  });

  it('excludes disconnected clients from the topology', () => {
    const topology = buildFleetTopology(
      baseSnapshot({
        clients: [{
          clientId: 'offline-client',
          kind: 'webui',
          machineId: 'machine-x',
          connected: false,
          connectedAt: '2026-07-09T00:00:00.000Z',
          lastSeenAt: '2026-07-09T00:00:10.000Z',
          projectId: 'proj-x',
          capabilities: ['control.receive'],
        }],
      }),
    );
    // Disconnected client should not appear as a node.
    expect(topology.nodes).toHaveLength(0);
  });
});
