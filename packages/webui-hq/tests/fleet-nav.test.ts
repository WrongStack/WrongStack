import type { HqSnapshot } from '@wrongstack/core/hq';
import { describe, expect, it } from 'vitest';
import { buildNav } from '../src/domain/fleet-nav-tree.js';

function snapshot(overrides: Partial<HqSnapshot> = {}): HqSnapshot {
  return {
    generatedAt: '2026-07-10T00:00:00.000Z',
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

const twoMachines = snapshot({
  machines: [
    { machineId: 'm1', hostname: 'devbox', clientCount: 1, sessionCount: 1, agentCount: 2, projectIds: ['p1'], lastActivityAt: '2026-07-10T00:00:00.000Z' },
    { machineId: 'm2', hostname: 'laptop', clientCount: 1, sessionCount: 1, agentCount: 0, projectIds: ['p2'], lastActivityAt: '2026-07-10T00:00:00.000Z' },
  ],
  projects: [
    { projectId: 'p1', projectName: 'WrongStack', projectRootDisplay: '/p1', machineIds: ['m1'], activeClients: 1, activeSessions: 1, activeSubagents: 2, totalCostUsd: 0, lastActivityAt: '2026-07-10T00:00:00.000Z', status: 'active' },
    { projectId: 'p2', projectName: 'Other', projectRootDisplay: '/p2', machineIds: ['m2'], activeClients: 1, activeSessions: 1, activeSubagents: 0, totalCostUsd: 0, lastActivityAt: '2026-07-10T00:00:00.000Z', status: 'idle' },
  ],
  liveSessions: [
    {
      sessionId: 'sess-1', clientKind: 'tui', machineId: 'm1', projectId: 'p1', projectName: 'WrongStack',
      projectRoot: '/p1', status: 'active', startedAt: '2026-07-10T00:00:00.000Z', lastActivityAt: '2026-07-10T00:00:00.000Z',
      agentCount: 2,
      agents: [
        { id: 'a1', name: 'Leader', status: 'running', iterations: 1, toolCalls: 1, lastActivityAt: '2026-07-10T00:00:00.000Z' },
        { id: 'a2', name: 'Worker', status: 'idle', iterations: 0, toolCalls: 0, lastActivityAt: '2026-07-10T00:00:00.000Z' },
      ],
    },
    {
      sessionId: 'sess-2', clientKind: 'webui', machineId: 'm2', projectId: 'p2', projectName: 'Other',
      projectRoot: '/p2', status: 'idle', startedAt: '2026-07-10T00:00:00.000Z', lastActivityAt: '2026-07-10T00:00:00.000Z',
      agentCount: 0, agents: [],
    },
  ],
});

describe('buildNav', () => {
  it('is empty for a null snapshot', () => {
    expect(buildNav(null)).toEqual([]);
  });

  it('nests machine → project → client → agent', () => {
    const nav = buildNav(twoMachines);
    expect(nav.map((m) => m.label).sort()).toEqual(['devbox', 'laptop']);

    const devbox = nav.find((m) => m.label === 'devbox')!;
    expect(devbox.projects.map((p) => p.label)).toEqual(['WrongStack']);
    const client = devbox.projects[0]!.clients[0]!;
    expect(client.sessionId).toBe('sess-1');
    expect(client.agents.map((a) => a.label)).toEqual(['Leader', 'Worker']);
  });

  it('keeps an agent-less client (it is still selectable)', () => {
    const nav = buildNav(twoMachines);
    const laptop = nav.find((m) => m.label === 'laptop')!;
    const client = laptop.projects[0]!.clients[0]!;
    expect(client.sessionId).toBe('sess-2');
    expect(client.clientKind).toBe('webui');
    expect(client.agents).toEqual([]);
  });

  it('drops machines whose sessions have all ended', () => {
    const nav = buildNav(
      snapshot({
        machines: [
          { machineId: 'm1', hostname: 'ghost', clientCount: 0, sessionCount: 0, agentCount: 0, projectIds: [], lastActivityAt: '2026-07-10T00:00:00.000Z' },
        ],
        liveSessions: [],
      }),
    );
    expect(nav).toEqual([]);
  });
});
