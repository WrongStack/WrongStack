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
  const boardGenerations = new Map<string, number>();
  let connectionCount = 0;
  let disposed = false;

  const bumpGeneration = (boardId: string): number => {
    const next = (boardGenerations.get(boardId) ?? 0) + 1;
    boardGenerations.set(boardId, next);
    return next;
  };

  const broadcastDeleted = (boardId: string): void => {
    if (disposed) return;
    bumpGeneration(boardId);
    knownRevisions.delete(boardId);
    broadcastMessage(kanbanDeletedMessage(boardId));
  };

  const broadcastBoard = async (boardId: string): Promise<void> => {
    if (disposed) return;
    const generation = bumpGeneration(boardId);
    const board = await store.getBoard(boardId);
    if (disposed || (boardGenerations.get(boardId) ?? 0) !== generation) return;
    if (!board) {
      broadcastDeleted(boardId);
      return;
    }
    knownRevisions.set(boardId, board.updatedAt);
    broadcastMessage(kanbanBoardMessage(board));
  };

  const reconcileAfterConnect = async (): Promise<void> => {
    if (disposed) return;
    const knownBeforeList = new Map(knownRevisions);
    const generationsBeforeList = new Map(boardGenerations);
    const summaries = await store.listBoards();
    if (disposed) return;
    connectionCount++;
    if (connectionCount === 1) {
      for (const summary of summaries) {
        if (
          (boardGenerations.get(summary.id) ?? 0) ===
            (generationsBeforeList.get(summary.id) ?? 0) &&
          !knownRevisions.has(summary.id)
        ) {
          knownRevisions.set(summary.id, summary.updatedAt);
        }
      }
      return;
    }
    const present = new Set(summaries.map((summary) => summary.id));
    for (const boardId of [...knownRevisions.keys()]) {
      if (
        !present.has(boardId) &&
        knownBeforeList.has(boardId) &&
        (boardGenerations.get(boardId) ?? 0) === (generationsBeforeList.get(boardId) ?? 0)
      ) {
        broadcastDeleted(boardId);
      }
    }
    for (const summary of summaries) {
      if (disposed) return;
      const changedDuringList =
        knownRevisions.get(summary.id) !== knownBeforeList.get(summary.id) ||
        (!knownRevisions.has(summary.id) &&
          (boardGenerations.get(summary.id) ?? 0) !== (generationsBeforeList.get(summary.id) ?? 0));
      if (!changedDuringList && knownRevisions.get(summary.id) !== summary.updatedAt) {
        await broadcastBoard(summary.id);
      }
    }
  };

  // Per-board trailing coalesce, matching the sibling daemon consumers
  // (tools/session-kanban, cli/kanban-hq-sync): every broadcastBoard is a
  // full board fetch + full-board fan-out to every WS client, and the
  // daemon emits one event per mutation — a task drag produced several
  // fetch+broadcast rounds back-to-back.
  const COALESCE_MS = 300;
  const pendingBroadcasts = new Map<string, ReturnType<typeof setTimeout>>();
  const scheduleBroadcast = (boardId: string): void => {
    if (disposed || pendingBroadcasts.has(boardId)) return;
    const timer = setTimeout(() => {
      pendingBroadcasts.delete(boardId);
      void broadcastBoard(boardId).catch(() => {
        // Best-effort: the next explicit refresh or next daemon event
        // will catch transient errors (e.g. board deleted mid-read).
      });
    }, COALESCE_MS);
    timer.unref?.();
    pendingBroadcasts.set(boardId, timer);
  };

  const unsubscribe = bridgeKanbanSupervisor(
    projectRoot,
    async (event) => {
      if (disposed) return;
      // Only board-mutation event families carry a real board id in
      // `data.boardId`. The daemon ALSO emits `workflow.*` events whose
      // first data slot is a workflowId — probing that as a boardId made
      // getBoard() return null, which broadcastBoard treats as "deleted":
      // every SDD/AutoPhase checkpoint fanned a PHANTOM kanban.delete to
      // every connected WS client.
      const family = event.event?.split('.')[0];
      if (family !== 'board' && family !== 'task' && family !== 'column' && family !== 'contract') {
        return;
      }
      const evData = event.data as { boardId?: string } | undefined;
      const boardId = evData?.boardId;
      if (!boardId) return;

      if (event.event === 'board.deleted') {
        const timer = pendingBroadcasts.get(boardId);
        if (timer) {
          clearTimeout(timer);
          pendingBroadcasts.delete(boardId);
        }
        broadcastDeleted(boardId);
        return;
      }
      scheduleBroadcast(boardId);
    },
    {
      autoReconnect: true,
      reconnectDelayMs: 1_000,
      onConnected: reconcileAfterConnect,
    },
  );
  return () => {
    disposed = true;
    for (const timer of pendingBroadcasts.values()) clearTimeout(timer);
    pendingBroadcasts.clear();
    unsubscribe();
  };
}
