/**
 * Overview rules for subagent runs and the HQ server rows, and the command
 * palette's view list.
 */
import type { HqFleetSummary, HqSnapshot } from '@wrongstack/hq';
import { describe, expect, it } from 'vitest';
import { serverHealthRows, subagentRuns } from '../src/features/overview/model';
import { searchHqViews } from '../src/hq/components/hq/views';

// An empty search lists every view, in navigation order.
const HQ_VIEWS = searchHqViews('');

import { HQ_SECTIONS } from '../src/lib/sections';

const T = '2026-11-01T12:00:00.000Z';

const fleet = (runId: string, extra: Partial<HqFleetSummary> = {}): HqFleetSummary => ({
  runId,
  projectId: 'p1',
  clientId: 'c1',
  activeSubagents: 2,
  queuedTasks: 1,
  completedTasks: 5,
  failedTasks: 0,
  lastActivityAt: T,
  ...extra,
});

const snapshot = (fleets: HqFleetSummary[]): HqSnapshot =>
  ({
    generatedAt: T,
    clients: [{ clientId: 'c1', machineId: 'm1', hostname: 'devbox' }],
    projects: [{ projectId: 'p1', projectName: 'alpha' }],
    sessions: [],
    fleets,
    mailboxes: [],
    liveSessions: [{ sessionId: 's1', clientId: 'c1', projectName: 'alpha' }],
    totals: {},
  }) as unknown as HqSnapshot;

describe('subagentRuns', () => {
  it('describes a healthy run with its budget and ceiling', () => {
    const [run] = subagentRuns(
      snapshot([
        fleet('r1', { maxSpawns: 20, usedSpawns: 8, remainingSpawns: 12, maxConcurrent: 4 }),
      ]),
    );
    expect(run).toMatchObject({
      projectName: 'alpha',
      where: 'devbox',
      sessionId: 's1',
      tasks: '2 working · 1 queued · 5 done',
      budget: { used: 8, max: 20, left: 12 },
      concurrency: 'Up to 4 at once',
      warnings: [],
    });
  });

  it('warns when the budget is spent with work queued, tasks failed or the ceiling moved', () => {
    const [run] = subagentRuns(
      snapshot([
        fleet('r1', {
          maxSpawns: 10,
          usedSpawns: 10,
          remainingSpawns: 0,
          queuedTasks: 3,
          failedTasks: 2,
          ceilingMismatch: true,
          checkpointMaxSpawns: 6,
          effectiveSource: 'maxSpawns=env',
        }),
      ]),
    );
    expect(run?.tasks).toBe('2 working · 3 queued · 5 done · 2 failed');
    expect(run?.warnings).toEqual([
      'The spawn limit changed since the checkpoint (was 6, now 10); set by maxSpawns=env.',
      'No spawns left and 3 tasks still queued — raise maxSpawns or the queue stalls.',
      '2 tasks failed.',
    ]);
  });

  it('treats a missing or infinite ceiling as no limit, and puts troubled runs first', () => {
    const runs = subagentRuns(
      snapshot([
        fleet('calm', { usedSpawns: 3, maxSpawns: Number.POSITIVE_INFINITY }),
        fleet('bad', { failedTasks: 1, lastActivityAt: '2026-11-01T11:00:00.000Z' }),
      ]),
    );
    expect(runs.map((run) => run.runId)).toEqual(['bad', 'calm']);
    expect(runs[1]?.budget).toEqual({ used: 3, max: undefined, left: undefined });
    expect(runs[0]?.budget).toBeUndefined();
    expect(subagentRuns(null)).toEqual([]);
  });
});

describe('serverHealthRows', () => {
  const health = {
    status: 'healthy' as const,
    uptime: { serverTime: T, eventLogSize: 10 },
    stores: { events: 'ok', timeseries: 'ok', kanban: 'ok' },
    connections: { total: 2, active: 2, stale: 0 },
    publisherHealth: [
      { clientId: 'a', staleness: 'fresh' as const },
      { clientId: 'b', staleness: 'quiet' as const },
    ],
  };

  it('reports an unreachable or loading server on one row', () => {
    expect(serverHealthRows(null, 'boom', null)).toEqual([
      { label: 'HQ server', value: 'Unreachable', tone: 'warn' },
    ]);
    expect(serverHealthRows(null, null, null)[0]?.tone).toBe('muted');
  });

  it('names the store that degraded and splits publishers', () => {
    const rows = serverHealthRows(
      {
        ...health,
        status: 'degraded',
        stores: { ...health.stores, kanban: 'error' },
        publisherHealth: [...health.publisherHealth, { clientId: 'c', staleness: 'stale' }],
      },
      null,
      null,
    );
    expect(rows).toEqual([
      { label: 'HQ server', value: 'Degraded: kanban store', tone: 'warn' },
      { label: 'Publishers', value: '1 fresh · 1 quiet · 1 stale', tone: 'warn' },
    ]);
  });

  it('adds the mailbox gateways only when the server reports them', () => {
    const rows = serverHealthRows(health, null, {
      gatewayCount: 2,
      gateways: [
        { projectId: 'p1', hasActiveStreams: true },
        { projectId: 'p2', hasActiveStreams: false },
      ],
    });
    expect(rows.map((row) => row.value)).toEqual([
      'Healthy',
      '1 fresh · 1 quiet',
      '2 open · 1 streaming',
    ]);
  });
});

describe('command palette views', () => {
  it('lists every tab of the navigation once, named like the navigation', () => {
    const tabs = HQ_SECTIONS.flatMap((section) => section.tabs.map((tab) => tab.view));
    expect(HQ_VIEWS.map((view) => view.id)).toEqual(tabs);
    expect(HQ_VIEWS.find((view) => view.id === 'cockpit')?.title).toBe('Overview');
    expect(HQ_VIEWS.find((view) => view.id === 'console')?.title).toBe('Fleet · Console');
  });

  it('matches every word, in any order', () => {
    expect(searchHqViews('mcp').map((view) => view.id)).toEqual(['mcp']);
    expect(searchHqViews('console fleet').map((view) => view.id)).toEqual(['console']);
    expect(searchHqViews('  ')).toHaveLength(HQ_VIEWS.length);
    expect(HQ_VIEWS.length).toBeGreaterThan(10);
  });
});
