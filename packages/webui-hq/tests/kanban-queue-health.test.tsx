/** @vitest-environment jsdom */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HqKanbanBoardView, HqKanbanTaskView } from '../src/views/kanban-model.js';
import { HqKanbanQueueHealth } from '../src/views/kanban-queue-health.js';

/**
 * HQ recomputes queue health locally because it only ever receives a board
 * snapshot, never a live `KanbanQueueHealth`. That made it a fourth independent
 * implementation of "how many can I start" — and it had drifted: its running
 * bucket switched on `status === 'in_progress'` alone, so a card whose
 * assignment was running but whose status tracked its lifecycle stage was
 * counted as claimable instead of running. This file is its first coverage.
 */

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function task(overrides: Partial<HqKanbanTaskView> & { id: string }): HqKanbanTaskView {
  return {
    title: 'Task',
    columnId: 'todo',
    order: 0,
    priority: 'medium',
    status: 'pending',
    labels: [],
    dependsOn: [],
    ...overrides,
  };
}

function board(tasks: HqKanbanTaskView[]): HqKanbanBoardView {
  return {
    id: 'board-1',
    title: 'Board',
    tags: [],
    revision: 1,
    updatedAt: '2026-08-10T00:00:00.000Z',
    activePresence: 0,
    taskCount: tasks.length,
    completedTaskCount: tasks.filter((t) => t.status === 'completed').length,
    activeTaskCount: 0,
    blockedTaskCount: 0,
    columns: [{ id: 'todo', title: 'Todo', order: 0, tasks }],
  };
}

function renderHealth(view: HqKanbanBoardView): string {
  act(() => {
    root?.render(createElement(HqKanbanQueueHealth, { board: view }));
  });
  return container?.textContent ?? '';
}

describe('HqKanbanQueueHealth', () => {
  it('counts a running assignment as running, not as claimable', () => {
    const text = renderHealth(
      board([
        task({ id: 'a', status: 'pending' }),
        // A managed card keeps its status aligned with its lifecycle stage, so
        // the assignment is the only signal that it is being worked.
        task({ id: 'b', status: 'pending', assignmentStatus: 'running' }),
      ]),
    );

    expect(text).toMatch(/1\s*running/);
    expect(text).toMatch(/1\s*ready/);
  });

  it('does not offer a queued card as claimable', () => {
    const text = renderHealth(
      board([task({ id: 'a', status: 'pending', assignmentStatus: 'queued' })]),
    );

    expect(text).not.toMatch(/\d\s*ready/);
  });

  it('excludes cards with unmet dependencies from the claimable count', () => {
    const text = renderHealth(
      board([
        task({ id: 'blocker', status: 'pending' }),
        task({ id: 'blocked', status: 'pending', dependsOn: ['blocker'] }),
      ]),
    );

    expect(text).toMatch(/1\s*ready/);
  });

  it('counts a card whose dependency is completed', () => {
    const text = renderHealth(
      board([
        task({ id: 'blocker', status: 'completed' }),
        task({ id: 'blocked', status: 'pending', dependsOn: ['blocker'] }),
      ]),
    );

    expect(text).toMatch(/1\s*ready/);
  });

  it('reports healthy only on the absence of failure signals, not the absence of work', () => {
    const busy = renderHealth(board([task({ id: 'a', status: 'in_progress' })]));
    expect(busy).toMatch(/healthy/);

    const broken = renderHealth(board([task({ id: 'a', status: 'failed' })]));
    expect(broken).not.toMatch(/healthy/);
    expect(broken).toMatch(/1\s*failed/);
  });
});
