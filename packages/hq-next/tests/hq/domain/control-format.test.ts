/**
 * Timestamp rendering rules that are easy to get subtly wrong and hard to see
 * in a screenshot: an epoch sentinel must read as "never", not as a wall clock
 * that makes a never-synced board look freshly synced.
 */
import { describe, expect, it } from 'vitest';
import { relativeTime, shortId } from '../../../src/hq/domain/control-format.js';

const NOW = Date.parse('2026-09-02T13:00:00.000Z');

describe('relativeTime', () => {
  it('reads seconds and minutes as recency', () => {
    expect(relativeTime(new Date(NOW - 12_000).toISOString(), NOW)).toBe('12s ago');
    expect(relativeTime(new Date(NOW - 180_000).toISOString(), NOW)).toBe('3m ago');
  });

  it('falls back to a clock time past the hour', () => {
    const older = new Date(NOW - 7_200_000);
    expect(relativeTime(older.toISOString(), NOW)).toBe(older.toLocaleTimeString());
  });

  it('calls the unix epoch "never" — it is a sentinel, not a 1970 event', () => {
    // The HQ kanban store returns exactly this for a project with no board.
    expect(relativeTime(new Date(0).toISOString(), NOW)).toBe('never');
  });

  it('passes an unparseable timestamp through rather than inventing a date', () => {
    expect(relativeTime('not-a-date', NOW)).toBe('not-a-date');
  });
});

describe('shortId', () => {
  it('leaves a short id alone and truncates a long one', () => {
    expect(shortId('leader')).toBe('leader');
    expect(shortId('01J8ZQ7X9K2M4P6R8T0V2X4Z6A').length).toBeLessThan(
      '01J8ZQ7X9K2M4P6R8T0V2X4Z6A'.length,
    );
  });
});

describe('controlClientLabel', () => {
  it('formats client label with version when available', async () => {
    const { controlClientLabel } = await import('../../../src/hq/domain/control-format.js');
    const client = {
      clientId: 'c1',
      kind: 'tui' as const,
      version: '1.0.16',
      machineId: 'm1',
      hostname: 'devbox',
      connected: true,
      lastSeenAt: '2026-09-02T13:00:00.000Z',
      projectId: 'p1',
      capabilities: [],
    };
    const snapshot = {
      generatedAt: '2026-09-02T13:00:00.000Z',
      clients: [client],
      projects: [
        {
          projectId: 'p1',
          projectName: 'WrongStack',
          projectRootDisplay: '/p1',
          machineIds: ['m1'],
          activeClients: 1,
          activeSessions: 0,
          activeSubagents: 0,
          totalCostUsd: 0,
          lastActivityAt: '2026-09-02T13:00:00.000Z',
          status: 'active' as const,
        },
      ],
      sessions: [],
      fleets: [],
      mailboxes: [],
      totals: {
        activeProjects: 1,
        activeClients: 1,
        activeSessions: 0,
        activeSubagents: 0,
        unreadMailboxMessages: 0,
        incompleteMailboxMessages: 0,
        totalCostUsd: 0,
      },
    };
    const label = controlClientLabel(client, snapshot);
    expect(label).toContain('TUI (v1.0.16)');
    expect(label).toContain('devbox › WrongStack');
  });
});
