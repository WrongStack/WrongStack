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

/**
 * Safety cap on the module-level listener set. Prevents unbounded memory
 * growth when clients subscribe without ever calling the returned disposer
 * (or the process holding the reference crashes before disposal).
 * Mitigation is generative: past this cap, new subscriptions are logged
 * and rejected with a no-op disposer so the leak is visible without
 * crashing the daemon.
 */
const MAX_LISTENERS = 200;
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
  if (listeners.size >= MAX_LISTENERS) {
    const msg = `Kanban event-emitter listener limit (${MAX_LISTENERS}) reached — ` +
      'callers must dispose their board-event subscriptions to prevent unbounded memory growth. ' +
      'Returning no-op disposer; this subscription will not receive events.';
    if (typeof process !== 'undefined' && process.emitWarning) {
      process.emitWarning(msg, 'KanbanEventEmitterWarning');
    } else {
      console.warn(msg);
    }
    return () => {};
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}
