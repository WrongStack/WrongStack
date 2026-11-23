import type { KanbanBoard, KanbanTask } from '@wrongstack/kanban';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetKanbanStore, useKanbanStore } from '../src/kanban/kanban-store';

const NOW = '2026-11-22T12:00:00.000Z';

function makeTask(id: string, title: string): KanbanTask {
  return {
    id,
    title,
    columnId: 'backlog',
    order: 0,
    priority: 'medium',
    status: 'pending',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeBoard(id: string, tasks: KanbanTask[]): KanbanBoard {
  return {
    id,
    title: `Board ${id}`,
    columns: [{ id: 'backlog', title: 'Backlog', order: 0 }],
    tasks,
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
  };
}

const store = () => useKanbanStore.getState();
const activeTaskIds = () => store().activeBoard?.tasks.map((task) => task.id);

function openBoard(id: string, tasks: KanbanTask[]): void {
  store().setActiveBoardId(id);
  store().handleResult('kanban.get', { success: true, data: makeBoard(id, tasks) });
}

// The request carries a requestId (KanbanView stamps it) and the server echoes it on the
// reply frame (`correlatedReply`); the reply data is the bare task.
function reply(requestId: string, task: KanbanTask) {
  return { success: true, data: task, requestId };
}

describe('kanban store bare-task replies stay on the board they were sent for (F1303)', () => {
  beforeEach(() => {
    resetKanbanStore();
  });

  it('drops a task reply for board A that lands after the user opened board B', () => {
    openBoard('A', [makeTask('a1', 'A one')]);
    store().sendKanban('kanban.task.add', { boardId: 'A', title: 'A two', requestId: 'r-a' });
    openBoard('B', [makeTask('b1', 'B one')]);
    store().handleResult('kanban.task.add', reply('r-a', makeTask('a2', 'A two')));

    expect(store().activeBoard?.id).toBe('B');
    expect(activeTaskIds()).toEqual(['b1']);
    expect(store().boards.find((board) => board.id === 'B')?.taskCount).toBe(1);
  });

  it('applies replies for the open board even when an earlier request never got a reply', () => {
    openBoard('A', [makeTask('a1', 'A one')]);
    // Lost reply (dropped socket): its id must not shift onto the next reply.
    store().sendKanban('kanban.task.update', { boardId: 'A', taskId: 'a1', requestId: 'lost' });
    openBoard('B', [makeTask('b1', 'B one')]);
    store().sendKanban('kanban.task.update', { boardId: 'B', taskId: 'b1', requestId: 'r-b' });
    store().handleResult(
      'kanban.task.update',
      reply('r-b', { ...makeTask('b1', 'B renamed'), updatedAt: '2026-11-22T12:00:01.000Z' }),
    );
    expect(store().activeBoard?.tasks.map((task) => task.title)).toEqual(['B renamed']);

    // A reply nobody here stamped keeps the previous behaviour.
    store().handleResult('kanban.task.get', { success: true, data: makeTask('b2', 'B two') });
    expect(activeTaskIds()).toEqual(['b1', 'b2']);
  });
});
