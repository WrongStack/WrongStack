import type { EventBus } from '../event-bus-port.js';

export type SessionStoreReadOperation =
  | 'load'
  | 'load_events_only'
  | 'list'
  | 'summary'
  | 'index_read';

export type SessionStoreWriteOperation =
  | 'create'
  | 'resume'
  | 'rename'
  | 'append'
  | 'flush'
  | 'close'
  | 'index_append'
  | 'compact'
  | 'checkpoint';

export type SessionStoreOutcome = 'success' | 'failure';

export function emitSessionStoreRead(
  events: EventBus | undefined,
  sessionId: string,
  filePath: string,
  operation: SessionStoreReadOperation,
  outcome: SessionStoreOutcome,
  durationMs: number,
  error?: string,
): void {
  events?.emit('storage.read', {
    sessionId,
    store: 'session',
    filePath,
    operation,
    outcome,
    durationMs,
    ...(error !== undefined ? { error } : {}),
  });
}

export function emitSessionStoreWrite(
  events: EventBus | undefined,
  sessionId: string,
  filePath: string,
  operation: SessionStoreWriteOperation,
  outcome: SessionStoreOutcome,
  durationMs: number,
  eventCount?: number,
  error?: string,
): void {
  events?.emit('storage.write', {
    sessionId,
    store: 'session',
    filePath,
    operation,
    outcome,
    durationMs,
    ...(eventCount !== undefined ? { eventCount } : {}),
    ...(error !== undefined ? { error } : {}),
  });
}

export function emitSessionStoreError(
  events: EventBus | undefined,
  sessionId: string,
  filePath: string,
  operation: string,
  error: string,
  recoverable: boolean,
): void {
  events?.emit('storage.error', {
    sessionId,
    store: 'session',
    filePath,
    operation,
    error,
    recoverable,
  });
}
