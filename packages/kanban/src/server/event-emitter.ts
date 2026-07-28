/**
 * Kanban Project Server — mutation event emitter
 *
 * Server-side singleton. Emits structured events whenever a board is mutated.
 * Clients subscribed to the server receive these as push frames.
 */
import type { KanbanEventName } from './protocol.js';

export interface KanbanMutationEvent {
  event: KanbanEventName;
  data: {
    boardId: string;
    taskId?: string | undefined;
    columnId?: string | undefined;
    payload?: unknown | undefined;
    timestamp: string;
  };
}

type Listener = (ev: KanbanMutationEvent) => void;

const listeners = new Set<Listener>();

export function emitBoardEvent(
  event: KanbanEventName,
  boardId: string,
  payload?: unknown,
  taskId?: string,
  columnId?: string,
): void {
  const ev: KanbanMutationEvent = {
    event,
    data: {
      boardId,
      taskId,
      columnId,
      payload,
      timestamp: new Date().toISOString(),
    },
  };
  for (const l of listeners) {
    try {
      l(ev);
    } catch {
      // Swallow listener errors — one bad listener must not break others
    }
  }
}

export function subscribeToBoardEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
