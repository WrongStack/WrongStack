import type { KanbanBoard } from '@wrongstack/kanban';
import { describe, expect, it } from 'vitest';
import { auditKanbanBoard } from '../src/kanban/kanban-cleaner.js';

describe('auditKanbanBoard non-finite defaultReviewStaleAfterMs (F1880)', () => {
  it('falls back to default 72h threshold when defaultReviewStaleAfterMs is invalid', () => {
    const now = Date.parse('2026-11-25T12:00:00.000Z');
    const board = {
      id: 'b1',
      title: 'Board',
      tasks: [
        {
          id: 't1',
          title: 'Fresh review',
          status: 'review',
          description: 'desc',
          assignee: 'alice',
          labels: ['bug'],
          successCriteria: [{ description: 'works' }],
          updatedAt: '2026-11-25T11:59:59.000Z',
        },
      ],
    } as unknown as KanbanBoard;

    for (const bad of [Number.NaN, 0, -1000, Number.POSITIVE_INFINITY]) {
      const res = auditKanbanBoard(board, { now, defaultReviewStaleAfterMs: bad });
      expect(res.issues.some((i) => i.code === 'stale-review')).toBe(false);
    }

    const stale = auditKanbanBoard(board, { now, defaultReviewStaleAfterMs: 500 });
    expect(stale.issues.some((i) => i.code === 'stale-review')).toBe(true);
  });
});
