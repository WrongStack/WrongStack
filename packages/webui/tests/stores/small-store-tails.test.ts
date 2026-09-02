import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCodemapIndexStore } from '../../src/stores/codemap-index-store';
import { useGoalRunStore } from '../../src/stores/goal-run-store';
import { useSddBoardStore } from '../../src/stores/sdd-board-store';
import { useWorktreeStore } from '../../src/stores/worktree-store';

/**
 * Closes the last uncovered actions on the small stores. Each of these is a
 * one-line setter that no existing suite reached; the tests below pin the
 * exact merge semantics (replace vs patch) so a refactor can't silently
 * change them.
 */

describe('worktree store — result setters', () => {
  beforeEach(() => {
    useWorktreeStore.setState({
      worktrees: [],
      baseBranch: '',
      activity: [],
      orphans: [],
      canClean: false,
      cleanResult: null,
      mergeResult: null,
      diffByDir: {},
    } as never);
  });

  it('setCleanResult stores the outcome', () => {
    useWorktreeStore.getState().setCleanResult({ ok: true, removed: 3, at: 1_000 });
    expect(useWorktreeStore.getState().cleanResult).toEqual({ ok: true, removed: 3, at: 1_000 });
  });

  it('setCleanResult(null) dismisses the banner', () => {
    useWorktreeStore.getState().setCleanResult({ ok: true, removed: 1, at: 1 });
    useWorktreeStore.getState().setCleanResult(null);
    expect(useWorktreeStore.getState().cleanResult).toBeNull();
  });

  it('setCleanResult replaces rather than merges', () => {
    useWorktreeStore.getState().setCleanResult({ ok: false, removed: 0, reason: 'locked', at: 1 });
    useWorktreeStore.getState().setCleanResult({ ok: true, removed: 2, at: 2 });
    expect(useWorktreeStore.getState().cleanResult).not.toHaveProperty('reason');
  });

  it('setMergeResult stores a successful merge', () => {
    useWorktreeStore.getState().setMergeResult({ ok: true, branch: 'feat/x', at: 5 });
    expect(useWorktreeStore.getState().mergeResult).toEqual({
      ok: true,
      branch: 'feat/x',
      at: 5,
    });
  });

  it('setMergeResult keeps conflict details', () => {
    useWorktreeStore.getState().setMergeResult({
      ok: false,
      branch: 'feat/x',
      conflict: true,
      conflictFiles: ['a.ts'],
      at: 5,
    });
    expect(useWorktreeStore.getState().mergeResult).toMatchObject({
      conflict: true,
      conflictFiles: ['a.ts'],
    });
  });

  it('setMergeResult(null) clears it', () => {
    useWorktreeStore.getState().setMergeResult({ ok: true, branch: 'b', at: 1 });
    useWorktreeStore.getState().setMergeResult(null);
    expect(useWorktreeStore.getState().mergeResult).toBeNull();
  });

  it('setDiff keys the summary by directory', () => {
    useWorktreeStore.getState().setDiff('/repo/wt1', { files: 2 } as never);
    expect(useWorktreeStore.getState().diffByDir['/repo/wt1']).toEqual({ files: 2 });
  });

  it('setDiff merges rather than replacing the whole map', () => {
    useWorktreeStore.getState().setDiff('/a', { files: 1 } as never);
    useWorktreeStore.getState().setDiff('/b', { files: 2 } as never);
    expect(Object.keys(useWorktreeStore.getState().diffByDir).sort()).toEqual(['/a', '/b']);
  });

  it('setDiff overwrites an earlier summary for the same dir', () => {
    useWorktreeStore.getState().setDiff('/a', { files: 1 } as never);
    useWorktreeStore.getState().setDiff('/a', { files: 9 } as never);
    expect(useWorktreeStore.getState().diffByDir['/a']).toEqual({ files: 9 });
  });

  it('setDiff stores an explicit null for a clean worktree', () => {
    useWorktreeStore.getState().setDiff('/a', null);
    expect(useWorktreeStore.getState().diffByDir).toHaveProperty('/a', null);
  });

  it('setDiff replaces the map object so shallow selectors re-run', () => {
    useWorktreeStore.getState().setDiff('/a', { files: 1 } as never);
    const before = useWorktreeStore.getState().diffByDir;
    useWorktreeStore.getState().setDiff('/b', { files: 1 } as never);
    expect(useWorktreeStore.getState().diffByDir).not.toBe(before);
  });
});

describe('codemap index store', () => {
  beforeEach(() => {
    useCodemapIndexStore.setState({ generation: 0, lastUpdatedAt: null });
  });

  it('starts at generation 0 with no timestamp', () => {
    expect(useCodemapIndexStore.getState()).toMatchObject({
      generation: 0,
      lastUpdatedAt: null,
    });
  });

  it('bumps the generation so CodeMap invalidates its cache', () => {
    useCodemapIndexStore.getState().notifyIndexUpdated(1_000);
    expect(useCodemapIndexStore.getState()).toMatchObject({
      generation: 1,
      lastUpdatedAt: 1_000,
    });
  });

  it('increments monotonically across runs', () => {
    useCodemapIndexStore.getState().notifyIndexUpdated(1);
    useCodemapIndexStore.getState().notifyIndexUpdated(2);
    useCodemapIndexStore.getState().notifyIndexUpdated(3);
    expect(useCodemapIndexStore.getState().generation).toBe(3);
    expect(useCodemapIndexStore.getState().lastUpdatedAt).toBe(3);
  });

  it('defaults the timestamp to now', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T00:00:00Z'));
    useCodemapIndexStore.getState().notifyIndexUpdated();
    expect(useCodemapIndexStore.getState().lastUpdatedAt).toBe(Date.parse('2026-07-29T00:00:00Z'));
    vi.useRealTimers();
  });
});

describe('sdd board store', () => {
  beforeEach(() => {
    useSddBoardStore.setState({
      snapshot: null,
      boards: [],
      lifecycleResult: null,
      destroying: false,
    } as never);
  });

  it('starts empty and idle', () => {
    expect(useSddBoardStore.getState()).toMatchObject({
      snapshot: null,
      boards: [],
      lifecycleResult: null,
      destroying: false,
    });
  });

  it('stores a snapshot and clears it again', () => {
    useSddBoardStore.getState().setSnapshot({ specId: 's1' } as never);
    expect(useSddBoardStore.getState().snapshot).toEqual({ specId: 's1' });
    useSddBoardStore.getState().setSnapshot(null);
    expect(useSddBoardStore.getState().snapshot).toBeNull();
  });

  it('replaces the board list', () => {
    useSddBoardStore.getState().setBoards([{ id: 'b1' }] as never);
    useSddBoardStore.getState().setBoards([{ id: 'b2' }, { id: 'b3' }] as never);
    expect(useSddBoardStore.getState().boards).toHaveLength(2);
  });

  it('records a lifecycle result', () => {
    useSddBoardStore.getState().setLifecycleResult({ ok: true, action: 'destroy' } as never);
    expect(useSddBoardStore.getState().lifecycleResult).toMatchObject({ action: 'destroy' });
  });

  it('toggles the destroying flag in both directions', () => {
    useSddBoardStore.getState().setDestroying(true);
    expect(useSddBoardStore.getState().destroying).toBe(true);
    useSddBoardStore.getState().setDestroying(false);
    expect(useSddBoardStore.getState().destroying).toBe(false);
  });

  it('keeps the flags independent', () => {
    useSddBoardStore.getState().setSnapshot({ specId: 's1' } as never);
    useSddBoardStore.getState().setDestroying(true);
    expect(useSddBoardStore.getState().snapshot).not.toBeNull();
    expect(useSddBoardStore.getState().destroying).toBe(true);
  });
});

describe('goal run store — hydrateFromServer', () => {
  it('requests both the graph list and the live state', () => {
    const send = vi.fn();
    useGoalRunStore.getState().hydrateFromServer(send);
    expect(send).toHaveBeenNthCalledWith(1, { type: 'goal.list' });
    expect(send).toHaveBeenNthCalledWith(2, { type: 'goal.state' });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('asks for the list before the state so the board can resolve names', () => {
    const order: string[] = [];
    useGoalRunStore.getState().hydrateFromServer((m) => {
      order.push((m as { type: string }).type);
    });
    expect(order).toEqual(['goal.list', 'goal.state']);
  });
});
