import type { HqSnapshot } from '@wrongstack/core/hq';
import { describe, expect, it } from 'vitest';
import { resolveConsoleControlTarget } from '../src/domain/console-target.js';

function snapshot(): HqSnapshot {
  return {
    generatedAt: '2026-07-16T12:00:00.000Z',
    clients: [
      {
        clientId: 'client-exact',
        kind: 'tui',
        machineId: 'machine-1',
        hostname: 'devbox',
        pid: 42,
        connected: true,
        lastSeenAt: '2026-07-16T12:00:00.000Z',
        projectId: 'project-1',
        capabilities: ['telemetry.publish', 'session.summary', 'control.receive'],
      },
      {
        clientId: 'mailbox-bridge',
        kind: 'mailbox',
        machineId: 'machine-1',
        hostname: 'devbox',
        pid: 99,
        connected: true,
        lastSeenAt: '2026-07-16T12:00:00.000Z',
        projectId: 'project-1',
        capabilities: ['telemetry.publish', 'mailbox.summary', 'mailbox.serve'],
      },
    ],
    projects: [],
    sessions: [
      {
        sessionId: 'session-1',
        projectId: 'project-1',
        clientId: 'client-exact',
        status: 'running',
        lastActivityAt: '2026-07-16T12:00:00.000Z',
      },
    ],
    fleets: [],
    mailboxes: [],
    liveSessions: [
      {
        sessionId: 'session-1',
        clientId: 'client-exact',
        clientKind: 'tui',
        machineId: 'machine-1',
        hostname: 'devbox',
        pid: 42,
        projectId: 'project-1',
        projectName: 'WrongStack',
        projectRoot: '/work/wrongstack',
        status: 'active',
        startedAt: '2026-07-16T11:00:00.000Z',
        lastActivityAt: '2026-07-16T12:00:00.000Z',
        agentCount: 2,
        agents: [
          {
            id: 'leader',
            name: 'Leader',
            status: 'running',
            iterations: 2,
            toolCalls: 4,
            lastActivityAt: '2026-07-16T12:00:00.000Z',
          },
          {
            id: 'worker-1',
            name: 'Worker',
            status: 'running',
            iterations: 1,
            toolCalls: 1,
            lastActivityAt: '2026-07-16T12:00:00.000Z',
          },
        ],
      },
    ],
    totals: {
      activeProjects: 1,
      activeClients: 2,
      activeSessions: 1,
      activeSubagents: 1,
      unreadMailboxMessages: 0,
      incompleteMailboxMessages: 0,
      totalCostUsd: 0,
    },
  };
}

describe('resolveConsoleControlTarget', () => {
  it('maps a leader transcript to the exact controllable client', () => {
    const target = resolveConsoleControlTarget(snapshot(), 'session-1', null);
    expect(target?.client?.clientId).toBe('client-exact');
    expect(target?.recipient).toBe('leader');
    expect(target?.controllable).toBe(true);
    expect(target?.mailboxServeActive).toBe(true);
  });

  it('targets one selected subagent by id', () => {
    const target = resolveConsoleControlTarget(snapshot(), 'session-1', 'worker-1');
    expect(target?.agent?.name).toBe('Worker');
    expect(target?.recipient).toBe('worker-1');
  });

  it('uses a control-capable sibling socket when the exact publisher is telemetry-only', () => {
    const base = snapshot();
    const exact = base.clients[0]!;
    const splitSocketSnapshot: HqSnapshot = {
      ...base,
      clients: [
        { ...exact, capabilities: ['telemetry.publish', 'session.summary'] },
        {
          ...exact,
          clientId: 'client-control-sibling',
          capabilities: ['control.receive'],
        },
        ...base.clients.slice(1),
      ],
    };

    const target = resolveConsoleControlTarget(splitSocketSnapshot, 'session-1', null);
    expect(target?.client?.clientId).toBe('client-control-sibling');
    expect(target?.controllable).toBe(true);
  });
});
