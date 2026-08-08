import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { KanbanTaskTree } from '../../src/components/KanbanTaskTree.js';
import type { KanbanBoard, KanbanTask } from '@wrongstack/kanban';

/**
 * The 5s board poll hands the store a fresh board object with an unchanged
 * per-write revision. The tree is a pure function of board.tasks, so its memo
 * must key on (id, revision) — object identity would rebuild the whole tree
 * (and re-run the cycle-breaking walk) on every poll render.
 */
const { buildSpy } = vi.hoisted(() => ({ buildSpy: vi.fn() }));
vi.mock('@/lib/kanban-verification', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/kanban-verification')>();
  return {
    ...actual,
    buildTaskTree: vi.fn((board: KanbanBoard) => {
      buildSpy(board);
      return actual.buildTaskTree(board);
    }),
  };
});

function boardWith(revision: number): KanbanBoard {
  const task = {
    id: 't1',
    title: 'Parent',
    status: 'todo',
    order: 0,
    columnId: 'c1',
  } as KanbanTask;
  return {
    id: 'b1',
    title: 'Board',
    revision,
    version: 1,
    columns: [{ id: 'c1', title: 'Todo', order: 0 }],
    tasks: [task],
    createdAt: '2026-07-20T12:00:00.000Z',
    updatedAt: '2026-07-21T12:00:00.000Z',
  } as KanbanBoard;
}

describe('KanbanTaskTree build memo', () => {
  it('re-derives only when the board revision changes, not on poll identity churn', () => {
    const { rerender } = render(
      <KanbanTaskTree board={boardWith(1)} selectedTaskId={null} onSelectTask={vi.fn()} />,
    );
    const afterFirstRender = buildSpy.mock.calls.length;
    expect(afterFirstRender).toBeGreaterThanOrEqual(1);

    // Poll churn: fresh object identity, same contents, same revision.
    rerender(<KanbanTaskTree board={boardWith(1)} selectedTaskId={null} onSelectTask={vi.fn()} />);
    expect(buildSpy.mock.calls.length).toBe(afterFirstRender);

    // A real change lands with a revision bump.
    rerender(<KanbanTaskTree board={boardWith(2)} selectedTaskId={null} onSelectTask={vi.fn()} />);
    expect(buildSpy.mock.calls.length).toBe(afterFirstRender + 1);
  });
});
