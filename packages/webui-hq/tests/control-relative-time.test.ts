import { describe, expect, it } from 'vitest';
import type { HqClientRecord, HqSnapshot } from '@wrongstack/core/hq';
import { controlClientLabel, relativeTime } from '../src/domain/control-format.js';

const NOW = new Date('2026-07-10T12:00:00.000Z').getTime();

describe('relativeTime', () => {
  it('renders seconds for the first minute', () => {
    expect(relativeTime('2026-07-10T11:59:48.000Z', NOW)).toBe('12s ago');
    expect(relativeTime('2026-07-10T12:00:00.000Z', NOW)).toBe('0s ago');
  });

  it('renders minutes under an hour', () => {
    expect(relativeTime('2026-07-10T11:57:00.000Z', NOW)).toBe('3m ago');
    expect(relativeTime('2026-07-10T11:01:00.000Z', NOW)).toBe('59m ago');
  });

  it('falls back to clock time past an hour', () => {
    const out = relativeTime('2026-07-10T09:00:00.000Z', NOW);
    expect(out.endsWith('ago')).toBe(false);
    expect(out.length).toBeGreaterThan(0);
  });

  it('clamps future timestamps to "now" instead of negative ages', () => {
    expect(relativeTime('2026-07-10T12:00:05.000Z', NOW)).toBe('0s ago');
  });

  it('passes malformed timestamps through untouched', () => {
    expect(relativeTime('not-a-date', NOW)).toBe('not-a-date');
  });
});

describe('controlClientLabel', () => {
  it('identifies host, project, process and session instead of a bare client id', () => {
    const client: HqClientRecord = {
      clientId: 'client-1234567890',
      kind: 'tui',
      machineId: 'machine-1',
      hostname: 'devbox',
      pid: 4242,
      connected: true,
      lastSeenAt: '2026-07-10T12:00:00.000Z',
      projectId: 'project-1',
      capabilities: ['control.receive'],
    };
    const snapshot = {
      generatedAt: '2026-07-10T12:00:00.000Z',
      clients: [client],
      projects: [
        {
          projectId: 'project-1',
          projectName: 'WrongStack',
          projectRootDisplay: '/work/wrongstack',
          machineIds: ['machine-1'],
          activeClients: 1,
          activeSessions: 1,
          activeSubagents: 0,
          totalCostUsd: 0,
          lastActivityAt: '2026-07-10T12:00:00.000Z',
          status: 'active',
        },
      ],
      sessions: [],
      fleets: [],
      mailboxes: [],
      liveSessions: [
        {
          sessionId: 'session-abcdef',
          clientId: client.clientId,
          clientKind: 'tui',
          machineId: 'machine-1',
          pid: 4242,
          projectId: 'project-1',
          projectName: 'WrongStack',
          projectRoot: '/work/wrongstack',
          status: 'active',
          startedAt: '2026-07-10T11:00:00.000Z',
          lastActivityAt: '2026-07-10T12:00:00.000Z',
          agentCount: 1,
          agents: [],
        },
      ],
      totals: {
        activeProjects: 1,
        activeClients: 1,
        activeSessions: 1,
        activeSubagents: 0,
        unreadMailboxMessages: 0,
        incompleteMailboxMessages: 0,
        totalCostUsd: 0,
      },
    } satisfies HqSnapshot;

    expect(controlClientLabel(client, snapshot)).toBe(
      'devbox › WrongStack › TUI · pid 4242 › session-abcdef',
    );
  });
});
