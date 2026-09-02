/**
 * MailboxEventEmitter — minimal pub/sub for real-time push to SSE clients.
 *
 * The HTTP bridge uses this to push `send`/`ack`/`delete` events to
 * connected SSE clients without requiring them to poll. Each event is a
 * shallow copy of the relevant data (message id, action, timestamp) —
 * never the full mailbox state.
 *
 * The emitter is intentionally simple: a Set of listeners, add/remove,
 * and emit. No buffering, no replay — if a client connects after a send,
 * it won't receive past events (it should query first to catch up).
 *
 * @module mailbox-events
 */

import type { MailboxAudience } from './mailbox-types.js';

export type MailboxEventType =
  | 'message.sent'
  | 'message.acked'
  | 'message.deleted'
  | 'message.restored';

export interface MailboxEvent {
  type: MailboxEventType;
  messageId: string;
  from?: string | undefined;
  to?: string | undefined;
  audience?: MailboxAudience | undefined;
  timestamp: string;
}

export type MailboxEventListener = (event: MailboxEvent) => void;

export class MailboxEventEmitter {
  private listeners = new Set<MailboxEventListener>();

  subscribe(fn: MailboxEventListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  emit(event: MailboxEvent): void {
    const snapshot = [...this.listeners];
    for (const fn of snapshot) {
      try {
        fn(event);
      } catch {
        /* listener must not crash the emitter */
      }
    }
  }

  /** Number of active subscribers (for observability / metrics). */
  get subscriberCount(): number {
    return this.listeners.size;
  }

  clear(): void {
    this.listeners.clear();
  }
}
