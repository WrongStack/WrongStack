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

  it('broadcasts daemon board updates after re-reading through IPC', async () => {
    const board = { id: 'board-1', title: 'IPC board' };
    getBoard.mockResolvedValue(board);
    const broadcast = vi.fn();

    subscribeKanbanDaemonEvents('C:\\project', broadcast);
    await daemonHandler?.({ event: 'board.updated', data: { boardId: 'board-1' } });

    expect(getBoard).toHaveBeenCalledWith('board-1');
    expect(broadcast).toHaveBeenCalledWith({
      type: 'kanban.get',
      payload: { success: true, data: { board } },
    });
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
});
