import { describe, expect, it } from 'vitest';
import { clampOrder, normalizeColumnTaskOrders } from '../src/manager/task-column-helpers.js';

describe('task-column-helpers non-finite order guards', () => {
  it('places NaN-order tasks deterministically at the end and clamps non-finite max', () => {
    const board = {
      columns: [{ id: 'todo', name: 'Todo' }],
      tasks: [
        { id: 't1', columnId: 'todo', order: Number.NaN, createdAt: '2026-01-02T00:00:00Z' },
        { id: 't2', columnId: 'todo', order: 1, createdAt: '2026-01-01T00:00:00Z' },
        { id: 't3', columnId: 'todo', order: 2, createdAt: '2026-01-03T00:00:00Z' },
      ],
    };
    normalizeColumnTaskOrders(board as never, 'todo');
    expect(board.tasks.find((t) => t.id === 't2')?.order).toBe(0);
    expect(board.tasks.find((t) => t.id === 't3')?.order).toBe(1);
    expect(board.tasks.find((t) => t.id === 't1')?.order).toBe(2);
    expect(clampOrder(5, Number.NaN)).toBe(0);
  });
});
