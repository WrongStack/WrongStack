import type { KanbanBoard, KanbanTask } from '@wrongstack/kanban';
import { describe, expect, it } from 'vitest';
import {
  blockingTaskTitles,
  TASK_INSPECTOR_TABS,
  taskTabBadges,
} from '../../src/components/KanbanTaskInspectorChrome.js';

function task(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: 'task-1',
    title: 'Backfill rows',
    columnId: 'todo',
    order: 0,
    priority: 'medium',
    status: 'pending',
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
    ...overrides,
  } as KanbanTask;
}

function board(tasks: KanbanTask[]): KanbanBoard {
  return {
    id: 'board-1',
    title: 'Board',
    columns: [{ id: 'todo', title: 'Todo', order: 0, wipLimit: 0 }],
    tasks,
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
  } as KanbanBoard;
}

describe('KanbanTaskInspector chrome', () => {
  it('orders tabs along the card lifecycle', () => {
    // The order is the information: reading left to right walks the same path
    // the card walks, so a reshuffle would silently change what the strip says.
    expect(TASK_INSPECTOR_TABS.map((tab) => tab.key)).toEqual([
      'definition',
      'execution',
      'evidence',
      'breakdown',
      'history',
    ]);
  });

  it('names only the unfinished dependencies as blockers', () => {
    const done = task({ id: 'dep-done', title: 'Migrate schema', status: 'completed' });
    const open = task({ id: 'dep-open', title: 'Take backup', status: 'pending' });
    const subject = task({ dependsOn: ['dep-done', 'dep-open'] });

    expect(blockingTaskTitles(board([done, open, subject]), subject)).toEqual(['Take backup']);
  });

  it('reports a dangling dependency instead of dropping it', () => {
    const subject = task({ dependsOn: ['ghost-id-000000'] });
    // A missing dependency is a blocker too — silently ignoring it would show
    // the card as ready when nothing can prove that.
    expect(blockingTaskTitles(board([subject]), subject)).toEqual(['ghost-id (missing)']);
  });

  it('reports no blockers without dependencies or without a board', () => {
    const subject = task();
    expect(blockingTaskTitles(board([subject]), subject)).toEqual([]);
    expect(blockingTaskTitles(null, task({ dependsOn: ['x'] }))).toEqual([]);
  });

  it('badges only tabs that actually hold something', () => {
    const subject = task({
      successCriteria: [{ id: 'c1', text: 'tests pass' }],
      childTaskIds: ['child-1', 'child-2'],
    } as Partial<KanbanTask>);

    const badges = taskTabBadges(board([subject]), subject, 4);
    expect(badges.evidence).toBe(1);
    expect(badges.breakdown).toBe(2);
    expect(badges.history).toBe(4);
    // A single attempt is the normal case and carries no signal.
    expect(badges.execution).toBeUndefined();
    expect(badges.definition).toBeUndefined();
  });

  it('badges execution once a card has been retried', () => {
    const subject = task({ assignment: { status: 'running', attempt: 3 } } as Partial<KanbanTask>);
    expect(taskTabBadges(board([subject]), subject, 0).execution).toBe(3);
  });
});
