import { beforeEach, describe, expect, it, vi } from 'vitest';

const getBoard = vi.fn();
const listBoards = vi.fn();
let daemonHandler:
  | ((event: { event: string; data?: { boardId?: string } }) => void | Promise<void>)
  | undefined;
let daemonOptions: { onConnected?: () => void | Promise<void> } | undefined;

vi.mock('@wrongstack/kanban', () => ({
  bridgeKanbanSupervisor: vi.fn(
    (
      _projectRoot: string,
      handler: (event: { event: string; data?: { boardId?: string } }) => void | Promise<void>,
      options: { onConnected?: () => void | Promise<void> },
    ) => {
      daemonHandler = handler;
      daemonOptions = options;
      return vi.fn();
    },
  ),
  getServerKanbanStore: vi.fn(() => ({ getBoard, listBoards })),
}));

import { subscribeKanbanDaemonEvents } from '../src/server/kanban-daemon-subscriber.js';

describe('subscribeKanbanDaemonEvents', () => {
  beforeEach(() => {
    daemonHandler = undefined;
    daemonOptions = undefined;
    getBoard.mockReset();
    listBoards.mockReset();
    listBoards.mockResolvedValue([]);
  });

  it('broadcasts daemon board updates after re-reading through IPC (coalesced)', async () => {
    vi.useFakeTimers();
    try {
      const board = { id: 'board-1', title: 'IPC board' };
      getBoard.mockResolvedValue(board);
      const broadcast = vi.fn();

      subscribeKanbanDaemonEvents('C:\\project', broadcast);
      // A burst of mutation events for the same board — one fetch+broadcast
      // after the coalesce window, not one per event (every broadcast is a
      // full board fetch fanned to every WS client).
      await daemonHandler?.({ event: 'board.updated', data: { boardId: 'board-1' } });
      await daemonHandler?.({ event: 'task.added', data: { boardId: 'board-1' } });
      await daemonHandler?.({ event: 'column.updated', data: { boardId: 'board-1' } });
      await daemonHandler?.({ event: 'contract.node.updated', data: { boardId: 'board-1' } });
      expect(getBoard).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(350);
      expect(getBoard).toHaveBeenCalledTimes(1);
      expect(getBoard).toHaveBeenCalledWith('board-1');
      expect(broadcast).toHaveBeenCalledWith({
        type: 'kanban.get',
        payload: { success: true, data: { board } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores workflow.* events instead of broadcasting phantom deletes', async () => {
    vi.useFakeTimers();
    try {
      // The daemon emits workflow.* events with a workflowId in the boardId
      // slot; probing it as a board made getBoard return null, which the
      // broadcast path treats as "deleted" — a phantom kanban.delete to
      // every client on EVERY SDD/AutoPhase checkpoint.
      getBoard.mockResolvedValue(null);
      const broadcast = vi.fn();

      subscribeKanbanDaemonEvents('C:\\project', broadcast);
      await daemonHandler?.({ event: 'workflow.checkpoint', data: { boardId: 'wf-123' } });
      await vi.advanceTimersByTimeAsync(500);

      expect(getBoard).not.toHaveBeenCalled();
      expect(broadcast).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('broadcasts daemon deletions without attempting a stale board read', async () => {
    const broadcast = vi.fn();

    subscribeKanbanDaemonEvents('C:\\project', broadcast);
    await daemonHandler?.({ event: 'board.deleted', data: { boardId: 'board-1' } });

    expect(getBoard).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith({
      type: 'kanban.delete',
      payload: { success: true, data: { removed: true, boardId: 'board-1' } },
    });
  });

  it('reconciles changed and deleted boards after reconnect', async () => {
    const board = { id: 'board-1', title: 'IPC board', updatedAt: '2026-07-29T00:01:00.000Z' };
    listBoards
      .mockResolvedValueOnce([
        { id: 'board-1', updatedAt: '2026-07-29T00:00:00.000Z' },
        { id: 'board-2', updatedAt: '2026-07-29T00:00:00.000Z' },
      ])
      .mockResolvedValueOnce([
        { id: 'board-1', updatedAt: '2026-07-29T00:01:00.000Z' },
        { id: 'board-3', updatedAt: '2026-07-29T00:01:00.000Z' },
      ]);
    getBoard.mockImplementation(async (boardId: string) => ({
      ...board,
      id: boardId,
    }));
    const broadcast = vi.fn();

    subscribeKanbanDaemonEvents('C:\\project', broadcast);
    await daemonOptions?.onConnected?.();
    expect(broadcast).not.toHaveBeenCalled();

    await daemonOptions?.onConnected?.();

    expect(getBoard).toHaveBeenCalledWith('board-1');
    expect(getBoard).toHaveBeenCalledWith('board-3');
    expect(broadcast).toHaveBeenCalledWith({
      type: 'kanban.delete',
      payload: { success: true, data: { removed: true, boardId: 'board-2' } },
    });
  });

  it('drops stale in-flight getBoard reads after board.deleted or subscriber disposal', async () => {
    let resolveDeletedBoard!: (value: unknown) => void;
    let resolveStoppedBoard!: (value: unknown) => void;
    const deletedBoardRead = new Promise((r) => {
      resolveDeletedBoard = r;
    });
    const stoppedBoardRead = new Promise((r) => {
      resolveStoppedBoard = r;
    });

    listBoards
      .mockResolvedValueOnce([
        { id: 'board-deleted', updatedAt: '2026-07-29T00:00:00.000Z' },
        { id: 'board-stopped', updatedAt: '2026-07-29T00:00:00.000Z' },
      ])
      .mockResolvedValueOnce([
        { id: 'board-deleted', updatedAt: '2026-07-29T00:01:00.000Z' },
        { id: 'board-stopped', updatedAt: '2026-07-29T00:01:00.000Z' },
      ]);
    getBoard.mockImplementation((boardId: string) =>
      boardId === 'board-deleted' ? deletedBoardRead : stoppedBoardRead,
    );

    const broadcast = vi.fn();
    const stop = subscribeKanbanDaemonEvents('C:\\project', broadcast);
    await daemonOptions?.onConnected?.();

    const reconcilePromise = Promise.resolve(daemonOptions?.onConnected?.());
    await Promise.resolve();

    await daemonHandler?.({ event: 'board.deleted', data: { boardId: 'board-deleted' } });
    resolveDeletedBoard({
      id: 'board-deleted',
      title: 'Stale Deleted Board',
      updatedAt: '2026-07-29T00:01:00.000Z',
    });
    await Promise.resolve();
    await Promise.resolve();

    stop();
    resolveStoppedBoard({
      id: 'board-stopped',
      title: 'Post-stop Board',
      updatedAt: '2026-07-29T00:01:00.000Z',
    });
    await reconcilePromise;

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith({
      type: 'kanban.delete',
      payload: { success: true, data: { removed: true, boardId: 'board-deleted' } },
    });
  });

  it('F69: drops out-of-order older getBoard reads and avoids phantom delete for boards created during reconnect listBoards()', async () => {
    listBoards.mockResolvedValueOnce([{ id: 'board-1', updatedAt: '2026-07-29T00:00:00.000Z' }]);

    let resolveReconnectList!: (value: Array<{ id: string; updatedAt: string }>) => void;
    listBoards.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolveReconnectList = r;
        }),
    );

    let resolveSlowReadV1!: (value: unknown) => void;
    let board1Reads = 0;
    getBoard.mockImplementation((boardId: string) => {
      if (boardId === 'board-new') {
        return Promise.resolve({
          id: 'board-new',
          title: 'Brand New Board',
          updatedAt: '2026-07-29T00:05:00.000Z',
        });
      }
      board1Reads += 1;
      if (board1Reads === 1) {
        return new Promise((r) => {
          resolveSlowReadV1 = r;
        });
      }
      return Promise.resolve({
        id: 'board-1',
        title: 'Fresh v2',
        updatedAt: '2026-07-29T00:02:00.000Z',
      });
    });

    const broadcast = vi.fn();
    const stop = subscribeKanbanDaemonEvents('C:\\project', broadcast);
    await daemonOptions?.onConnected?.();

    const reconnectPromise = Promise.resolve(daemonOptions?.onConnected?.());
    await Promise.resolve();

    vi.useFakeTimers();
    try {
      await daemonHandler?.({ event: 'board.created', data: { boardId: 'board-new' } });
      await daemonHandler?.({ event: 'task.added', data: { boardId: 'board-1' } });
      await vi.advanceTimersByTimeAsync(350);
    } finally {
      vi.useRealTimers();
    }

    resolveReconnectList([{ id: 'board-1', updatedAt: '2026-07-29T00:01:00.000Z' }]);
    await reconnectPromise;

    resolveSlowReadV1({
      id: 'board-1',
      title: 'Stale v1',
      updatedAt: '2026-07-29T00:01:00.000Z',
    });
    await Promise.resolve();
    await Promise.resolve();
    stop();

    const deleteCalls = broadcast.mock.calls.filter(([msg]) => msg.type === 'kanban.delete');
    expect(deleteCalls).toEqual([]);

    const board1Titles = broadcast.mock.calls
      .filter(([msg]) => msg.type === 'kanban.get' && msg.payload.data.board.id === 'board-1')
      .map(([msg]) => msg.payload.data.board.title);
    expect(board1Titles).toEqual(['Fresh v2']);
  });
});
