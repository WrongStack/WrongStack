// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { emptyEngineState } from '../src/engine-state';
import { ProjectWorktrees } from '../src/ProjectWorktrees';
import { worktreeViews } from '../src/worktree-model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const snapshot = {
  baseBranch: 'main',
  worktrees: [
    {
      handleId: 'h2',
      ownerLabel: 'SDD task T2',
      branch: 'wstack/ap/t2',
      status: 'needs-review',
      insertions: 4,
      deletions: 2,
      files: 1,
      allocatedAt: 200,
      recentActivity: [],
    },
    {
      handleId: 'h1',
      ownerLabel: 'Goal run',
      branch: 'wstack/ap/goal',
      status: 'merged',
      insertions: 30,
      deletions: 5,
      files: 3,
      allocatedAt: 100,
      recentActivity: [
        { kind: 'commit', text: 'first pass', at: 1 },
        { kind: 'merge', text: 'merged into main', at: 2 },
      ],
    },
  ],
};

function mount() {
  const host = document.createElement('div');
  const state = { ...emptyEngineState, results: { 'worktree.state': snapshot } };
  act(() =>
    createRoot(host).render(
      createElement(ProjectWorktrees, { state, send: vi.fn(async () => undefined) }),
    ),
  );
  const layout = (name: string) =>
    act(() =>
      [...host.querySelectorAll('[aria-label="Worktree layout"] button')]
        .find((button) => button.textContent === name)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
  return { host, layout };
}

describe('worktree lanes and graph', () => {
  it('reads when each worktree was handed out and its newest note', () => {
    const [first, second] = worktreeViews(snapshot).worktrees;
    expect(first).toMatchObject({ allocatedAt: 200, latest: '' });
    expect(second).toMatchObject({ allocatedAt: 100, latest: 'merge: merged into main' });
  });

  it('keeps the list with its actions by default and switches to lanes in handout order', () => {
    const { host, layout } = mount();
    expect(host.querySelector('.worktree-list')).not.toBeNull();
    layout('Lanes');
    const lanes = [...host.querySelectorAll('.worktree-lane')];
    expect(lanes.map((lane) => lane.querySelector('code')?.textContent)).toEqual(['goal', 't2']);
    expect(lanes[0]?.textContent).toContain('Merged');
    expect(lanes[0]?.textContent).toContain('merge: merged into main');
    expect(lanes[1]?.textContent).toContain('conflict');
    expect(host.querySelector('.worktree-list')).toBeNull();
  });

  it('draws the trunk with a fork per worktree and a fold-back once merged', () => {
    const { host, layout } = mount();
    layout('Graph');
    const graph = host.querySelector('svg[role="img"]') as SVGElement;
    expect(graph.getAttribute('aria-label')).toBe('Worktrees branching from main');
    expect(graph.querySelectorAll('g')).toHaveLength(2);
    expect(graph.querySelectorAll('path')).toHaveLength(3);
    expect(graph.textContent).toContain('merged into main');
    expect(graph.textContent).toContain('⚠ Conflict');
  });
});
