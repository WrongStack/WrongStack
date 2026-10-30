import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { emptyEngineState } from '../src/engine-state';
import { GoalRevert, goalRevertBaseline, goalRevertOutcome } from '../src/GoalRevert';

it('offers a revert only for a baseline the engine reports', () => {
  expect(goalRevertBaseline({ revert: null })).toBeNull();
  expect(goalRevertBaseline({ revert: { branch: 'main', sha: 'not-a-sha' } })).toBeNull();
  expect(goalRevertBaseline({ revert: { branch: 'main', sha: 'abc1234def' } })).toEqual({
    branch: 'main',
    sha: 'abc1234def',
  });
  const view = (goal: unknown) =>
    renderToStaticMarkup(
      createElement(GoalRevert, {
        goalId: 'g1',
        goal,
        state: emptyEngineState,
        send: async () => {},
        readOnly: false,
      }),
    );
  expect(view({ revert: null })).toBe('');
  expect(view({ revert: { branch: 'main', sha: 'abc1234def' } })).toContain('Revert run');
});

it('reports what the engine reverted, or why it refused', () => {
  expect(goalRevertOutcome({ ok: true, reverted: 3 })).toBe(
    'Reverted 3 commits with new revert commits; the run was cleared.',
  );
  expect(goalRevertOutcome({ ok: true, reverted: 0, reason: 'nothing to revert' })).toBe(
    'The run made no commits to revert; the run was cleared.',
  );
  expect(
    goalRevertOutcome({
      ok: false,
      reverted: 0,
      reason: 'no git baseline was captured for this run',
    }),
  ).toBe('Nothing was reverted: no git baseline was captured for this run.');
});
