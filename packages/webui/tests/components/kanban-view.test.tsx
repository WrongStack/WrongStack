import { act, fireEvent, render, screen } from '@testing-library/react';
import type { KanbanBoard, KanbanBoardSummary, KanbanColumn, KanbanTask } from '@wrongstack/kanban';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

import { i18n } from '../../src/i18n';

describe('KanbanView board deletion guard', () => {
  // Pin the language before rendering: the component renders t()-derived
  // labels, and an unpinned translator can race initialization into raw keys.
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });
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

describe('KanbanView board creation', () => {
  it('creates a plain board, like every other creation path', () => {
    // This used to send a hard-coded managed lifecycle, so "make me a board"
    // produced a strict-gated board from the browser and an ungated one from
    // `/kanban create`, the `create_board` tool and the session/run mirrors.
    // Managed mode is an audited opt-in via `adopt_managed_lifecycle`.
    render(<KanbanView />);

    fireEvent.change(screen.getByPlaceholderText('New board'), {
      target: { value: 'Fresh board' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create board' }));

    const create = sendMock.mock.calls
      .map(([message]) => message as { type: string; payload?: Record<string, unknown> })
      .find((message) => message.type === 'kanban.create');
    expect(create).toBeDefined();
    expect(create?.payload?.title).toBe('Fresh board');
    expect(create?.payload).not.toHaveProperty('lifecycle');
  });

  it('ignores a blank title instead of creating an untitled board', () => {
    render(<KanbanView />);
    fireEvent.change(screen.getByPlaceholderText('New board'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create board' }));
    expect(sendMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'kanban.create' }));
  });
});

describe('KanbanView polling', () => {
  it('does not poll the board — push (kanban.get broadcast) is the update path', () => {
    vi.useFakeTimers();
    try {
      seedActive(board('board-a', 'Board A'));
      render(<KanbanView />);
      sendMock.mockClear();

      act(() => {
        vi.advanceTimersByTime(20_000);
      });

      const polled = sendMock.mock.calls
        .map(([message]) => (message as { type: string }).type)
        .filter((type) => type === 'kanban.get' || type === 'kanban.health');
      expect(polled).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes queue health when the pushed board actually changed', () => {
    // Health does not ride the board broadcast, so it follows `updatedAt` —
    // which moves on every committed mutation and stays put for a no-op.
    const boardA = board('board-a', 'Board A');
    seedActive(boardA);
    render(<KanbanView />);
    sendMock.mockClear();

    act(() => {
      useKanbanStore.setState({ activeBoard: { ...boardA } });
    });
    expect(sendMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'kanban.health' }));

    act(() => {
      useKanbanStore.setState({
        activeBoard: { ...boardA, updatedAt: '2026-07-20T13:00:00.000Z' },
      });
    });
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'kanban.health', payload: { boardId: 'board-a' } }),
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

  it('clears per-board ephemera and verification spinners when active board is deleted or replaced via kanban.create (F75)', () => {
    const boardA = board('board-a', 'Board A');
    seedActive(boardA);
    render(<KanbanView />);
    act(() => {
      useKanbanStore.setState({
        queueHealth: {
          generatedAt: NOW,
          boardIds: [boardA.id],
          counts: {
            ready: 1,
            startable: 1,
            queued: 0,
            running: 0,
            review: 0,
            failed: 0,
            completed: 0,
            pending: 0,
            archived: 0,
            blocked: 0,
          },
          dependencyBlocked: { count: 0, tasks: [] },
          staleAssignments: { count: 0, tasks: [] },
          failedRetryable: { count: 0, tasks: [] },
          heartbeatDue: { count: 0, tasks: [] },
        },
        supervisorSnapshot: {
          boardId: boardA.id,
          status: 'healthy',
          mode: 'deterministic',
          reconciledTaskIds: [],
          staleRecoveredTaskIds: [],
          anomalyCount: 0,
        },
        verificationActivity: { 'board-a:t1': { startedAt: Date.now() } },
        boardHistory: [
          {
            id: 'hist-1',
            boardId: boardA.id,
            boardTitle: boardA.title,
            type: 'board.created',
            ts: NOW,
          },
        ],
      });
    });
    expect(useKanbanStore.getState().queueHealth?.counts.startable).toBe(1);
    expect(useKanbanStore.getState().verificationActivity).toHaveProperty('board-a:t1');
    expect(useKanbanStore.getState().boardHistory).toHaveLength(1);

    act(() => {
      useKanbanStore.getState().handleResult('kanban.task.remove', {
        success: true,
        data: { removed: true, boardId: 'board-a', taskId: 't1' },
      });
    });
    expect(useKanbanStore.getState().verificationActivity).toEqual({});

    act(() => {
      useKanbanStore.setState({
        verificationActivity: { 'board-a:t-2': { startedAt: Date.now() } },
      });
      useKanbanStore.getState().handleResult('kanban.delete', {
        success: true,
        data: { removed: true, boardId: 'board-a' },
      });
    });
    const afterDelete = useKanbanStore.getState();
    expect(afterDelete.activeBoardId).toBeNull();
    expect(afterDelete.queueHealth).toBeNull();
    expect(afterDelete.supervisorSnapshot).toBeNull();
    expect(afterDelete.verificationActivity).toEqual({});
    expect(afterDelete.boardHistory).toEqual([]);
  });
});
