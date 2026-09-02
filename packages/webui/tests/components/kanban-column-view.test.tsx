import { fireEvent, render, screen } from '@testing-library/react';
import type { KanbanBoard, KanbanColumn, KanbanTask } from '@wrongstack/kanban';
import { describe, expect, it, vi } from 'vitest';
import { KanbanColumnView } from '../../src/components/KanbanColumnView.js';

/**
 * Card-level interactions: HTML5 drag-and-drop (setData on dragstart is what
 * makes dragging work in Firefox at all), the drag-over highlight, the
 * keyboard-accessible move select, and the two-step delete confirmation.
 */

const readyColumn: KanbanColumn = { id: 'ready', title: 'Ready', order: 0 };
const doingColumn: KanbanColumn = { id: 'doing', title: 'Doing', order: 1 };

function task(overrides: Record<string, unknown> = {}): KanbanTask {
  return {
    id: 'task-1',
    title: 'Fix lease',
    status: 'ready',
    columnId: 'ready',
    order: 0,
    priority: 'high',
    createdAt: '2026-07-20T12:00:00.000Z',
    updatedAt: '2026-07-21T12:00:00.000Z',
    ...overrides,
  } as KanbanTask;
}

function board(overrides: Record<string, unknown> = {}): KanbanBoard {
  return {
    id: 'board-1',
    title: 'Board',
    columns: [readyColumn, doingColumn],
    tasks: [task()],
    createdAt: '2026-07-20T12:00:00.000Z',
    updatedAt: '2026-07-21T12:00:00.000Z',
    version: 1,
    ...overrides,
  } as KanbanBoard;
}

/** jsdom has no DragEvent dataTransfer; hand the handler a stub. */
function eventWithDataTransfer(type: string, dataTransfer: unknown) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer, configurable: true });
  return event;
}

function renderColumn(overrides: Record<string, unknown> = {}) {
  const props = {
    board: board(overrides),
    column: readyColumn,
    selectedTaskId: null,
    dragTaskId: null,
    setDragTaskId: vi.fn(),
    onSelectTask: vi.fn(),
    onDeleteTask: vi.fn(),
    onMoveTask: vi.fn(),
  };
  const utils = render(<KanbanColumnView {...props} />);
  return { ...utils, props };
}

describe('KanbanColumnView drag and drop', () => {
  it('calls setData on dragstart — the call Firefox requires to initiate a drag', () => {
    const { props } = renderColumn();
    const dataTransfer = { setData: vi.fn(), effectAllowed: 'none' };
    const card = screen.getByText('Fix lease').closest('li');
    expect(card).not.toBeNull();

    fireEvent(card!, eventWithDataTransfer('dragstart', dataTransfer));

    expect(dataTransfer.setData).toHaveBeenCalledWith('text/plain', 'task-1');
    expect(dataTransfer.effectAllowed).toBe('move');
    expect(props.setDragTaskId).toHaveBeenCalledWith('task-1');
  });

  it('moves the task whose id arrives in the drop event', () => {
    const { props } = renderColumn();
    const columnList = screen.getByText('Fix lease').closest('ul');
    expect(columnList).not.toBeNull();

    const dataTransfer = { getData: vi.fn(() => 'task-1') };
    fireEvent(columnList!, eventWithDataTransfer('drop', dataTransfer));

    expect(props.onMoveTask).toHaveBeenCalledWith('task-1', 'ready');
    expect(props.setDragTaskId).toHaveBeenCalledWith(null);
  });

  it('highlights the column while a drag hovers it', () => {
    const { container } = renderColumn();
    const columnList = screen.getByText('Fix lease').closest('ul');
    expect(columnList).not.toBeNull();

    fireEvent.dragEnter(columnList!, {});
    expect(container.querySelector('section')?.className).toContain('border-primary/70');

    fireEvent.dragLeave(columnList!, {});
    expect(container.querySelector('section')?.className).not.toContain('border-primary/70');
  });

  it('does nothing on drop for a managed board', () => {
    const { props } = renderColumn({
      lifecycle: { mode: 'managed', stages: ['backlog', 'todo', 'running', 'review', 'done'] },
    });
    const columnList = screen.getByText('Fix lease').closest('ul');
    expect(columnList).not.toBeNull();

    fireEvent(columnList!, eventWithDataTransfer('drop', { getData: () => 'task-1' }));

    expect(props.onMoveTask).not.toHaveBeenCalled();
  });

  it('ignores a drop whose dataTransfer id names no task on the board', () => {
    const { props } = renderColumn();
    const columnList = screen.getByText('Fix lease').closest('ul');
    expect(columnList).not.toBeNull();

    // dataTransfer is untrusted: a drag from another window can carry
    // arbitrary text. Only ids that name a task on this board may move.
    fireEvent(columnList!, eventWithDataTransfer('drop', { getData: () => 'no-such-task' }));

    expect(props.onMoveTask).not.toHaveBeenCalled();
    expect(props.setDragTaskId).toHaveBeenCalledWith(null);
  });
});

describe('KanbanColumnView keyboard move', () => {
  it('exposes a move select that relocates the card', () => {
    const { props } = renderColumn();
    const select = screen.getByLabelText('Move Fix lease to column');

    fireEvent.change(select, { target: { value: 'doing' } });

    expect(props.onMoveTask).toHaveBeenCalledWith('task-1', 'doing');
  });

  it('hides the move select on managed boards (transitions are lifecycle-gated)', () => {
    renderColumn({
      lifecycle: { mode: 'managed', stages: ['backlog', 'todo', 'running', 'review', 'done'] },
    });
    expect(screen.queryByLabelText('Move Fix lease to column')).toBeNull();
  });

  it("ignores a move back to the card's own column", () => {
    const { props } = renderColumn();
    const select = screen.getByLabelText('Move Fix lease to column');

    fireEvent.change(select, { target: { value: 'ready' } });

    expect(props.onMoveTask).not.toHaveBeenCalled();
  });
});

describe('KanbanColumnView intelligence cache', () => {
  it('rebuilds per minute so a clock-crossing finding (overdue) is not served stale', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.parse('2026-07-21T12:00:00.000Z'));
      const { rerender, props } = renderColumn({
        tasks: [
          task({
            id: 'task-1',
            title: 'Fix lease',
            status: 'ready',
            dueDate: '2026-07-21T12:01:00.000Z',
          }),
        ],
      });
      // Not overdue yet — no critical-risk chip.
      expect(screen.queryByText(/critical risk/)).toBeNull();

      // The clock crosses the due date with no board change: the next
      // render (the 5s poll) must not serve the cached "no risks" verdict.
      vi.setSystemTime(Date.parse('2026-07-21T12:02:30.000Z'));
      rerender(
        <KanbanColumnView
          board={props.board}
          column={props.column}
          selectedTaskId={null}
          dragTaskId={null}
          setDragTaskId={props.setDragTaskId}
          onSelectTask={props.onSelectTask}
          onDeleteTask={props.onDeleteTask}
          onMoveTask={props.onMoveTask}
        />,
      );

      expect(screen.getByText('1 critical risk')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('KanbanColumnView two-step delete', () => {
  it('deletes only after a second click confirms', () => {
    const { props } = renderColumn();
    const trash = screen.getByRole('button', { name: 'Delete task: Fix lease' });

    fireEvent.click(trash);
    expect(props.onDeleteTask).not.toHaveBeenCalled();

    const confirm = screen.getByRole('button', { name: 'Confirm delete: Fix lease' });
    fireEvent.click(confirm);
    expect(props.onDeleteTask).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-1' }));
  });

  it('disarms when focus leaves the armed button', () => {
    const { props } = renderColumn();
    const trash = screen.getByRole('button', { name: 'Delete task: Fix lease' });

    fireEvent.click(trash);
    fireEvent.blur(screen.getByRole('button', { name: 'Confirm delete: Fix lease' }));

    fireEvent.click(screen.getByRole('button', { name: 'Delete task: Fix lease' }));
    expect(props.onDeleteTask).not.toHaveBeenCalled();
  });
});
