/**
 * Kanban daemon event subscriber — replaces `kanban-board-watcher.ts`.
 *
 * Instead of polling the old board-file directory with `fs.watch`,
 * this subscribes to push events from the Kanban IPC daemon via
 * `bridgeKanbanSupervisor`. When a mutation event arrives (board created,
 * task added, column moved, etc.), the affected board is re-read through
 * `ServerKanbanStore` and broadcast to all WebSocket clients.
 *
 * Benefits over the file watcher:
 *   - No filesystem polling (lower latency, no inotify/FSEvents overhead)
 *   - No `fs.watch` platform quirks (Windows EPERM, macOS FSEvents latency)
 *   - Works through the daemon's SQLite revision serialization
 *   - Auto-reconnects when the daemon restarts
 */
import { bridgeKanbanSupervisor, getServerKanbanStore } from '@wrongstack/kanban';
import { kanbanBoardMessage, kanbanDeletedMessage } from './kanban-broadcast.js';
import type { WSServerMessage } from './types.js';

export function subscribeKanbanDaemonEvents(
  projectRoot: string,
  broadcastMessage: (message: WSServerMessage) => void,
): () => void {
  const store = getServerKanbanStore(projectRoot);
  const knownRevisions = new Map<string, string>();
  let connectionCount = 0;

  const broadcastDeleted = (boardId: string): void => {
    knownRevisions.delete(boardId);
    broadcastMessage(kanbanDeletedMessage(boardId));
  };

  const broadcastBoard = async (boardId: string): Promise<void> => {
    const board = await store.getBoard(boardId);
    if (!board) {
      broadcastDeleted(boardId);
      return;
    }
    knownRevisions.set(boardId, board.updatedAt);
    broadcastMessage(kanbanBoardMessage(board));
  };

  const reconcileAfterConnect = async (): Promise<void> => {
    const summaries = await store.listBoards();
    connectionCount++;
    if (connectionCount === 1) {
      for (const summary of summaries) knownRevisions.set(summary.id, summary.updatedAt);
      return;
    }
    const present = new Set(summaries.map((summary) => summary.id));
    for (const boardId of [...knownRevisions.keys()]) {
      if (!present.has(boardId)) broadcastDeleted(boardId);
    }
    for (const summary of summaries) {
      if (knownRevisions.get(summary.id) !== summary.updatedAt) {
        await broadcastBoard(summary.id);
      }
    }
  };

  return bridgeKanbanSupervisor(
    projectRoot,
    async (event) => {
      // Extract boardId from the mutation event data.
      // The daemon sends { type: 'event', event: '<name>', data: { boardId, ... } }
      // for every board mutation (board.created, task.added, column.updated, etc.).
      const evData = event.data as { boardId?: string } | undefined;
      const boardId = evData?.boardId;
      if (!boardId) return;

      try {
        if (event.event === 'board.deleted') {
          broadcastDeleted(boardId);
          return;
        }
        await broadcastBoard(boardId);
      } catch {
        // Best-effort: the next explicit refresh or next daemon event
        // will catch transient errors (e.g. board deleted mid-read).
      }
    },
    {
      autoReconnect: true,
      reconnectDelayMs: 1_000,
      onConnected: reconcileAfterConnect,
    },
  );
}
