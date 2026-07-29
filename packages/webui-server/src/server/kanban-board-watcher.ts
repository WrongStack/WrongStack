/**
 * Compatibility alias for the old file-watcher entry point.
 *
 * Kanban is now server-owned SQLite, so liveness comes from daemon events and
 * board reloads travel through IPC. Keep this export for downstream callers
 * without allowing a filesystem watcher to reintroduce a second data path.
 */
import type { WSServerMessage } from './types.js';
import { subscribeKanbanDaemonEvents } from './kanban-daemon-subscriber.js';

export function watchKanbanBoards(
  projectRoot: string,
  broadcastMessage: (message: WSServerMessage) => void,
): () => void {
  return subscribeKanbanDaemonEvents(projectRoot, broadcastMessage);
}
