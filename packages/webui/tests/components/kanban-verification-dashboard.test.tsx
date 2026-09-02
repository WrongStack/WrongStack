import { render } from '@testing-library/react';
import type { KanbanBoard, KanbanTask } from '@wrongstack/kanban';
import { describe, expect, it, vi } from 'vitest';
import { KanbanVerificationDashboard } from '../../src/components/KanbanVerificationDashboard.js';

/**
 * The 5s board poll hands the store a fresh board object with an unchanged
 * per-write revision. The dashboard summary is a pure function of board.tasks,
 * so the memo must key on (id, revision) — object identity would re-derive
 * the whole summary on every poll render.
 */
const { selectSpy } = vi.hoisted(() => ({ selectSpy: vi.fn() }));
vi.mock('@/lib/kanban-verification', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/kanban-verification')>();
  return {
    ...actual,
    selectVerificationSummary: vi.fn((board: KanbanBoard) => {
      selectSpy(board);
      return actual.selectVerificationSummary(board);
    }),
  };
});

function boardWith(revision: number): KanbanBoard {
  const task = {
    id: 't1',
    title: 'Ship it',
    status: 'completed',
    priority: 'medium',
    order: 0,
    columnId: 'c1',
    createdAt: '2026-07-20T12:00:00.000Z',
    updatedAt: '2026-07-21T12:00:00.000Z',
    verificationReport: {
      taskId: 't1',
      taskTitle: 'Ship it',
      boardId: 'b1',
      startedAt: '2026-07-20T12:00:00.000Z',
      completedAt: '2026-07-21T12:00:00.000Z',
      verdict: 'passed',
      checks: [],
      markdownSummary: '',
      attachments: [],
    },
  } as KanbanTask;
  return {
    id: 'b1',
    title: 'Board',
    revision,
    version: 1,
    columns: [{ id: 'c1', title: 'Done', order: 0 }],
    tasks: [task],
    createdAt: '2026-07-20T12:00:00.000Z',
    updatedAt: '2026-07-21T12:00:00.000Z',
  } as KanbanBoard;
}

describe('KanbanVerificationDashboard summary memo', () => {
  it('re-derives only when the board revision changes, not on poll identity churn', () => {
    const { rerender } = render(
      <KanbanVerificationDashboard board={boardWith(1)} onSelectTask={vi.fn()} />,
    );
    const afterFirstRender = selectSpy.mock.calls.length;
    expect(afterFirstRender).toBeGreaterThanOrEqual(1);

    // Poll churn: fresh object identity, same contents, same revision.
    rerender(<KanbanVerificationDashboard board={boardWith(1)} onSelectTask={vi.fn()} />);
    expect(selectSpy.mock.calls.length).toBe(afterFirstRender);

    // A real change lands with a revision bump.
    rerender(<KanbanVerificationDashboard board={boardWith(2)} onSelectTask={vi.fn()} />);
    expect(selectSpy.mock.calls.length).toBe(afterFirstRender + 1);
  });
});
