import type { Session } from './model';

/** Engine states a conversation can be reconnected from: its engine is not running. */
const STOPPED = new Set<Session['status']>(['stopped', 'error', 'interrupted']);

/** Whether a conversation has a stopped engine that a reconnect could start again. */
export function canReconnect(session: Pick<Session, 'kind' | 'status'>): boolean {
  return session.kind === 'agent' && STOPPED.has(session.status);
}

/** The WrongStack session a conversation's journal recorded, from its `session.start` frame. */
export function recordedSessionId(
  events: readonly { type?: unknown; payload?: unknown }[],
): string | undefined {
  for (const event of events) {
    if (event.type !== 'session.start' || !event.payload || typeof event.payload !== 'object')
      continue;
    const id = (event.payload as Record<string, unknown>)['sessionId'];
    if (typeof id === 'string' && id) return id;
  }
  return undefined;
}

/** How far a conversation's journal has been read in this window. */
export interface JournalProgress {
  /** A view is reading it now; otherwise the reader was kept from an earlier view. */
  open: boolean;
  hydrating: boolean;
  replay: { read: number; total: number } | null;
  lastAt: number;
  sessionId: string;
}

export type JournalStatus =
  | { kind: 'closed' }
  | { kind: 'reading'; percent: number }
  | { kind: 'current' }
  | { kind: 'kept' };

/** The journal reader's state as the diagnostics name it. */
export function journalStatus(progress: JournalProgress | null): JournalStatus {
  if (!progress) return { kind: 'closed' };
  if (progress.hydrating) {
    const { read = 0, total = 0 } = progress.replay ?? {};
    return {
      kind: 'reading',
      percent: total > 0 ? Math.min(99, Math.floor((read / total) * 100)) : 0,
    };
  }
  return progress.open ? { kind: 'current' } : { kind: 'kept' };
}

/** Characters this desktop keeps in its window storage under its own keys. */
export function desktopStorageSize(storage: Pick<Storage, 'length' | 'key' | 'getItem'>): number {
  let size = 0;
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith('wrongstack.desktop.')) continue;
    size += key.length + (storage.getItem(key)?.length ?? 0);
  }
  return size;
}
