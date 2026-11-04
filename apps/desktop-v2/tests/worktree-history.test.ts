// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { emptyEngineState, reduceEngine } from '../src/engine-state';
import { WorktreeHistory } from '../src/WorktreeHistory';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const T = Date.parse('2026-11-04T09:00:00.000Z');
const merged = [
  {
    kind: 'allocated',
    at: T,
    handleId: 'h1',
    branch: 'wstack/ap/goal-1',
    baseBranch: 'main',
    ownerLabel: 'goal phase 1',
  },
  {
    kind: 'committed',
    at: T + 60_000,
    handleId: 'h1',
    committed: true,
    insertions: 12,
    deletions: 3,
    files: 2,
    sha: 'abcdef1234',
  },
  { kind: 'merging', at: T + 90_000, handleId: 'h1' },
  { kind: 'merged', at: T + 120_000, handleId: 'h1', branch: 'wstack/ap/goal-1', squash: true },
  { kind: 'released', at: T + 125_000, handleId: 'h1' },
];
const failed = {
  kind: 'failed',
  at: T + 200_000,
  handleId: 'h2',
  branch: 'wstack/ap/task-2',
  ownerLabel: 'sdd task',
  stage: 'commit',
  error: 'pre-commit hook failed\nstack',
};

describe('worktree history', () => {
  it('keeps the engine log and adds each lifecycle step', () => {
    const opened = reduceEngine(emptyEngineState, {
      type: 'worktree.timeline',
      payload: { events: [...merged, { kind: 'bogus', handleId: 'x' }] },
    });
    expect(opened.worktreeEvents.map((event) => event.kind)).toEqual([
      'allocated',
      'committed',
      'merging',
      'merged',
      'released',
    ]);
    const next = reduceEngine(opened, {
      type: 'worktree.timeline_event',
      payload: { event: failed },
    });
    expect(next.worktreeEvents).toHaveLength(6);
    const restarted = reduceEngine(next, { type: 'worktree.timeline', payload: { events: [] } });
    expect(restarted.worktreeEvents).toEqual([]);
  });

  it('draws a lane per worktree and shows a lane’s lifecycle when chosen', () => {
    const state = reduceEngine(emptyEngineState, {
      type: 'worktree.timeline',
      payload: { events: [...merged, failed] },
    });
    const host = document.createElement('div');
    act(() =>
      createRoot(host).render(createElement(WorktreeHistory, { events: state.worktreeEvents })),
    );
    const lanes = host.querySelectorAll<HTMLButtonElement>('.worktree-history-lane');
    expect([...lanes].map((lane) => lane.getAttribute('aria-label'))).toEqual([
      'goal-1 — merged',
      'task-2 — failed',
    ]);
    expect(host.querySelector('.worktree-history-counts')?.textContent).toContain('1 merged');
    expect(host.querySelectorAll('.worktree-history-commit')).toHaveLength(1);
    act(() => lanes[1]?.click());
    const detail = host.querySelector('.worktree-history-detail');
    expect(detail?.textContent).toContain(
      'Commit refused (pre-commit hook or locked index): pre-commit hook failed',
    );
    expect(detail?.textContent).toContain('failed · pre-commit hook failed');
    act(() => lanes[0]?.click());
    const lifecycle = host.querySelector('.worktree-history-detail')?.textContent ?? '';
    expect(lifecycle).toContain('committed · +12 −3 · 2 files · abcdef1');
    expect(lifecycle).toContain('merged into main');
    expect(lifecycle).toContain('removed');
  });

  it('says when there is nothing yet', () => {
    const host = document.createElement('div');
    act(() => createRoot(host).render(createElement(WorktreeHistory, { events: [] })));
    expect(host.textContent).toContain('No worktree activity yet.');
  });
});
