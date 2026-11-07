import type { KanbanBoardSummary } from '@wrongstack/kanban';
import { describe, expect, it } from 'vitest';
import { paginateKanbanBoards } from '../src/server/kanban-routes.js';

function board(
  id: string,
  updatedAt: string,
  options: Partial<KanbanBoardSummary> = {},
): KanbanBoardSummary {
  return {
    id,
    title: id,
    createdAt: updatedAt,
    updatedAt,
    columnCount: 1,
    taskCount: 0,
    completedTaskCount: 0,
    ...options,
  };
}

describe('paginateKanbanBoards', () => {
  it('puts live session boards before newer orphaned boards', () => {
    const result = paginateKanbanBoards(
      [
        board('orphan', '2026-07-18T12:00:00.000Z'),
        board('tag-active', '2026-07-18T10:00:00.000Z', { tags: ['session:s1'] }),
        board('presence-active', '2026-07-18T11:00:00.000Z', {
          presence: [
            {
              id: 'p1',
              sessionId: 's2',
              agentId: 'leader',
              firstSeenAt: '2026-07-18T11:00:00.000Z',
              lastSeenAt: '2026-07-18T11:00:00.000Z',
              activeUntil: '2026-07-18T12:00:00.000Z',
              active: true,
            },
          ],
        }),
      ],
      { page: 1, pageSize: 2, activeSessionIds: ['s1'] },
    );

    expect(result.items.map((item) => item.id)).toEqual(['presence-active', 'tag-active']);
    expect(result.activeTotal).toBe(2);
    expect(result.orphanedTotal).toBe(1);
    expect(result.totalPages).toBe(2);
  });

  it('clamps invalid page bounds and page size', () => {
    const boards = Array.from({ length: 3 }, (_, index) =>
      board(`b${index}`, `2026-07-18T0${index}:00:00.000Z`),
    );
    const result = paginateKanbanBoards(boards, { page: 99, pageSize: 1 });
    expect(result.page).toBe(3);
    expect(result.items).toHaveLength(1);
  });
});
