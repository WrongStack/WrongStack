import type { HqKanbanSnapshotPayload } from '@wrongstack/core/hq';
import { describe, expect, it } from 'vitest';
import { projectKanbanBoards, projectKanbanUrl } from '../src/domain/kanban-model.js';

function snapshot(): HqKanbanSnapshotPayload {
  return {
    projectId: 'proj_01KY5W8B8YQVCTFZ1CAEVT5HM2',
    generatedAt: '2026-07-23T10:00:00.000Z',
    boards: [
      {
        boardId: 'board-1',
        revision: 3,
        updatedAt: '2026-07-23T09:00:00.000Z',
        board: {
          id: 'board-1',
          title: 'Shared Delivery',
          description: 'Release coordination',
          tags: ['goal:release'],
          columns: [
            { id: 'todo', title: 'Todo', order: 0, wipLimit: 2 },
            { id: 'doing', title: 'Doing', order: 1, color: '#fd9f02' },
            { id: 'done', title: 'Done', order: 2 },
          ],
          tasks: [
            {
              id: 't2',
              title: 'Ship UI',
              columnId: 'doing',
              order: 1,
              priority: 'high',
              status: 'in_progress',
              assignee: 'agent-a',
              labels: ['frontend'],
              dependsOn: ['t1'],
              dueDate: '2026-07-24T12:00:00.000Z',
            },
            {
              id: 't1',
              title: 'Identity',
              columnId: 'done',
              order: 0,
              priority: 'medium',
              status: 'completed',
            },
            {
              id: 't3',
              title: 'Odd card',
              columnId: 'missing',
              order: 0,
              priority: 'unexpected',
              status: 'blocked',
            },
            { id: 'invalid', columnId: 'todo' },
          ],
          presence: [{ active: true }, { active: false }],
        },
      },
      {
        boardId: 'mismatch',
        revision: 1,
        updatedAt: '2026-07-23T08:00:00.000Z',
        board: { id: 'different' },
      },
    ],
    tombstones: [],
  };
}

describe('HQ Kanban view model', () => {
  it('builds an encoded project endpoint', () => {
    expect(projectKanbanUrl('proj/a b')).toBe('/api/projects/proj%2Fa%20b/kanban');
  });

  it('projects opaque snapshots into sorted, safe board data', () => {
    const boards = projectKanbanBoards(snapshot());

    expect(boards).toHaveLength(1);
    expect(boards[0]).toMatchObject({
      id: 'board-1',
      title: 'Shared Delivery',
      revision: 3,
      activePresence: 1,
      taskCount: 3,
      completedTaskCount: 1,
      activeTaskCount: 1,
      blockedTaskCount: 1,
    });
    expect(boards[0]?.columns.map((column) => column.id)).toEqual([
      'todo',
      'doing',
      'done',
      'missing',
    ]);
    expect(boards[0]?.columns[1]?.tasks[0]).toMatchObject({
      title: 'Ship UI',
      assignee: 'agent-a',
      priority: 'high',
    });
    expect(boards[0]?.columns[3]?.tasks[0]?.priority).toBe('medium');
  });
});
