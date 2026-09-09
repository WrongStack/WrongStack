/**
 * The sidebar's Projects -> Sessions model.
 *
 * These cover the rules that decide what the user sees in the left menu:
 * which projects get a row, how several runtimes on one root combine into one
 * status, and the ordering that keeps the list from reshuffling while work is
 * running.
 */
import { describe, expect, it } from 'vitest';
import {
  buildProjectTree,
  filterProjectTree,
  relativeTime,
} from '../src/renderer/src/project-tree.js';
import type { DesktopRuntimeRecord, DesktopStateSnapshot } from '../src/shared/types.js';

function runtime(over: Partial<DesktopRuntimeRecord> & { id: string; root: string }) {
  return {
    name: 'rt',
    slug: 'rt',
    kind: 'project' as const,
    status: 'running' as const,
    httpPort: 34560,
    wsPort: 34660,
    url: 'http://127.0.0.1:34560',
    startedAt: '2026-09-09T10:00:00.000Z',
    ...over,
  } satisfies DesktopRuntimeRecord;
}

function snapshot(over: Partial<DesktopStateSnapshot> = {}): DesktopStateSnapshot {
  return {
    activeRuntimeId: null,
    runtimes: [],
    recentProjects: [],
    registeredProjects: [],
    restoring: false,
    ...over,
  };
}

describe('buildProjectTree', () => {
  it('gives a registered project a row even with nothing running', () => {
    const tree = buildProjectTree(
      snapshot({
        registeredProjects: [{ name: 'Alpha', root: '/repos/alpha', slug: 'alpha' }],
      }),
    );
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({
      name: 'Alpha',
      status: 'stopped',
      registered: true,
      primaryRuntimeId: null,
    });
  });

  it('gives an ad-hoc runtime a row even when nothing registered its root', () => {
    // Opening a folder directly must not start something the sidebar hides.
    const tree = buildProjectTree(
      snapshot({ runtimes: [runtime({ id: 'r1', root: '/tmp/scratch', name: 'scratch' })] }),
    );
    expect(tree.map((n) => n.name)).toEqual(['scratch']);
    expect(tree[0]?.primaryRuntimeId).toBe('r1');
  });

  it('collapses several runtimes on one root into a single row', () => {
    const tree = buildProjectTree(
      snapshot({
        runtimes: [
          runtime({ id: 'r1', root: '/repos/alpha', startedAt: '2026-09-09T09:00:00.000Z' }),
          runtime({ id: 'r2', root: '/repos/alpha', startedAt: '2026-09-09T11:00:00.000Z' }),
        ],
      }),
    );
    expect(tree).toHaveLength(1);
    // Newest first, so the row's detail view leads with current work.
    expect(tree[0]?.runtimes.map((r) => r.id)).toEqual(['r2', 'r1']);
  });

  it('treats the same root written differently as one project', () => {
    const tree = buildProjectTree(
      snapshot({
        registeredProjects: [{ name: 'Alpha', root: 'C:\\repos\\alpha', slug: 'alpha' }],
        runtimes: [runtime({ id: 'r1', root: 'c:/repos/alpha/' })],
      }),
    );
    expect(tree).toHaveLength(1);
    expect(tree[0]?.primaryRuntimeId).toBe('r1');
  });

  it('surfaces an error over a healthy sibling runtime', () => {
    // A project whose runtime died must not read as "stopped" or "running".
    const tree = buildProjectTree(
      snapshot({
        runtimes: [
          runtime({ id: 'r1', root: '/repos/alpha', status: 'running' }),
          runtime({ id: 'r2', root: '/repos/alpha', status: 'error' }),
        ],
      }),
    );
    expect(tree[0]?.status).toBe('error');
  });

  it('prefers starting over running when both are present', () => {
    const tree = buildProjectTree(
      snapshot({
        runtimes: [
          runtime({ id: 'r1', root: '/repos/alpha', status: 'running' }),
          runtime({ id: 'r2', root: '/repos/alpha', status: 'starting' }),
        ],
      }),
    );
    expect(tree[0]?.status).toBe('starting');
  });

  it('points a row at the active runtime when one of its runtimes is active', () => {
    const tree = buildProjectTree(
      snapshot({
        activeRuntimeId: 'r2',
        runtimes: [
          runtime({ id: 'r1', root: '/repos/alpha' }),
          runtime({ id: 'r2', root: '/repos/alpha' }),
        ],
      }),
    );
    expect(tree[0]?.active).toBe(true);
    expect(tree[0]?.primaryRuntimeId).toBe('r2');
  });

  it('skips a stopped runtime when choosing what a row click activates', () => {
    const tree = buildProjectTree(
      snapshot({
        runtimes: [
          runtime({
            id: 'r1',
            root: '/repos/alpha',
            status: 'stopped',
            startedAt: '2026-09-09T12:00:00.000Z',
          }),
          runtime({
            id: 'r2',
            root: '/repos/alpha',
            status: 'running',
            startedAt: '2026-09-09T09:00:00.000Z',
          }),
        ],
      }),
    );
    expect(tree[0]?.primaryRuntimeId).toBe('r2');
  });

  it('puts open projects first, then most recently seen', () => {
    const tree = buildProjectTree(
      snapshot({
        registeredProjects: [
          { name: 'Cold', root: '/repos/cold', slug: 'cold', lastSeen: '2026-09-01T00:00:00.000Z' },
          { name: 'Warm', root: '/repos/warm', slug: 'warm', lastSeen: '2026-09-08T00:00:00.000Z' },
          { name: 'Open', root: '/repos/open', slug: 'open', lastSeen: '2026-01-01T00:00:00.000Z' },
        ],
        runtimes: [runtime({ id: 'r1', root: '/repos/open' })],
      }),
    );
    // "Open" sorts first despite the oldest lastSeen: a running project is the
    // one being worked in.
    expect(tree.map((n) => n.name)).toEqual(['Open', 'Warm', 'Cold']);
  });

  it('marks a project registered even when it is also merely recent', () => {
    const tree = buildProjectTree(
      snapshot({
        registeredProjects: [{ name: 'Alpha', root: '/repos/alpha', slug: 'alpha' }],
        recentProjects: [{ name: 'Alpha', root: '/repos/alpha', slug: 'alpha' }],
      }),
    );
    expect(tree).toHaveLength(1);
    expect(tree[0]?.registered).toBe(true);
  });

  it('falls back to the directory name when a project has none', () => {
    const tree = buildProjectTree(
      snapshot({ registeredProjects: [{ name: '', root: '/repos/deep/nested', slug: 'n' }] }),
    );
    expect(tree[0]?.name).toBe('nested');
  });
});

describe('filterProjectTree', () => {
  const tree = buildProjectTree(
    snapshot({
      registeredProjects: [
        { name: 'WrongStack', root: '/repos/wrongstack', slug: 'ws' },
        { name: 'Telegram Bot', root: '/work/tg-bot', slug: 'tg' },
      ],
    }),
  );

  it('returns the same array when the query is empty', () => {
    // Identity matters: a memoised list must not re-render on a cleared filter.
    expect(filterProjectTree(tree, '   ')).toBe(tree);
  });

  it('matches on name and on path', () => {
    expect(filterProjectTree(tree, 'wrong').map((n) => n.name)).toEqual(['WrongStack']);
    expect(filterProjectTree(tree, '/work/').map((n) => n.name)).toEqual(['Telegram Bot']);
  });

  it('is case insensitive', () => {
    expect(filterProjectTree(tree, 'TELEGRAM')).toHaveLength(1);
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-09-09T12:00:00.000Z');

  it('renders the units a session row needs', () => {
    expect(relativeTime('2026-09-09T11:59:30.000Z', now)).toBe('now');
    expect(relativeTime('2026-09-09T11:30:00.000Z', now)).toBe('30m');
    expect(relativeTime('2026-09-09T09:00:00.000Z', now)).toBe('3h');
    expect(relativeTime('2026-09-07T12:00:00.000Z', now)).toBe('2d');
    expect(relativeTime('2026-08-26T12:00:00.000Z', now)).toBe('2w');
  });

  it('is blank for a missing or unparseable timestamp', () => {
    expect(relativeTime(undefined, now)).toBe('');
    expect(relativeTime('not a date', now)).toBe('');
  });
});
