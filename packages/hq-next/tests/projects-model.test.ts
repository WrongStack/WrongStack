/**
 * Project summaries: where each project runs, what is working on it, its mail
 * and spend, which queue items belong to it, and projects HQ only remembers
 * through machines that went offline.
 */
import type { HqSnapshot } from '@wrongstack/hq';
import { describe, expect, it } from 'vitest';
import type { AttentionItem } from '../src/features/attention/model';
import {
  projectSentence,
  projectSummaries,
  projectWhere,
  startSessionTargets,
} from '../src/features/projects/model';

const T = '2026-11-01T12:00:00.000Z';
const snapshot = {
  clients: [
    { clientId: 'c1', machineId: 'm1', hostname: 'Desk', projectId: 'alpha', connected: true },
    { clientId: 'c2', machineId: 'm2', hostname: 'lab', projectId: 'alpha', connected: true },
    { clientId: 'c3', machineId: 'm3', hostname: 'old', projectId: 'beta', connected: false },
  ],
  projects: [
    {
      projectId: 'alpha',
      projectName: 'Alpha',
      projectRootDisplay: '~/alpha',
      machineIds: ['m1', 'm2'],
      gitBranch: 'main',
      status: 'active',
      totalCostUsd: 2.5,
      lastActivityAt: '2026-11-01T11:00:00.000Z',
    },
    {
      projectId: 'beta',
      projectName: 'Beta',
      projectRootDisplay: '~/beta',
      machineIds: ['m3'],
      status: 'idle',
      totalCostUsd: 0.25,
      lastActivityAt: '2026-11-01T11:30:00.000Z',
    },
  ],
  machines: [],
  sessions: [],
  liveSessions: [
    {
      sessionId: 's1',
      machineId: 'm1',
      hostname: 'Desk',
      clientKind: 'tui',
      projectId: 'alpha',
      lastActivityAt: T,
      agents: [{ status: 'running' }, { status: 'idle' }],
    },
    {
      sessionId: 's2',
      machineId: 'm2',
      hostname: 'lab',
      clientKind: 'cli',
      projectId: 'alpha',
      lastActivityAt: '2026-11-01T10:00:00.000Z',
      agents: [{ status: 'idle' }],
    },
  ],
  mailboxes: [
    { projectId: 'alpha', unreadCount: 2, incompleteCount: 1 },
    { projectId: 'beta', unreadCount: 0, incompleteCount: 0 },
  ],
  offlineMachines: [
    {
      key: 'host:attic',
      hostname: 'attic',
      machineIds: ['m9'],
      projects: [
        { projectId: 'gamma', projectName: 'Gamma' },
        { projectId: 'alpha', projectName: 'Alpha' },
      ],
      firstSeenAt: '2026-10-01T00:00:00.000Z',
      lastSeenAt: '2026-10-30T00:00:00.000Z',
    },
  ],
  fleets: [],
  totals: {},
} as unknown as HqSnapshot;

const item = (id: string, origin: AttentionItem['origin']): AttentionItem =>
  ({
    id,
    kind: 'approval',
    tone: 'warning',
    title: id,
    context: '',
    at: T,
    href: '/',
    origin,
  }) as AttentionItem;

describe('projectSummaries', () => {
  it('folds machines, live sessions, mail and spend per project', () => {
    const alpha = projectSummaries(snapshot, []).find((p) => p.projectId === 'alpha');
    expect(alpha).toMatchObject({
      projectName: 'Alpha',
      root: '~/alpha',
      gitBranch: 'main',
      status: 'active',
      agents: 3,
      working: 1,
      costUsd: 2.5,
      unreadMail: 2,
      openMail: 1,
    });
    expect(alpha?.machines).toEqual([
      { key: 'host:desk', hostname: 'Desk', online: true },
      { key: 'host:lab', hostname: 'lab', online: true },
      // Ran there too; that machine is offline now (roster).
      { key: 'host:attic', hostname: 'attic', online: false },
    ]);
    // Newest activity first.
    expect(alpha?.sessions.map((session) => session.sessionId)).toEqual(['s1', 's2']);
    expect(projectSentence(alpha!)).toBe('1 of 3 agents working');
    expect(projectWhere(alpha!)).toBe('on Desk, lab · 1 offline');
  });

  it('marks machines whose client is gone as offline', () => {
    const beta = projectSummaries(snapshot, []).find((p) => p.projectId === 'beta');
    expect(beta?.machines).toEqual([{ key: 'host:old', hostname: 'old', online: false }]);
    expect(projectSentence(beta!)).toBe('No session open');
    expect(projectWhere(beta!)).toBe('1 machine, offline');
  });

  it('lists projects known only from offline machines as remembered, once', () => {
    const summaries = projectSummaries(snapshot, []);
    const gamma = summaries.filter((p) => p.projectId === 'gamma');
    expect(gamma).toHaveLength(1);
    expect(gamma[0]).toMatchObject({
      status: 'remembered',
      machines: [{ key: 'host:attic', hostname: 'attic', online: false }],
      lastActivityAt: '2026-10-30T00:00:00.000Z',
    });
    expect(projectSentence(gamma[0]!)).toBe('Not running anywhere now');
    // A live project is never duplicated by the roster.
    expect(summaries.filter((p) => p.projectId === 'alpha')).toHaveLength(1);
  });

  it('attaches only items that strictly belong to the project', () => {
    const summaries = projectSummaries(snapshot, [
      item('by-project', { projectId: 'beta' }),
      item('by-client', { clientId: 'c1' }),
      item('unknown', {}),
      item('no-origin', undefined),
    ]);
    const ids = (projectId: string): string[] =>
      summaries.find((p) => p.projectId === projectId)?.attention.map((a) => a.id) ?? [];
    expect(ids('alpha')).toEqual(['by-client']);
    expect(ids('beta')).toEqual(['by-project']);
    expect(ids('gamma')).toEqual([]);
  });

  it('puts projects that need a person first, then running work, remembered last', () => {
    const order = projectSummaries(snapshot, [item('q', { projectId: 'beta' })]).map(
      (p) => p.projectId,
    );
    expect(order).toEqual(['beta', 'alpha', 'gamma']);
    expect(projectSummaries(snapshot, []).map((p) => p.projectId)).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
  });

  it('returns nothing before the first snapshot', () => {
    expect(projectSummaries(null, [])).toEqual([]);
  });
});

describe('startSessionTargets', () => {
  it('offers only connected clients of the project that announce session.start', () => {
    const withCaps = {
      ...snapshot,
      clients: [
        {
          clientId: 'b',
          machineId: 'm2',
          hostname: 'lab',
          projectId: 'alpha',
          connected: true,
          kind: 'cli',
          capabilities: ['session.start'],
        },
        {
          clientId: 'a',
          machineId: 'm1',
          hostname: 'Desk',
          projectId: 'alpha',
          connected: true,
          kind: 'tui',
          capabilities: ['session.start'],
        },
        {
          clientId: 'c',
          machineId: 'm3',
          hostname: 'old',
          projectId: 'alpha',
          connected: false,
          kind: 'tui',
          capabilities: ['session.start'],
        },
        {
          clientId: 'd',
          machineId: 'm1',
          hostname: 'Desk',
          projectId: 'alpha',
          connected: true,
          kind: 'webui',
          capabilities: ['control.receive'],
        },
        {
          clientId: 'e',
          machineId: 'm1',
          hostname: 'Desk',
          projectId: 'beta',
          connected: true,
          kind: 'tui',
          capabilities: ['session.start'],
        },
      ],
    } as unknown as HqSnapshot;
    expect(startSessionTargets(withCaps, 'alpha')).toEqual([
      { clientId: 'a', hostname: 'Desk', kind: 'tui' },
      { clientId: 'b', hostname: 'lab', kind: 'cli' },
    ]);
    expect(startSessionTargets(withCaps, 'gamma')).toEqual([]);
    expect(startSessionTargets(null, 'alpha')).toEqual([]);
  });
});
