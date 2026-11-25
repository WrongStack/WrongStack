import { describe, expect, it } from 'vitest';
import { serializeKanbanOutput } from '../src/kanban-serializer.js';
import type { KanbanToolOutput } from '../src/kanban-tool-types.js';

describe('serializeKanbanOutput proto column title (F2004)', () => {
  it('preserves columns titled __proto__ in compact board summaries', () => {
    const bigTasks = Array.from({ length: 120 }, (_, i) => ({
      id: `t${i}`,
      columnId: i === 0 ? 'c-proto' : 'c-todo',
      title: `Task ${i} ${'x'.repeat(200)}`,
      status: 'pending',
      priority: 'medium',
      order: i,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }));
    const out = JSON.parse(
      serializeKanbanOutput(
        {
          ok: true,
          board: {
            id: 'b1',
            title: 'Board',
            columns: [
              { id: 'c-proto', title: '__proto__', order: 0 },
              { id: 'c-todo', title: 'Todo', order: 1 },
            ],
            tasks: bigTasks,
          },
        } as unknown as KanbanToolOutput,
        { action: 'add_note' },
      ),
    ) as { board: { columns: Record<string, number> } };
    expect(Object.hasOwn(out.board.columns, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(out.board.columns, '__proto__')?.value).toBe(1);
  });
});
