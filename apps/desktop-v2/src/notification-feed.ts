import { useEffect, useRef } from 'react';
import type { ConversationNotice } from './conversation-notices';
import { useDesktopText } from './desktop-i18n';
import type { Session } from './model';
import { type NotificationVariant, notificationStore } from './notification-center';

type Status = Session['status'];

/**
 * What a conversation's status change is worth telling, or null: a failure, an interruption, or a
 * live conversation that stopped. The first snapshot only seeds the known statuses.
 */
export function sessionTransition(
  before: Status | undefined,
  after: Status,
): { key: 'failed' | 'interrupted' | 'stopped'; variant: NotificationVariant } | null {
  if (before === undefined || before === after) return null;
  if (after === 'error') return { key: 'failed', variant: 'error' };
  if (after === 'interrupted') return { key: 'interrupted', variant: 'warn' };
  if (
    after === 'stopped' &&
    (before === 'running' || before === 'starting' || before === 'stopping')
  )
    return { key: 'stopped', variant: 'success' };
  return null;
}

/** Records the shell's error banner and conversation status changes in the notification history. */
export function useNotificationFeed(error: string, sessions: readonly Session[]): void {
  const { t } = useDesktopText();
  useEffect(() => {
    if (error) notificationStore.push({ message: error, variant: 'error' });
  }, [error]);
  const known = useRef<Map<string, Status> | null>(null);
  useEffect(() => {
    const previous = known.current;
    known.current = new Map(sessions.map((session) => [session.id, session.status]));
    if (!previous) return;
    for (const session of sessions) {
      const change = sessionTransition(previous.get(session.id), session.status);
      if (!change) continue;
      const title = session.title || session.id.slice(0, 8);
      notificationStore.push({
        variant: change.variant,
        message:
          change.key === 'failed' && session.error
            ? t('notificationCenter.session.failedWith', { title, error: session.error })
            : t(`notificationCenter.session.${change.key}`, { title }),
      });
    }
  }, [sessions, t]);
}

const forwarded = new Set<string>();
const openedAt = Date.now();

/**
 * Adds a conversation notice to the history once: a passing one (always live) or a warning or error
 * raised after this window opened, never one replayed from an older journal.
 */
export function forwardConversationNotice(notice: ConversationNotice, text: string): boolean {
  const key = `${notice.id}\0${notice.at}\0${notice.text}`;
  if (forwarded.has(key)) return false;
  if (!notice.transient && (notice.severity === 'info' || notice.at < openedAt)) return false;
  forwarded.add(key);
  notificationStore.push({
    message: text,
    variant:
      notice.severity === 'error' ? 'error' : notice.severity === 'warning' ? 'warn' : 'info',
  });
  return true;
}
