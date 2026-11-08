import { useSyncExternalStore } from 'react';

/**
 * The desktop's notification history, as the WebUI's notification menu keeps it: every report the
 * shell raised (an error banner, a conversation that failed or paused, an engine notice), newest
 * first, with a read mark, a type filter and a clear. Kept in this window's storage so a restart
 * still shows what happened; the wording is stored as it was shown.
 */
export type NotificationVariant = 'success' | 'error' | 'warn' | 'info';
export type NotificationFilter = 'important' | 'all' | NotificationVariant;

export interface DesktopNotification {
  id: string;
  message: string;
  variant: NotificationVariant;
  timestamp: number;
  read: boolean;
}

export interface NotificationState {
  notifications: DesktopNotification[];
  filter: NotificationFilter;
}

const NOTIFICATION_LIMIT = 100;
export const NOTIFICATION_FILTERS: readonly NotificationFilter[] = [
  'important',
  'all',
  'error',
  'warn',
  'success',
  'info',
];
const VARIANTS: readonly NotificationVariant[] = ['success', 'error', 'warn', 'info'];
const NOTIFICATIONS_KEY = 'wrongstack.desktop.notifications';

const emptyNotifications: NotificationState = { notifications: [], filter: 'important' };

/** Whether a notification belongs to the chosen type: "important" is warnings and errors. */
function matchesNotificationFilter(
  notification: Pick<DesktopNotification, 'variant'>,
  filter: NotificationFilter,
): boolean {
  if (filter === 'all') return true;
  if (filter === 'important')
    return notification.variant === 'error' || notification.variant === 'warn';
  return notification.variant === filter;
}

/** Adds a notification at the top; the oldest fall out past the limit. A repeat of the newest is dropped. */
function pushNotification(
  state: NotificationState,
  entry: { message: string; variant: NotificationVariant },
  now = Date.now(),
  id = `n_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
): NotificationState {
  const message = entry.message.trim();
  if (!message) return state;
  const newest = state.notifications[0];
  // The same report raised again within a few seconds (a re-render, a retried request) is one event.
  if (
    newest &&
    newest.message === message &&
    newest.variant === entry.variant &&
    now - newest.timestamp < 5000
  )
    return state;
  return {
    ...state,
    notifications: [
      { id, message, variant: entry.variant, timestamp: now, read: false },
      ...state.notifications,
    ].slice(0, NOTIFICATION_LIMIT),
  };
}

function markNotificationRead(state: NotificationState, id: string): NotificationState {
  return {
    ...state,
    notifications: state.notifications.map((n) => (n.id === id ? { ...n, read: true } : n)),
  };
}

function markAllNotificationsRead(state: NotificationState): NotificationState {
  return {
    ...state,
    notifications: state.notifications.map((n) => (n.read ? n : { ...n, read: true })),
  };
}

function removeNotification(state: NotificationState, id: string): NotificationState {
  return { ...state, notifications: state.notifications.filter((n) => n.id !== id) };
}

function clearNotifications(state: NotificationState): NotificationState {
  return { ...state, notifications: [] };
}

/** The history and unread count within the chosen type, and the rows a read tab shows. */
export function notificationView(state: NotificationState, tab: 'all' | 'unread') {
  const scoped = state.notifications.filter((n) => matchesNotificationFilter(n, state.filter));
  const unread = scoped.filter((n) => !n.read);
  return { scoped, unread: unread.length, rows: tab === 'unread' ? unread : scoped };
}

/** Reads a saved history, dropping anything malformed instead of failing. */
function readNotifications(raw: string | null): NotificationState {
  if (!raw) return emptyNotifications;
  try {
    const value = JSON.parse(raw) as { notifications?: unknown; filter?: unknown };
    const filter = NOTIFICATION_FILTERS.includes(value.filter as NotificationFilter)
      ? (value.filter as NotificationFilter)
      : 'important';
    const notifications = Array.isArray(value.notifications)
      ? value.notifications.filter(
          (n): n is DesktopNotification =>
            !!n &&
            typeof n.id === 'string' &&
            typeof n.message === 'string' &&
            VARIANTS.includes(n.variant) &&
            Number.isFinite(n.timestamp) &&
            typeof n.read === 'boolean',
        )
      : [];
    return { filter, notifications: notifications.slice(0, NOTIFICATION_LIMIT) };
  } catch {
    return emptyNotifications;
  }
}

/** How long ago, in the display language's words (seconds, minutes, hours, days). */
export function notificationAge(
  timestamp: number,
  say: (key: string, count?: number) => string,
  now = Date.now(),
): string {
  const seconds = Math.floor(Math.max(0, now - timestamp) / 1000);
  if (seconds < 10) return say('notificationCenter.justNow');
  if (seconds < 60) return say('notificationCenter.secondsAgo', seconds);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return say('notificationCenter.minutesAgo', minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return say('notificationCenter.hoursAgo', hours);
  return say('notificationCenter.daysAgo', Math.floor(hours / 24));
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

let current: NotificationState = readNotifications(storage()?.getItem(NOTIFICATIONS_KEY) ?? null);
const listeners = new Set<() => void>();

function commit(next: NotificationState): void {
  if (next === current) return;
  current = next;
  try {
    storage()?.setItem(NOTIFICATIONS_KEY, JSON.stringify(next));
  } catch {
    /* the history is a convenience; a full or blocked storage only loses it on restart */
  }
  for (const listener of listeners) listener();
}

/** The window's notification history; every desktop surface reports into this one. */
export const notificationStore = {
  get: (): NotificationState => current,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  push: (entry: { message: string; variant: NotificationVariant }) =>
    commit(pushNotification(current, entry)),
  markRead: (id: string) => commit(markNotificationRead(current, id)),
  markAllRead: () => commit(markAllNotificationsRead(current)),
  remove: (id: string) => commit(removeNotification(current, id)),
  clear: () => commit(clearNotifications(current)),
  setFilter: (filter: NotificationFilter) => commit({ ...current, filter }),
  /** Re-reads the saved history (another window, or a test). */
  reload: () => commit(readNotifications(storage()?.getItem(NOTIFICATIONS_KEY) ?? null)),
};

export function useNotifications(): NotificationState {
  return useSyncExternalStore(notificationStore.subscribe, notificationStore.get);
}
