import { describe, expect, it } from 'vitest';
import { nextTaskOrder } from '../src/manager/task-column-helpers.js';
import type { KanbanBoard } from '../src/types.js';

describe('nextTaskOrder non-finite task order guard (F1982)', () => {
  it('ignores NaN orders on existing tasks when computing the next order', () => {
    const board = {
      columns: [{ id: 'todo', name: 'Todo', order: 0 }],
      tasks: [
        { id: 't1', columnId: 'todo', order: 3 },
        { id: 't2', columnId: 'todo', order: Number.NaN },
      ],
    } as unknown as KanbanBoard;
    expect(nextTaskOrder(board, 'todo')).toBe(4);
  });
});
