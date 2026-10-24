import {
  formatWorktreeDuration,
  normalizeWorktreeEvent,
  projectWorktreeTimeline,
  shortWorktreeBranch,
  WORKTREE_EVENT_NAMES,
  type WorktreeTimelineEvent,
  worktreeTimelineTicks,
} from '@wrongstack/contracts/types/worktree-timeline';
import { describe, expect, it } from 'vitest';

const ev = (
  kind: WorktreeTimelineEvent['kind'],
  at: number,
  handleId: string,
  extra: Partial<WorktreeTimelineEvent> = {},
): WorktreeTimelineEvent => ({ kind, at, handleId, ...extra });

const allocated = (at: number, id: string, extra: Partial<WorktreeTimelineEvent> = {}) =>
  ev('allocated', at, id, {
    ownerId: `owner-${id}`,
    ownerLabel: `Phase ${id}`,
    branch: `wstack/ap/${id}`,
    baseBranch: 'main',
    ...extra,
  });

describe('normalizeWorktreeEvent', () => {
  it('accepts bus names and bare HQ kinds, keeps known fields only', () => {
    const fromBus = normalizeWorktreeEvent(
      'worktree.failed',
      { handleId: 'a', ownerId: 'o', error: 'lint failed', stage: 'commit', at: 5, junk: 1 },
      99,
    );
    expect(fromBus).toEqual({
      kind: 'failed',
      at: 5,
      handleId: 'a',
      ownerId: 'o',
      error: 'lint failed',
      stage: 'commit',
    });
    expect(normalizeWorktreeEvent('merged', { handleId: 'a' }, 42)).toEqual({
      kind: 'merged',
      at: 42,
      handleId: 'a',
    });
  });

  it('rejects non-worktree events, missing handles and bogus stages', () => {
    expect(normalizeWorktreeEvent('worktree.exploded', { handleId: 'a' }, 1)).toBeNull();
    expect(normalizeWorktreeEvent('worktree.merged', { ownerId: 'o' }, 1)).toBeNull();
    expect(normalizeWorktreeEvent('worktree.merged', null, 1)).toBeNull();
    expect(
      normalizeWorktreeEvent('worktree.failed', { handleId: 'a', stage: 'other' }, 1)?.stage,
    ).toBeUndefined();
  });

  it('lists every lifecycle event name, merging included', () => {
    expect(WORKTREE_EVENT_NAMES).toContain('worktree.merging');
    expect(new Set(WORKTREE_EVENT_NAMES).size).toBe(7);
  });
});

describe('projectWorktreeTimeline', () => {
  it('splits a merged worktree into working → queued → merging and marks the base commit', () => {
    const t = projectWorktreeTimeline(
      [
        allocated(1000, 'api'),
        ev('committed', 5000, 'api', {
          committed: true,
          insertions: 12,
          deletions: 3,
          files: 2,
          sha: 'abc',
        }),
        ev('merging', 9000, 'api'),
        ev('merged', 9500, 'api', { baseBranch: 'main' }),
        ev('released', 9600, 'api', { kept: false }),
      ],
      { now: 20_000 },
    );
    const lane = t.lanes[0]!;
    expect(lane.segments).toEqual([
      { phase: 'working', start: 1000, end: 5000 },
      { phase: 'queued', start: 5000, end: 9000 },
      { phase: 'merging', start: 9000, end: 9500 },
    ]);
    expect(lane).toMatchObject({
      outcome: 'merged',
      mergedAt: 9500,
      onDisk: false,
      insertions: 12,
      deletions: 3,
      files: 2,
      sha: 'abc',
      ownerLabel: 'Phase api',
    });
    expect(t.baseCommits).toEqual([{ at: 9500, handleId: 'api', branch: 'wstack/ap/api' }]);
    expect(t.avgQueueMs).toBe(4000);
    expect(t.counts.merged).toBe(1);
    // Nothing open → the axis ends at the last event, not at `now`.
    expect(t.end).toBe(9600);
    expect(t.baseBranch).toBe('main');
  });

  it('keeps a hook-refused commit as a failed, on-disk lane without stretching the axis', () => {
    const t = projectWorktreeTimeline(
      [
        allocated(0, 'db'),
        ev('failed', 3000, 'db', { error: 'lint-staged failed', stage: 'commit' }),
        ev('released', 3100, 'db', { kept: true }),
      ],
      { now: 10_000 },
    );
    const lane = t.lanes[0]!;
    expect(lane.outcome).toBe('failed');
    expect(lane.failedStage).toBe('commit');
    expect(lane.error).toBe('lint-staged failed');
    expect(lane.onDisk).toBe(true);
    expect(lane.segments).toEqual([
      { phase: 'working', start: 0, end: 3000 },
      { phase: 'kept', start: 3000 },
    ]);
    // Parked for review is not running: the axis ends at the last event.
    expect(t.end).toBe(3100);
  });

  it('parks a conflict with its files, and the cleanup sweep closes every kept lane', () => {
    const t = projectWorktreeTimeline(
      [
        allocated(0, 'docs'),
        ev('committed', 100, 'docs', { committed: true }),
        ev('merging', 200, 'docs'),
        ev('conflict', 300, 'docs', { conflictFiles: ['README.md'] }),
        ev('released', 310, 'docs', { kept: true }),
        ev('released', 900, 'cleanup-all', { kept: false }),
      ],
      { now: 5000 },
    );
    const lane = t.lanes[0]!;
    expect(lane.outcome).toBe('conflict');
    expect(lane.conflictFiles).toEqual(['README.md']);
    expect(lane.onDisk).toBe(false);
    expect(lane.segments.at(-1)).toEqual({ phase: 'kept', start: 300, end: 900 });
    expect(t.lanes).toHaveLength(1);
  });

  it('marks released-without-merge as discarded and auto-merge-off as kept', () => {
    const t = projectWorktreeTimeline(
      [
        allocated(0, 'noop'),
        ev('committed', 50, 'noop', { committed: false }),
        ev('released', 60, 'noop', { kept: false }),
        allocated(0, 'parked'),
        ev('committed', 70, 'parked', { committed: true }),
        ev('released', 80, 'parked', { kept: true }),
      ],
      { now: 1000 },
    );
    const byId = Object.fromEntries(t.lanes.map((l) => [l.handleId, l]));
    expect(byId['noop']).toMatchObject({ outcome: 'discarded', onDisk: false, commits: [] });
    expect(byId['noop']!.segments).toEqual([{ phase: 'working', start: 0, end: 60 }]);
    expect(byId['parked']).toMatchObject({ outcome: 'kept', onDisk: true });
    expect(byId['parked']!.segments.at(-1)).toEqual({ phase: 'kept', start: 80 });
  });

  it('sorts out-of-order events and survives a gap where allocated was never seen', () => {
    const t = projectWorktreeTimeline(
      [
        ev('merged', 900, 'late', { branch: 'wstack/ap/late' }),
        ev('committed', 400, 'late', { committed: true }),
        ev('merging', 800, 'late'),
      ],
      { now: 1000 },
    );
    const lane = t.lanes[0]!;
    expect(lane.start).toBe(400);
    expect(lane.outcome).toBe('merged');
    expect(lane.segments).toEqual([
      { phase: 'queued', start: 400, end: 800 },
      { phase: 'merging', start: 800, end: 900 },
    ]);
  });

  it('shows a live lane with an open segment and extends the axis to now', () => {
    const t = projectWorktreeTimeline([allocated(1000, 'ui')], { now: 4000 });
    expect(t.lanes[0]).toMatchObject({ outcome: 'live', onDisk: true, end: undefined });
    expect(t.lanes[0]!.segments).toEqual([{ phase: 'working', start: 1000 }]);
    expect(t).toMatchObject({ start: 1000, end: 4000 });
    expect(t.counts.live).toBe(1);
  });

  it('scopes to one session and keeps only the newest lanes', () => {
    const events = [
      allocated(0, 'a', { sessionId: 's1' }),
      allocated(1, 'b', { sessionId: 's2' }),
      allocated(2, 'c', { sessionId: 's1' }),
      allocated(3, 'd', { sessionId: 's1' }),
    ];
    expect(
      projectWorktreeTimeline(events, { now: 10, sessionId: 's1' }).lanes.map((l) => l.handleId),
    ).toEqual(['a', 'c', 'd']);
    expect(
      projectWorktreeTimeline(events, { now: 10, maxLanes: 2 }).lanes.map((l) => l.handleId),
    ).toEqual(['c', 'd']);
  });

  it('applies untagged follow-up events (panel remove, cleanup sweep) to a session worktree', () => {
    const t = projectWorktreeTimeline(
      [
        allocated(0, 'a', { sessionId: 's1' }),
        ev('failed', 10, 'a', { sessionId: 's1', stage: 'merge' }),
        ev('released', 20, 'a'),
        allocated(0, 'b', { sessionId: 's1' }),
        ev('conflict', 10, 'b', { sessionId: 's1' }),
        ev('released', 30, 'cleanup-all'),
      ],
      { now: 100, sessionId: 's1' },
    );
    const byId = Object.fromEntries(t.lanes.map((l) => [l.handleId, l]));
    expect(byId['a']).toMatchObject({ outcome: 'failed', onDisk: false, end: 20 });
    expect(byId['b']).toMatchObject({ outcome: 'conflict', onDisk: false, end: 30 });
  });

  it('is empty and anchored at now with no events', () => {
    const t = projectWorktreeTimeline([], { now: 77 });
    expect(t).toMatchObject({ start: 77, end: 77, lanes: [], baseCommits: [] });
  });
});

describe('timeline helpers', () => {
  it('picks round ticks within the budget', () => {
    const start = 60_000 * 10 + 7_000;
    const ticks = worktreeTimelineTicks(start, start + 4 * 60_000, 5);
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.length).toBeLessThanOrEqual(5);
    for (const t of ticks) expect(t % 60_000).toBe(0);
    expect(worktreeTimelineTicks(5, 5)).toEqual([5]);
  });

  it('formats durations compactly', () => {
    expect(formatWorktreeDuration(850)).toBe('850ms');
    expect(formatWorktreeDuration(42_000)).toBe('42s');
    expect(formatWorktreeDuration(185_000)).toBe('3m 05s');
    expect(formatWorktreeDuration(3_720_000)).toBe('1h 02m');
  });

  it('strips the managed branch prefix', () => {
    expect(shortWorktreeBranch('wstack/ap/build-abc123')).toBe('build-abc123');
    expect(shortWorktreeBranch('feature/x')).toBe('feature/x');
  });
});
