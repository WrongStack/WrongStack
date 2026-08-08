import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KanbanBoard, KanbanBoardSummary, KanbanColumn, KanbanTask } from '@wrongstack/kanban';
import { KanbanView } from '../../src/components/KanbanView';
import { useKanbanStore } from '../../src/stores';

/**
 * Two-step delete + auto-select-suppression + error-dismiss behavior of the
 * Kanban page, exercised end-to-end through the real component tree (only the
 * WebSocket transport is stubbed).
 */

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock('@/lib/ws-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ws-client')>();
  // Subscriber hooks (useProviderModels / useKanbanMeta) call client.on on
  // mount even when no task is selected — the stub needs the full client
  // surface, not just send.
  const client = {
    send: sendMock,
    on: vi.fn(() => () => {}),
    off: vi.fn(),
  };
  return { ...actual, getWSClient: () => client };
});

const NOW = '2026-07-20T12:00:00.000Z';

function summary(id: string, title: string): KanbanBoardSummary {
  return {
    id,
    title,
    createdAt: NOW,
    updatedAt: NOW,
    columnCount: 1,
    taskCount: 1,
    completedTaskCount: 0,
  };
}

function board(id: string, title: string): KanbanBoard {
  const column: KanbanColumn = { id: 'col-1', title: 'Backlog', order: 0 };
  const task: KanbanTask = {
    id: 't1',
    title: 'Task one',
    status: 'ready',
    columnId: column.id,
    order: 0,
    priority: 'medium',
    createdAt: NOW,
    updatedAt: NOW,
  };
  return {
    id,
    title,
    columns: [column],
    tasks: [task],
    createdAt: NOW,
    updatedAt: NOW,
  } as KanbanBoard;
}

function seedStore(state: Partial<ReturnType<typeof useKanbanStore.getState>> = {}) {
  useKanbanStore.setState({
    boards: [],
    boardTotal: 0,
    activeBoardTotal: 0,
    orphanedBoardTotal: 0,
    activeBoardId: null,
    activeBoard: null,
    loading: false,
    error: null,
    queueHealth: null,
    supervisorSnapshot: null,
    ...state,
  });
}

function seedActive(board: KanbanBoard) {
  seedStore({
    boards: [summary(board.id, board.title)],
    boardTotal: 1,
    activeBoardTotal: 1,
    orphanedBoardTotal: 0,
    activeBoardId: board.id,
    activeBoard: board,
  });
}

beforeEach(() => {
  sendMock.mockClear();
  seedStore();
});

afterEach(() => {
  act(() => {
    seedStore();
  });
});

describe('KanbanView board deletion guard', () => {
  it('deletes the board only after the second click confirms', () => {
    const boardA = board('board-a', 'Board A');
    seedActive(boardA);
    render(<KanbanView />);

    const trash = screen.getByRole('button', { name: 'Delete board' });
    fireEvent.click(trash);

    // Armed, but nothing sent yet.
    expect(screen.getByRole('button', { name: 'Confirm?' })).toBeTruthy();
    expect(sendMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'kanban.delete' }));

    fireEvent.click(screen.getByRole('button', { name: 'Confirm?' }));
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'kanban.delete', payload: { boardId: 'board-a' } }),
    );
  });

  it('disarms when the active board changes, so a stale confirm cannot delete', () => {
    const boardA = board('board-a', 'Board A');
    const boardB = board('board-b', 'Board B');
    seedStore({
      boards: [summary(boardA.id, boardA.title), summary(boardB.id, boardB.title)],
      boardTotal: 2,
      activeBoardTotal: 2,
      orphanedBoardTotal: 0,
      activeBoardId: boardA.id,
      activeBoard: boardA,
    });
    render(<KanbanView />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete board' }));
    expect(screen.getByRole('button', { name: 'Confirm?' })).toBeTruthy();

    // Switch to board B; the kanban.get response updates activeBoard.
    fireEvent.click(screen.getByRole('button', { name: /Board B/ }));
    act(() => {
      useKanbanStore.setState({ activeBoard: boardB });
    });

    // The confirm was disarmed by the board switch — back to a plain trash.
    expect(screen.getByRole('button', { name: 'Delete board' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete board' }));
    expect(sendMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'kanban.delete' }));

    // A fresh two-step now targets the CURRENT board, never the old one.
    fireEvent.click(screen.getByRole('button', { name: 'Confirm?' }));
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'kanban.delete', payload: { boardId: 'board-b' } }),
    );
    expect(sendMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'kanban.delete', payload: { boardId: 'board-a' } }),
    );
  });

  it('auto-disarms after four seconds so a later stray click cannot delete', () => {
    vi.useFakeTimers();
    try {
      seedActive(board('board-a', 'Board A'));
      render(<KanbanView />);

      fireEvent.click(screen.getByRole('button', { name: 'Delete board' }));
      expect(screen.getByRole('button', { name: 'Confirm?' })).toBeTruthy();

      act(() => {
        vi.advanceTimersByTime(4001);
      });
      expect(screen.getByRole('button', { name: 'Delete board' })).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Delete board' }));
      expect(sendMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'kanban.delete' }));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('KanbanView board auto-select', () => {
  it('does not auto-select a board after a sidebar page change', () => {
    const boardA = board('board-a', 'Board A');
    const boardB = board('board-b', 'Board B');
    // 13 boards so the pagination exposes a next page (pageSize is 12).
    seedStore({
      boards: [summary(boardA.id, boardA.title)],
      boardTotal: 13,
      activeBoardTotal: 13,
      orphanedBoardTotal: 0,
      activeBoardId: boardA.id,
      activeBoard: boardA,
    });
    render(<KanbanView />);
    sendMock.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));

    // The page change clears the selection and suppresses the boards[0]
    // fallback until the user explicitly picks a board.
    act(() => {
      useKanbanStore.setState({
        boards: [summary(boardB.id, boardB.title)],
        activeBoardId: null,
        activeBoard: null,
      });
    });
    expect(sendMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'kanban.get', payload: { boardId: boardB.id } }),
    );

    // An explicit selection re-enables auto-select and fetches the board.
    fireEvent.click(screen.getByRole('button', { name: /Board B/ }));
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'kanban.get', payload: { boardId: boardB.id } }),
    );
  });
});

describe('KanbanView error banner', () => {
  it('dismisses the error banner and clears the store error', () => {
    seedActive(board('board-a', 'Board A'));
    useKanbanStore.setState({ error: 'Kanban request failed' });
    render(<KanbanView />);

    expect(screen.getByText('Kanban request failed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(useKanbanStore.getState().error).toBeNull();
    expect(screen.queryByText('Kanban request failed')).toBeNull();
  });
});
