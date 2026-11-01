/**
 * Shared attention-queue rules that the Overview and the Inbox both depend on.
 */
import type { HqAlert, HqAlertMessage, HqSnapshot } from '@wrongstack/hq';
import { describe, expect, it } from 'vitest';
import {
  buildAttentionItems,
  inboxItemHref,
  overviewTarget,
  remainingLabel,
} from '../src/features/attention/model';

const T = '2026-10-31T12:00:00.000Z';
const empty = {
  snapshot: null as HqSnapshot | null,
  approvals: [],
  questions: [],
  alerts: [],
  commands: [],
};

const rule = (id: string, severity: HqAlert['severity'], message: string): HqAlert => ({
  id,
  ruleId: `rule-${id}`,
  severity,
  message,
  firstFiredAt: Date.parse(T) - 600_000,
  lastFiredAt: Date.parse(T),
});

describe('alerts in the queue', () => {
  it('includes rules that were already firing before the page loaded', () => {
    const items = buildAttentionItems({
      ...empty,
      activeAlerts: [rule('1', 'error', 'Budget 80% used'), rule('2', 'info', 'Nightly digest')],
    });
    expect(items.map((item) => [item.id, item.tone, item.context])).toEqual([
      ['rule:1', 'critical', 'Alert rule rule-1 · firing'],
    ]);
  });

  it('shows a live alert once when it repeats a firing rule, and dedupes repeats', () => {
    const live: HqAlertMessage[] = [
      { type: 'hq.alert', severity: 'error', message: 'Budget 80% used', timestamp: T },
      { type: 'hq.alert', severity: 'warn', message: 'Machine kestrel stale', timestamp: T },
      { type: 'hq.alert', severity: 'warn', message: 'Machine kestrel stale', timestamp: T },
    ];
    const items = buildAttentionItems({
      ...empty,
      alerts: live,
      activeAlerts: [rule('1', 'error', 'Budget 80% used')],
    });
    expect(items.map((item) => item.id)).toEqual(['rule:1', `alert:${T}:Machine kestrel stale`]);
  });
});

describe('approvals in the queue', () => {
  it('treats a governance-boundary prompt as urgent even when the tool is not destructive', () => {
    const [item] = buildAttentionItems({
      ...empty,
      approvals: [
        {
          toolUseId: 'tu-1',
          toolName: 'write_file',
          projectId: 'p1',
          destructive: false,
          riskTier: 'standard',
          boundaryReason: 'Writes outside the project root',
          requestedAt: T,
        },
      ],
    });
    expect(item).toMatchObject({
      tone: 'critical',
      context: 'p1 · governance boundary',
      sourceId: 'tu-1',
    });
  });
});

describe('routing', () => {
  it('sends blocked agents straight to their conversation and everything else to its card', () => {
    const items = buildAttentionItems({
      ...empty,
      snapshot: {
        generatedAt: T,
        clients: [
          {
            clientId: 'c1',
            kind: 'cli',
            machineId: 'm1',
            connected: false,
            lastSeenAt: T,
            projectId: 'p1',
            capabilities: [],
          },
        ],
        projects: [],
        sessions: [],
        fleets: [],
        mailboxes: [],
        liveSessions: [
          {
            sessionId: 's1',
            clientKind: 'tui',
            machineId: 'm1',
            projectId: 'p1',
            projectName: 'p1',
            projectRoot: '/p1',
            status: 'active',
            startedAt: T,
            lastActivityAt: T,
            agentCount: 1,
            agents: [
              {
                id: 'a1',
                name: 'a1',
                status: 'error',
                iterations: 0,
                toolCalls: 0,
                lastActivityAt: T,
              },
            ],
          },
        ],
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
    const agent = items.find((item) => item.kind === 'agent');
    const client = items.find((item) => item.kind === 'client');
    expect(agent && overviewTarget(agent)).toBe('/fleet/console/');
    expect(client && overviewTarget(client)).toBe('/inbox/?item=client%3Ac1');
  });

  it('encodes ids so alert messages survive the round trip through the URL', () => {
    const id = `alert:${T}:Budget 80% used & rising`;
    const href = inboxItemHref(id);
    expect(new URL(href, 'http://hq').searchParams.get('item')).toBe(id);
  });
});

describe('remainingLabel', () => {
  it.each([
    [45_000, '45s left'],
    [125_000, '2m 05s left'],
    [-5, '0s left'],
  ])('%i ms → %s', (ms, label) => {
    expect(remainingLabel(ms)).toBe(label);
  });
});

describe('stalled runs and failing MCP servers in the queue', () => {
  const snapshot = (extra: Partial<HqSnapshot>): HqSnapshot =>
    ({
      generatedAt: T,
      clients: [{ clientId: 'c1', machineId: 'm1', hostname: 'devbox', connected: true }],
      projects: [{ projectId: 'p1', projectName: 'alpha' }],
      sessions: [],
      fleets: [],
      mailboxes: [],
      liveSessions: [{ sessionId: 's 1', clientId: 'c1' }],
      totals: {},
      ...extra,
    }) as unknown as HqSnapshot;
  const fleet = (runId: string, remainingSpawns: number | undefined, queuedTasks: number) => ({
    runId,
    projectId: 'p1',
    clientId: 'c1',
    activeSubagents: 0,
    queuedTasks,
    completedTasks: 3,
    failedTasks: 1,
    lastActivityAt: T,
    remainingSpawns,
  });

  it('flags only a run that is out of spawns with work still queued', () => {
    const items = buildAttentionItems({
      ...empty,
      snapshot: snapshot({
        fleets: [fleet('stalled', 0, 2), fleet('drained', 0, 0), fleet('room', 3, 5)],
      }),
    });
    expect(items.map((item) => [item.id, item.title, item.context, item.href])).toEqual([
      [
        'run:stalled',
        'Subagent run in alpha is out of spawns',
        '2 queued tasks cannot start',
        '/fleet/console/?session=s%201',
      ],
    ]);
  });

  it('flags failing and degraded MCP servers once per terminal and links to the row', () => {
    const server = (name: string, healthState: string) =>
      ({ name, projectId: 'p1', clientId: 'c1', healthState, lastFailureAt: T }) as never;
    const items = buildAttentionItems({
      ...empty,
      snapshot: snapshot({
        mcpServers: [
          server('db', 'failed'),
          server('db', 'failed'),
          server('search', 'degraded'),
          server('github', 'healthy'),
        ],
      }),
    });
    expect(items.map((item) => [item.title, item.context, item.href])).toEqual([
      ['MCP server db is failing', 'alpha · devbox', '/system/mcp/?server=c1%3Adb'],
      ['MCP server search is degraded', 'alpha · devbox', '/system/mcp/?server=c1%3Asearch'],
    ]);
  });
});

describe('machines that dropped out of the fleet', () => {
  const known = (key: string, hostname: string, lastSeenAt: string) => ({
    key,
    hostname,
    machineIds: ['m'],
    projects: [{ projectId: 'p', projectName: 'Datapipe' }],
    firstSeenAt: '2026-10-01T00:00:00.000Z',
    lastSeenAt,
  });
  const snapshot = {
    generatedAt: T,
    clients: [],
    projects: [],
    offlineMachines: [
      known('host:lab-02', 'LAB-02', '2026-10-31T11:00:00.000Z'),
      // Two days ago: still listed on Machines, no longer asking for attention.
      known('host:old', 'OLD', '2026-10-29T11:00:00.000Z'),
    ],
  } as unknown as HqSnapshot;

  it('asks for attention for a day after a machine goes offline, then stops', () => {
    const items = buildAttentionItems({ ...empty, snapshot });
    expect(items.map((item) => [item.id, item.kind, item.title, item.context])).toEqual([
      ['machine:host:lab-02', 'machine', 'LAB-02 went offline', 'Datapipe'],
    ]);
    expect(items[0]?.href).toBe('/fleet/machines/?machine=host%3Alab-02');
    expect(items[0]?.origin).toEqual({ machineKey: 'host:lab-02' });
  });
});
