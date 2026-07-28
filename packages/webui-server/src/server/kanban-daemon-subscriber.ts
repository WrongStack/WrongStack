/**
 * Kanban daemon event subscriber — replaces `kanban-board-watcher.ts`.
 *
 * Instead of polling the filesystem with `fs.watch` on `.wrongstack/kanbans/`,
 * this subscribes to push events from the Kanban IPC daemon via
 * `bridgeKanbanSupervisor`. When a mutation event arrives (board created,
 * task added, column moved, etc.), the affected board is re-read through
 * `ServerKanbanStore` and broadcast to all WebSocket clients.
 *
 * Benefits over the file watcher:
 *   - No filesystem polling (lower latency, no inotify/FSEvents overhead)
 *   - No `fs.watch` platform quirks (Windows EPERM, macOS FSEvents latency)
 *   - Works through the daemon's file-lock serialization
 *   - Auto-reconnects when the daemon restarts
 */
import { bridgeKanbanSupervisor, getServerKanbanStore } from '@wrongstack/kanban';
import type { WSServerMessage } from './types.js';

export function subscribeKanbanDaemonEvents(
  projectRoot: string,
  broadcastMessage: (message: WSServerMessage) => void,
): () => void {
  const store = getServerKanbanStore(projectRoot);

  return bridgeKanbanSupervisor(projectRoot, async (event) => {
    // Extract boardId from the mutation event data.
    // The daemon sends { type: 'event', event: '<name>', data: { boardId, ... } }
    // for every board mutation (board.created, task.added, column.updated, etc.).
    const evData = event.data as { boardId?: string } | undefined;
    const boardId = evData?.boardId;
    if (!boardId) return;

    try {
      const board = await store.getBoard(boardId);
      if (board) {
        broadcastMessage({
          type: 'kanban.get',
          payload: { success: true, data: { board } },
        } as WSServerMessage);
      }
    } catch {
      // Best-effort: the next explicit refresh or next daemon event
      // will catch transient errors (e.g. board deleted mid-read).
    }
  }, {
    autoReconnect: true,
    reconnectDelayMs: 1_000,
  });
}
