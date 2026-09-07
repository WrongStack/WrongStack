import { useEffect } from 'react';

const BASE_TITLE = 'WrongStack SimpleUI';

export interface UseTabTitleOptions {
  /** A run is in flight — mark the tab so it's findable from other tabs. */
  running: boolean;
  /** Unread mailbox messages — shown as a `(n)` prefix, browser convention. */
  unreadCount: number;
}

/**
 * Reflects session presence in `document.title`: a `(n)` unread prefix, a
 * `●` marker while a run is in flight, and the exact base title when idle
 * and caught up. Recomputes purely from props on change (no listeners) and
 * restores the base title on unmount so a torn-down session never leaves a
 * stale marker behind.
 */
export function useTabTitle({ running, unreadCount }: UseTabTitleOptions): void {
  useEffect(() => {
    const parts: string[] = [];
    if (unreadCount > 0) parts.push(`(${unreadCount})`);
    if (running) parts.push('●');
    document.title = parts.length > 0 ? `${parts.join(' ')} ${BASE_TITLE}` : BASE_TITLE;
  }, [running, unreadCount]);

  useEffect(
    () => () => {
      document.title = BASE_TITLE;
    },
    [],
  );
}
