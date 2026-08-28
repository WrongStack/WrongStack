import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationMenu } from '../../src/components/NotificationMenu';
import {
  ACTION_TTL_MS,
  MAX_NOTIFICATIONS,
  toast,
  useNotificationStore,
} from '../../src/stores/notification-store';

vi.mock('../../src/i18n', () => ({
  useAppTranslation: () => ({
    t: (k: string, options?: Record<string, unknown>) => {
      if (options?.count !== undefined) {
        return `${options.count} ${k}`;
      }
      if (options?.defaultValue) {
        return String(options.defaultValue);
      }
      return k;
    },
  }),
  i18n: {
    t: (k: string) => k,
  },
}));

describe('NotificationStore', () => {
  beforeEach(() => {
    useNotificationStore.setState({ notifications: [], toasts: [] });
  });

  it('pushes toasts to both ephemeral toasts and historical notifications', () => {
    const id = toast.success('Operation succeeded');

    const state = useNotificationStore.getState();
    expect(state.toasts).toHaveLength(1);
    expect(state.toasts[0]?.id).toBe(id);
    expect(state.toasts[0]?.message).toBe('Operation succeeded');
    expect(state.toasts[0]?.variant).toBe('success');

    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0]?.id).toBe(id);
    expect(state.notifications[0]?.message).toBe('Operation succeeded');
    expect(state.notifications[0]?.variant).toBe('success');
    expect(state.notifications[0]?.read).toBe(false);
  });

  it('dismissToast removes from ephemeral toasts but keeps in notification history', () => {
    const id = toast.info('System info');
    expect(useNotificationStore.getState().toasts).toHaveLength(1);
    expect(useNotificationStore.getState().notifications).toHaveLength(1);

    toast.dismiss(id);
    expect(useNotificationStore.getState().toasts).toHaveLength(0);
    expect(useNotificationStore.getState().notifications).toHaveLength(1);
    expect(useNotificationStore.getState().notifications[0]?.read).toBe(false);
  });

  it('markAsRead marks specific notification as read', () => {
    const id1 = toast.info('Notice 1');
    const id2 = toast.warn('Warning 2');

    useNotificationStore.getState().markAsRead(id1);

    const notifications = useNotificationStore.getState().notifications;
    const n1 = notifications.find((n) => n.id === id1);
    const n2 = notifications.find((n) => n.id === id2);

    expect(n1?.read).toBe(true);
    expect(n2?.read).toBe(false);
  });

  it('markAllAsRead marks all notifications as read', () => {
    toast.info('Item 1');
    toast.error('Item 2');
    toast.warn('Item 3');

    expect(useNotificationStore.getState().notifications.filter((n) => !n.read)).toHaveLength(3);

    useNotificationStore.getState().markAllAsRead();

    expect(useNotificationStore.getState().notifications.filter((n) => !n.read)).toHaveLength(0);
  });

  it('removeNotification removes item from both notifications and toasts', () => {
    const id1 = toast.info('Keep me');
    const id2 = toast.error('Delete me');

    useNotificationStore.getState().removeNotification(id2);

    const state = useNotificationStore.getState();
    expect(state.notifications.some((n) => n.id === id2)).toBe(false);
    expect(state.notifications.some((n) => n.id === id1)).toBe(true);
    expect(state.toasts.some((t) => t.id === id2)).toBe(false);
  });

  it('clearAll clears all notifications', () => {
    toast.info('Item 1');
    toast.success('Item 2');

    useNotificationStore.getState().clearAll();

    expect(useNotificationStore.getState().notifications).toHaveLength(0);
  });

  it('caps notification history at MAX_NOTIFICATIONS', () => {
    for (let i = 0; i < MAX_NOTIFICATIONS + 15; i++) {
      toast.info(`Message ${i}`);
    }

    const state = useNotificationStore.getState();
    expect(state.notifications).toHaveLength(MAX_NOTIFICATIONS);
    // Newest notifications are kept
    expect(state.notifications[0]?.message).toBe(`Message ${MAX_NOTIFICATIONS + 14}`);
  });

  it('undoable toast attaches action and default TTL', () => {
    const onUndo = vi.fn();
    const id = toast.undoable('File deleted', onUndo);

    const state = useNotificationStore.getState();
    const item = state.notifications.find((n) => n.id === id);
    expect(item).toBeDefined();
    expect(item?.action?.label).toBe('common:action.undo');
    expect(item?.ttl).toBe(ACTION_TTL_MS);

    item?.action?.onClick();
    expect(onUndo).toHaveBeenCalledTimes(1);
  });
});

describe('NotificationMenu Component', () => {
  beforeEach(() => {
    useNotificationStore.setState({ notifications: [], toasts: [] });
  });

  it('renders trigger button with no badge when unread count is 0', () => {
    render(<NotificationMenu />);

    const trigger = screen.getByTestId('notification-menu-trigger');
    expect(trigger).not.toBeNull();
    expect(screen.queryByTestId('notification-badge')).toBeNull();
  });

  it('renders badge with correct unread count when notifications exist', () => {
    toast.info('Alert 1');
    toast.error('Alert 2');

    render(<NotificationMenu />);

    const badge = screen.getByTestId('notification-badge');
    expect(badge).not.toBeNull();
    expect(badge.textContent).toBe('2');
  });

  it('shows 99+ when unread count exceeds 99', () => {
    for (let i = 0; i < 105; i++) {
      toast.info(`Notice ${i}`);
    }

    render(<NotificationMenu />);

    const badge = screen.getByTestId('notification-badge');
    expect(badge).not.toBeNull();
    expect(badge.textContent).toBe('99+');
  });

  it('opens flyout menu when trigger is clicked and displays notification items', () => {
    toast.success('Session restored');
    toast.error('Network unreachable');

    render(<NotificationMenu defaultOpen />);

    expect(screen.getByText('Session restored')).not.toBeNull();
    expect(screen.getByText('Network unreachable')).not.toBeNull();
  });

  it('allows marking all as read from the menu header', () => {
    toast.info('Message A');
    toast.info('Message B');

    render(<NotificationMenu defaultOpen />);

    const markAllBtn = screen.getByTitle('Mark all as read') as HTMLButtonElement;
    expect(markAllBtn.disabled).toBe(false);

    fireEvent.click(markAllBtn);

    expect(useNotificationStore.getState().notifications.every((n) => n.read)).toBe(true);
    expect(screen.queryByTestId('notification-badge')).toBeNull();
  });

  it('allows clearing all notifications from the menu header', () => {
    toast.info('Message 1');

    render(<NotificationMenu defaultOpen />);

    const clearAllBtn = screen.getByTitle('Clear all') as HTMLButtonElement;
    expect(clearAllBtn.disabled).toBe(false);

    fireEvent.click(clearAllBtn);

    expect(useNotificationStore.getState().notifications).toHaveLength(0);
    expect(screen.getByText('No notifications')).not.toBeNull();
  });

  it('filters notifications when switching between All and Unread tabs', () => {
    const id1 = toast.info('Unread message');
    const id2 = toast.success('Read message');
    useNotificationStore.getState().markAsRead(id2);

    render(<NotificationMenu defaultOpen />);

    expect(screen.getByText('Unread message')).not.toBeNull();
    expect(screen.getByText('Read message')).not.toBeNull();

    const unreadTab = screen.getByRole('button', { name: /Unread/ });
    fireEvent.click(unreadTab);

    expect(screen.getByText('Unread message')).not.toBeNull();
    expect(screen.queryByText('Read message')).toBeNull();
  });

  it('marks a notification as read when clicking it', () => {
    const id = toast.warn('Warning message');

    render(<NotificationMenu defaultOpen />);

    const itemEl = screen.getByText('Warning message');
    fireEvent.click(itemEl);

    const item = useNotificationStore.getState().notifications.find((n) => n.id === id);
    expect(item?.read).toBe(true);
  });

  it('removes a single notification when clicking remove button', () => {
    const id = toast.error('Temporary error');

    render(<NotificationMenu defaultOpen />);

    const removeBtn = screen.getByTitle('Remove notification');
    fireEvent.click(removeBtn);

    expect(useNotificationStore.getState().notifications.some((n) => n.id === id)).toBe(false);
  });

  it('executes action callback when clicking action button in notification', () => {
    const onUndo = vi.fn();
    toast.undoable('Workspace reset', onUndo, 'Undo Change');

    render(<NotificationMenu defaultOpen />);

    const actionBtn = screen.getByText('Undo Change');
    fireEvent.click(actionBtn);

    expect(onUndo).toHaveBeenCalledTimes(1);
  });
});
