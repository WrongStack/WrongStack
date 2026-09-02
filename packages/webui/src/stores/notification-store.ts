import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { i18n } from '@/i18n';
import { safeId } from '@/lib/utils';

export type NotificationVariant = 'success' | 'error' | 'warn' | 'info';
export type ToastVariant = NotificationVariant;

export interface NotificationAction {
  label: string;
  onClick: () => void;
}
export type ToastAction = NotificationAction;

export interface AppNotification {
  id: string;
  message: string;
  variant: NotificationVariant;
  timestamp: number;
  read: boolean;
  ttl?: number | undefined;
  action?: NotificationAction | undefined;
}

export interface ToastEntry {
  id: string;
  message: string;
  variant: NotificationVariant;
  ttl: number;
  action?: NotificationAction | undefined;
}

export const MAX_NOTIFICATIONS = 100;
export const ACTION_TTL_MS = 8_000;

function generateToastId(): string {
  return `toast_${safeId()}`;
}

export interface NotificationStoreState {
  /** All recorded notifications in history, newest first */
  notifications: AppNotification[];
  /** Ephemeral toasts currently rendered on screen */
  toasts: ToastEntry[];

  /** Push a new toast + notification */
  push: (entry: {
    message: string;
    variant: NotificationVariant;
    ttl?: number | undefined;
    action?: NotificationAction | undefined;
  }) => string;

  /** Dismiss active ephemeral toast from screen */
  dismissToast: (id: string) => void;

  /** Mark a single notification as read */
  markAsRead: (id: string) => void;

  /** Mark all notifications as read */
  markAllAsRead: () => void;

  /** Remove a notification from history */
  removeNotification: (id: string) => void;

  /** Clear all notification history */
  clearAll: () => void;
}

export const useNotificationStore = create<NotificationStoreState>()(
  persist(
    (set) => ({
      notifications: [],
      toasts: [],

      push: (entry) => {
        const id = generateToastId();
        const ttl = entry.ttl ?? 3500;
        const now = Date.now();
        const notificationItem: AppNotification = {
          id,
          message: entry.message,
          variant: entry.variant,
          timestamp: now,
          read: false,
          ttl,
          action: entry.action,
        };
        const toastItem: ToastEntry = {
          id,
          message: entry.message,
          variant: entry.variant,
          ttl,
          action: entry.action,
        };

        set((state) => ({
          toasts: [...state.toasts, toastItem],
          notifications: [notificationItem, ...state.notifications].slice(0, MAX_NOTIFICATIONS),
        }));

        return id;
      },

      dismissToast: (id) =>
        set((state) => ({
          toasts: state.toasts.filter((t) => t.id !== id),
        })),

      markAsRead: (id) =>
        set((state) => ({
          notifications: state.notifications.map((n) => (n.id === id ? { ...n, read: true } : n)),
        })),

      markAllAsRead: () =>
        set((state) => ({
          notifications: state.notifications.map((n) => (n.read ? n : { ...n, read: true })),
        })),

      removeNotification: (id) =>
        set((state) => ({
          notifications: state.notifications.filter((n) => n.id !== id),
          toasts: state.toasts.filter((t) => t.id !== id),
        })),

      clearAll: () =>
        set(() => ({
          notifications: [],
        })),
    }),
    {
      name: 'wrongstack-notifications-history',
      // Persist only notifications history, strip out non-serializable callbacks in action,
      // and do not persist active toasts (ephemeral).
      partialize: (state) => ({
        notifications: state.notifications.map(({ action, ...rest }) => ({
          ...rest,
          ...(action ? { action: { label: action.label, onClick: () => {} } } : {}),
        })),
      }),
    },
  ),
);

/** Imperative API. Pass plain strings or arrays of strings for multi-line. */
export const toast = {
  success: (msg: string, ttl = 3500) =>
    useNotificationStore.getState().push({ message: msg, variant: 'success', ttl }),
  error: (msg: string, ttl = 6000) =>
    useNotificationStore.getState().push({ message: msg, variant: 'error', ttl }),
  warn: (msg: string, ttl = 4500) =>
    useNotificationStore.getState().push({ message: msg, variant: 'warn', ttl }),
  info: (msg: string, ttl = 3500) =>
    useNotificationStore.getState().push({ message: msg, variant: 'info', ttl }),
  /**
   * Fire a toast carrying an "Undo" action button. The toast lingers
   * for {@link ACTION_TTL_MS} so the user has time to react; letting it
   * expire is the same as not undoing.
   */
  undoable: (
    msg: string,
    onUndo: () => void,
    label = i18n.t('common:action.undo'),
    ttl = ACTION_TTL_MS,
  ) =>
    useNotificationStore.getState().push({
      message: msg,
      variant: 'info',
      ttl,
      action: { label, onClick: onUndo },
    }),
  dismiss: (id: string) => useNotificationStore.getState().dismissToast(id),
};

export const useToastStore = useNotificationStore;
