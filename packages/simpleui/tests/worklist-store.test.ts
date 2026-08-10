import { describe, expect, it, vi } from 'vitest';
import {
  createWorklistStore,
  parseSimplePlan,
  parseSimpleTasks,
  parseSimpleTodos,
} from '../src/lib/worklist-store.js';

describe('SimpleUI worklist store', () => {
  it('parses valid work items and drops malformed server entries', () => {
    expect(
      parseSimpleTodos([
        {
          id: 'todo-1',
          content: 'Ship it',
          status: 'pending',
          kanbanBoardId: 'board-1',
          kanbanTaskId: 'task-1',
        },
        { id: 'bad', content: { unsafe: true }, status: 'pending' },
      ]),
    ).toEqual([
      {
        id: 'todo-1',
        content: 'Ship it',
        status: 'pending',
        kanbanBoardId: 'board-1',
        kanbanTaskId: 'task-1',
      },
    ]);

    expect(
      parseSimpleTasks([
        { id: 'task-1', title: 'Test it', status: 'review', type: 'test', priority: 'high' },
        { id: 'task-2', title: 'Legacy shape', status: 'pending' },
      ]),
    ).toEqual([
      { id: 'task-1', title: 'Test it', status: 'review', type: 'test', priority: 'high' },
      { id: 'task-2', title: 'Legacy shape', status: 'pending', type: 'chore', priority: 'medium' },
    ]);

    expect(
      parseSimplePlan({ items: [{ id: 'plan-1', title: 'First step', status: 'in_progress' }] }),
    ).toEqual([{ id: 'plan-1', title: 'First step', status: 'in_progress' }]);
  });

  it('publishes matching worklist updates without accepting stale-session frames', () => {
    const store = createWorklistStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.reset('session-a');

    expect(
      store.applyMessage({
        type: 'todos.updated',
        payload: {
          sessionId: 'session-a',
          todos: [{ id: 'todo-1', content: 'Current', status: 'in_progress' }],
        },
      }),
    ).toBe(true);
    expect(store.getSnapshot().todos[0]?.content).toBe('Current');

    expect(
      store.applyMessage({
        type: 'todos.updated',
        payload: {
          sessionId: 'session-b',
          todos: [{ id: 'todo-2', content: 'Stale', status: 'pending' }],
        },
      }),
    ).toBe(false);
    expect(store.getSnapshot().todos).toHaveLength(1);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('stores the project-scoped bounded Kanban workbench independently of session lists', () => {
    const store = createWorklistStore();
    const workbench = {
      generatedAt: '2026-08-09T12:00:00.000Z',
      boardCount: 2,
      totals: { active: 3, now: 1, next: 1, blocked: 1, review: 0, failed: 0, completed: 4 },
      flow: [],
      lanes: {
        now: { total: 1, omitted: 0, items: [] },
        next: { total: 1, omitted: 0, items: [] },
        blocked: { total: 1, omitted: 0, items: [] },
        review: { total: 0, omitted: 0, items: [] },
      },
      alerts: [],
      alertTotal: 0,
      alertsOmitted: 0,
    };

    expect(
      store.applyMessage({
        type: 'kanban.workbench' as never,
        payload: { success: true, data: workbench },
      }),
    ).toBe(true);
    expect(store.getSnapshot().workbench).toEqual(workbench);
  });
});
