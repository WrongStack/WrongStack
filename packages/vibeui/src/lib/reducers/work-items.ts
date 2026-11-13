import { record, rows, text } from '../session-coercion';
import type { FrameReducerTable } from './types';

const item = (row: Record<string, unknown>, title: unknown) => ({
  id: text(row.id),
  title: text(title),
  status: text(row.status),
});

/** Leader todos, project tasks and plan items. */
export const workItemReducers: FrameReducerTable = {
  'todos.updated': (state, p) => ({
    ...state,
    todos: rows(p.todos).map((t) => item(t, t.content)),
  }),
  'todos.cleared': (state) => ({ ...state, todos: [] }),
  'tasks.updated': (state, p) => ({
    ...state,
    tasks: rows(p.tasks).map((t) => item(t, t.title)),
  }),
  // `plan` arrives either as the item array or as `{ items }`.
  'plan.updated': (state, p) => ({
    ...state,
    plan: rows(Array.isArray(p.plan) ? p.plan : record(p.plan).items).map((t) => item(t, t.title)),
  }),
};
