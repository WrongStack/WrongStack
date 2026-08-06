/**
 * The one place a Kanban board becomes a WebSocket message.
 *
 * Six call sites built these envelopes by hand — the daemon subscriber,
 * decomposition routes (twice), the task dispatcher (twice), the run mirror and
 * the supervisor. `WSServerMessage` is `{ type: string; payload: unknown }`, so
 * the type system checks none of it: a board sent bare instead of wrapped in
 * `{ board }` compiles, ships, and leaves the client's `isBoard(data)` branch
 * silently unmatched. That has already happened once
 * (`hq-kanban-sync-best-effort`), and hand-copied envelopes are how it happens
 * again.
 *
 * These builders are the shape. Prefer them over an inline literal even for a
 * one-off broadcast — an inline literal is how the seventh site starts.
 */

import type { KanbanBoard, KanbanBoardSummary, KanbanTask } from '@wrongstack/kanban';
import type { WSServerMessage } from './types.js';

/** A full board, for `kanban.get`. The client keys on `data.board`. */
export function kanbanBoardMessage(board: KanbanBoard): WSServerMessage {
  return { type: 'kanban.get', payload: { success: true, data: { board } } };
}

/** The board list, for `kanban.list`. `data` is the array itself, not `{ boards }`. */
export function kanbanListMessage(boards: readonly KanbanBoardSummary[]): WSServerMessage {
  return { type: 'kanban.list', payload: { success: true, data: boards } };
}

/** A single task, for `kanban.task.update`. */
export function kanbanTaskMessage(boardId: string, task: KanbanTask): WSServerMessage {
  return { type: 'kanban.task.update', payload: { success: true, data: { boardId, task } } };
}

/** A removed board, for `kanban.delete`. */
export function kanbanDeletedMessage(boardId: string): WSServerMessage {
  return { type: 'kanban.delete', payload: { success: true, data: { removed: true, boardId } } };
}

/**
 * Broadcast a board, and optionally the refreshed list behind it.
 *
 * The list is opt-in because the client already derives a summary from the
 * board it receives (`kanban-store.ts` calls `upsertSummary` on `kanban.get`),
 * so a second round trip is only needed when the SET of boards changed —
 * created, deleted, renamed. Sites that skipped it were not leaving the sidebar
 * stale; sites that sent it unconditionally were paying for a list read on
 * every task move.
 */
export async function publishKanbanBoard(
  broadcast: (message: WSServerMessage) => void,
  board: KanbanBoard,
  listBoards?: () => Promise<readonly KanbanBoardSummary[]>,
): Promise<void> {
  broadcast(kanbanBoardMessage(board));
  if (!listBoards) return;
  // A failed list read must not swallow the board broadcast that already went
  // out — the client has the board either way.
  try {
    broadcast(kanbanListMessage(await listBoards()));
  } catch {
    // best-effort
  }
}
