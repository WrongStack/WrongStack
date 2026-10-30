import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { emptyEngineState } from '../src/engine-state';
import { ProjectWorktrees } from '../src/ProjectWorktrees';
import {
  cleanupOutcome,
  diffSummary,
  mergeOutcome,
  worktreeOrphans,
  worktreeViews,
} from '../src/worktree-model';

it('reads live worktrees and leftovers as the engine reports them', () => {
  expect(
    worktreeViews({
      baseBranch: 'main',
      worktrees: [
        {
          handleId: 'h1',
          ownerId: 'goal-1',
          ownerLabel: 'Goal run',
          dir: '/p/.wrongstack/worktrees/h1',
          branch: 'wstack/ap/h1',
          baseBranch: 'main',
          status: 'active',
          insertions: 3,
          deletions: 1,
          files: 2,
          conflictFiles: ['a.ts'],
        },
      ],
    }).worktrees[0],
  ).toMatchObject({ ownerLabel: 'Goal run', status: 'active', conflictFiles: ['a.ts'] });
  expect(
    worktreeOrphans({
      orphans: [{ kind: 'branch', branch: 'wstack/ap/old' }],
      canClean: false,
      reason: 'a run is live in this session',
    }),
  ).toEqual({
    orphans: [{ kind: 'branch', dir: '', branch: 'wstack/ap/old' }],
    canClean: false,
    reason: 'a run is live in this session',
  });
});

it('reports results without claiming success the engine did not report', () => {
  expect(cleanupOutcome({ ok: true, removed: 2 })).toBe('Removed 2 items.');
  expect(
    cleanupOutcome({
      ok: false,
      removed: 0,
      reason: 'a run is live in this session — stop it first',
    }),
  ).toBe('Nothing was removed: a run is live in this session — stop it first.');
  expect(mergeOutcome({ ok: true, branch: 'wstack/ap/x' })).toBe('Merged wstack/ap/x.');
  expect(
    mergeOutcome({ ok: false, branch: 'wstack/ap/x', conflict: true, conflictFiles: ['a.ts'] }),
  ).toBe('wstack/ap/x was not merged: conflicts in a.ts.');
  expect(diffSummary({ dir: '/d', summary: null })).toEqual({ dir: '/d', summary: null });
  expect(
    diffSummary({
      dir: '/d',
      summary: {
        files: [{ path: 'a.ts', insertions: 1, deletions: 0 }],
        insertions: 1,
        deletions: 0,
        commits: 2,
      },
    }).summary?.commits,
  ).toBe(2);
});

it('shows the scan state before the engine answers', () => {
  const markup = renderToStaticMarkup(
    createElement(ProjectWorktrees, { state: emptyEngineState, send: async () => {} }),
  );
  expect(markup).toContain('No run in this engine is using a worktree.');
  expect(markup).toContain('Scanning managed worktrees');
});
