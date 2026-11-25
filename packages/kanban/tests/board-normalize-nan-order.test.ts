import { describe, expect, it } from 'vitest';
import { normalizeBoard } from '../src/board-normalize.js';
import type { KanbanBoard } from '../src/types.js';

describe('normalizeBoard non-finite order guard (F1983)', () => {
  it('replaces NaN column order with its index so sorting remains deterministic', () => {
    const board = normalizeBoard({
      id: 'b2',
      title: 'Board',
      columns: [
        { id: 'c2', name: 'Two', order: 2 },
        { id: 'cNan', name: 'NaN', order: Number.NaN },
        { id: 'c0', name: 'Zero', order: 0 },
      ],
      tasks: [],
    } as unknown as KanbanBoard);
    expect(board.columns[0]?.id).toBe('c0');
  });
});
