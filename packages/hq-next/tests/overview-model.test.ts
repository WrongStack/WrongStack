/**
 * The Overview's ordering and wording rules: what reaches the top of the
 * screen, and what the one-line headline says about the fleet.
 */
import type {
  HqAlertMessage,
  HqClientRecord,
  HqCommandAuditEntry,
  HqProjectRecord,
  HqSessionSnapshotPayload,
  HqSnapshot,
} from '@wrongstack/hq';
import { describe, expect, it } from 'vitest';
import { buildAttentionItems, relativeTime } from '../src/features/attention/model';
import {
  fleetPulse,
  orderSessions,
  overviewHeadline,
  tokenHealth,
} from '../src/features/overview/model';

const T = '2026-10-31T12:00:00.000Z';
const at = (minutesAgo: number): string =>
  new Date(Date.parse(T) - minutesAgo * 60_000).toISOString();

function project(id: string, overrides: Partial<HqProjectRecord> = {}): HqProjectRecord {
  return {
    projectId: id,
    projectName: `Project ${id}`,
    projectRootDisplay: `~/${id}`,
    machineIds: ['m1'],
    activeClients: 1,
    activeSessions: 1,
    activeSubagents: 0,
    totalCostUsd: 0,
    lastActivityAt: T,
    status: 'active',
    ...overrides,
  };
}

function session(
  id: string,
  agents: HqSessionSnapshotPayload['agents'],
  overrides: Partial<HqSessionSnapshotPayload> = {},
): HqSessionSnapshotPayload {
  return {
    sessionId: id,
    clientKind: 'tui',
    machineId: 'm1',
    hostname: 'workstation',
    projectId: 'p1',
    projectName: 'Project p1',
    projectRoot: '/repo',
    status: 'active',
    startedAt: at(60),
    lastActivityAt: T,
    agentCount: agents.length,
    agents,
    ...overrides,
  };
}

const agent = (
  id: string,
  status: HqSessionSnapshotPayload['agents'][number]['status'],
  lastActivityAt = T,
) => ({ id, name: id, status, iterations: 0, toolCalls: 0, lastActivityAt });

function snap(parts: Partial<HqSnapshot> = {}): HqSnapshot {
  return {
    generatedAt: T,
    clients: [],
    projects: [project('p1')],
    sessions: [],
    fleets: [],
    mailboxes: [],
    totals: {
      activeProjects: 1,
      activeClients: 1,
      activeSessions: 1,
      activeSubagents: 0,
      unreadMailboxMessages: 0,
      incompleteMailboxMessages: 0,
      totalCostUsd: 1.5,
    },
    ...parts,
  };
}

const none = { approvals: [], questions: [], alerts: [], commands: [] };

describe('buildAttentionItems', () => {
  it('puts critical items first, then decisions before diagnostics, then newest first', () => {
    const lost: HqClientRecord = {
      clientId: 'c-lost',
      kind: 'cli',
      machineId: 'm2',
      connected: false,
      lastSeenAt: at(1),
      projectId: 'p1',
      capabilities: [],
    };
    const failed: HqCommandAuditEntry = {
      commandId: 'cmd-1',
      type: 'steer',
      clientId: 'c1',
      enqueuedBy: 'op',
      enqueuedAt: at(3),
      status: 'acked',
      ackStatus: 'failed',
      ackMessage: 'session gone',
    };
    const alerts: HqAlertMessage[] = [
      { type: 'hq.alert', severity: 'info', message: 'fyi', timestamp: at(0) },
      { type: 'hq.alert', severity: 'error', message: 'budget exceeded', timestamp: at(9) },
    ];
    const items = buildAttentionItems({
      snapshot: snap({
        clients: [lost],
        liveSessions: [
          session('s1', [agent('waiter', 'waiting_user', at(2)), agent('broken', 'error', at(8))]),
        ],
      }),
      approvals: [
        {
          toolUseId: 'tu-safe',
          toolName: 'write_file',
          projectId: 'p1',
          destructive: false,
          requestedAt: at(4),
        },
        {
          toolUseId: 'tu-rm',
          toolName: 'bash',
          projectId: 'p1',
          destructive: true,
          requestedAt: at(5),
        },
      ],
      questions: [{ projectId: 'p1', request: { id: 'q1', title: 'Which branch?' } }],
      alerts,
      commands: [failed],
    });

    expect(items.map((item) => item.id)).toEqual([
      'approval:tu-rm',
      'agent:s1:broken',
      `alert:${at(9)}:budget exceeded`,
      'approval:tu-safe',
      'question:q1',
      'agent:s1:waiter',
      'command:cmd-1',
      'client:c-lost',
    ]);
    // Info alerts are history, not something to act on.
    expect(items.some((item) => item.title === 'fyi')).toBe(false);
  });

  it('routes each kind to the surface that can act on it, focusing agents in the console', () => {
    const items = buildAttentionItems({
      ...none,
      snapshot: snap({ liveSessions: [session('s1', [agent('a1', 'waiting_user')])] }),
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      href: '/fleet/console/',
      focus: { sessionId: 's1', agentId: 'a1' },
      context: 'Project p1 · workstation',
    });
  });

  it('flags governance only when it is degraded or unreadable', () => {
    const governed = (level: 'ok' | 'warning' | 'unavailable', id: string) =>
      project(id, {
        governance: {
          schemaVersion: 1,
          projectId: id,
          observedAt: T,
          available: level !== 'unavailable',
          signal: {
            level,
            code: 'broker_missing',
            operatorAction: 'observe',
            executionDisposition: 'continue',
          },
        } as unknown as HqProjectRecord['governance'],
      });
    const items = buildAttentionItems({
      ...none,
      snapshot: snap({
        projects: [governed('ok', 'a'), governed('warning', 'b'), governed('unavailable', 'c')],
      }),
    });
    expect(items.map((item) => item.id)).toEqual(['governance:b', 'governance:c']);
    expect(items[0]?.context).toBe('No broker');
  });
});

describe('overviewHeadline', () => {
  const pulse = fleetPulse(
    snap({ liveSessions: [session('s1', [agent('a', 'running'), agent('b', 'idle')])] }),
  );
  const base = { connected: true, hasSnapshot: true, everSawClient: true, attention: [], pulse };

  it('says so when the link is down, before anything else', () => {
    expect(overviewHeadline({ ...base, connected: false }).tone).toBe('offline');
  });

  it('invites a first connection when no client has ever reported', () => {
    expect(overviewHeadline({ ...base, everSawClient: false })).toMatchObject({
      tone: 'empty',
      title: 'No machine is connected yet',
    });
  });

  it('counts what needs the operator and how much of it is urgent', () => {
    const attention = buildAttentionItems({
      ...none,
      snapshot: snap({
        liveSessions: [session('s1', [agent('x', 'error'), agent('y', 'waiting_user')])],
      }),
    });
    expect(overviewHeadline({ ...base, attention })).toEqual({
      tone: 'attention',
      title: '2 things need you',
      detail: '1 urgent. 1 agent working across 1 project.',
    });
  });

  it('counts only the projects where an agent is actually working', () => {
    const busyAndQuiet = fleetPulse(
      snap({
        liveSessions: [
          session('s1', [agent('a', 'running'), agent('b', 'streaming')]),
          session('s2', [agent('c', 'idle')], { projectId: 'p2', projectName: 'Project p2' }),
        ],
      }),
    );
    expect(busyAndQuiet).toMatchObject({ projects: 2, workingProjects: 1, working: 2, agents: 3 });
    expect(overviewHeadline({ ...base, pulse: busyAndQuiet }).detail).toBe(
      '2 agents working across 1 project.',
    );
  });

  it('is calm and specific when nothing is waiting', () => {
    expect(overviewHeadline(base)).toEqual({
      tone: 'busy',
      title: 'All clear',
      detail: '1 agent working across 1 project.',
    });
  });
});

describe('orderSessions', () => {
  it('lists sessions that need a human first, then working ones, then by recency', () => {
    const ordered = orderSessions([
      session('quiet-new', [agent('a', 'idle')], { lastActivityAt: at(0) }),
      session('working', [agent('a', 'running')], { lastActivityAt: at(30) }),
      session('blocked', [agent('a', 'waiting_user')], { lastActivityAt: at(60) }),
      session('quiet-old', [agent('a', 'idle')], { lastActivityAt: at(90) }),
    ]);
    expect(ordered.map((entry) => entry.sessionId)).toEqual([
      'blocked',
      'working',
      'quiet-new',
      'quiet-old',
    ]);
  });
});

describe('relativeTime', () => {
  const now = Date.parse(T);
  it.each([
    [at(0), 'just now'],
    [at(5), '5m ago'],
    [at(180), '3h ago'],
    [at(60 * 72), '3d ago'],
    [undefined, ''],
    ['not a date', ''],
  ])('%s → %s', (input, expected) => {
    expect(relativeTime(input, now)).toBe(expected);
  });
});

describe('tokenHealth', () => {
  it('counts tokens and warns about expired or soon-expiring ones', () => {
    expect(tokenHealth({ browserTotal: 2, clientTotal: 3, expired: 0, expiringSoon: 0 })).toEqual({
      value: '2 browser · 3 client',
      tone: 'ok',
    });
    expect(tokenHealth({ browserTotal: 2, clientTotal: 3, expired: 1, expiringSoon: 2 })).toEqual({
      value: '2 browser · 3 client · 1 expired · 2 expiring within a day',
      tone: 'warn',
    });
  });

  it('says so when an older server does not report them', () => {
    expect(tokenHealth(undefined)).toEqual({ value: 'Not reported', tone: 'muted' });
  });
});
