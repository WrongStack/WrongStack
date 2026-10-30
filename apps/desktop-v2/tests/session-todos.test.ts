import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { emptyEngineState } from '../src/engine-state';
import { SessionTodos, sessionTodos, todoProgress } from '../src/SessionTodos';

const payload = {
  sessionId: 's1',
  todos: [
    { id: 'a', content: 'Write the test', status: 'completed' },
    { id: 'b', content: 'Fix the parser', status: 'in_progress', activeForm: 'Fixing the parser' },
    { id: 'c', content: 'Board task', status: 'pending', kanbanBoardId: 'k', kanbanTaskId: 't' },
    { content: 'no id' },
  ],
};

it('reads the todo list and marks Kanban projections as managed', () => {
  const todos = sessionTodos(payload);
  expect(todos.map((todo) => [todo.id, todo.status, todo.managed])).toEqual([
    ['a', 'completed', false],
    ['b', 'in_progress', false],
    ['c', 'pending', true],
  ]);
  expect(todoProgress(todos)).toBe('1 of 3 done · Fixing the parser');
});

it('renders nothing without todos and offers no actions on a Kanban task', () => {
  const view = (todos: unknown) =>
    renderToStaticMarkup(
      createElement(SessionTodos, {
        state: {
          ...emptyEngineState,
          results: { 'todos.updated': todos as Record<string, unknown> },
        },
        command: async () => ({}),
      }),
    );
  expect(view({ todos: [] })).toBe('');
  const markup = view(payload);
  expect(markup).toContain('Kanban task');
  expect(markup).not.toContain('Status of Board task');
  expect(markup).toContain('Status of Fix the parser');
  // A list that contains Kanban-bound items cannot be cleared by hand.
  expect(markup).not.toContain('Clear list');
});
