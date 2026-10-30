import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { emptyEngineState } from '../src/engine-state';
import { planItems, SessionWorklist, taskItems } from '../src/SessionWorklist';

it('reads plan items and tasks as the engine stores them', () => {
  expect(
    planItems({
      plan: {
        title: 'Release',
        items: [{ id: 'p1', title: 'Tag', status: 'done', details: 'after CI' }, { title: 'x' }],
      },
    }),
  ).toEqual({
    title: 'Release',
    items: [{ id: 'p1', title: 'Tag', status: 'done', detail: 'after CI' }],
  });
  expect(planItems({ plan: null })).toEqual({ title: '', items: [] });
  expect(
    taskItems({
      tasks: [{ id: 't1', title: 'Fix', status: 'blocked', priority: 'high', type: 'bug' }],
    }),
  ).toEqual([{ id: 't1', title: 'Fix', status: 'blocked', detail: 'high · bug' }]);
});

it('renders nothing without a plan or tasks, and progress when present', () => {
  const view = (results: Record<string, Record<string, unknown>>) =>
    renderToStaticMarkup(
      createElement(SessionWorklist, {
        state: { ...emptyEngineState, results },
        command: async () => ({}),
      }),
    );
  expect(view({})).toBe('');
  const markup = view({
    'plan.updated': { plan: { items: [{ id: 'p1', title: 'Tag', status: 'done' }] } },
    'tasks.updated': { tasks: [{ id: 't1', title: 'Fix', status: 'pending' }] },
  });
  expect(markup).toContain('Plan · 1 of 1 done');
  expect(markup).toContain('Tasks · 0 of 1 done');
  expect(markup).toContain('Status of Fix');
});
