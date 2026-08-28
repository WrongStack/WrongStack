import {
  AlertTriangle,
  Bell,
  BellOff,
  BellRing,
  Check,
  CheckCheck,
  Clock,
  Info,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import {
  type AppNotification,
  type NotificationVariant,
  useNotificationStore,
} from '@/stores/notification-store';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';

function formatRelativeTime(
  timestamp: number,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const diff = Math.max(0, Date.now() - timestamp);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 10) {
    return t('toasts:menu.justNow', { defaultValue: 'Just now' });
  }
  if (seconds < 60) {
    return t('toasts:menu.secondsAgo', { count: seconds, defaultValue: `${seconds}s ago` });
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return t('toasts:menu.minutesAgo', { count: minutes, defaultValue: `${minutes}m ago` });
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return t('toasts:menu.hoursAgo', { count: hours, defaultValue: `${hours}h ago` });
  }
  const days = Math.floor(hours / 24);
  return t('toasts:menu.daysAgo', { count: days, defaultValue: `${days}d ago` });
}

function NotificationIcon({ variant }: { variant: NotificationVariant }) {
  if (variant === 'success') {
    return <Check className="h-4 w-4 text-success shrink-0" />;
  }
  if (variant === 'error') {
    return <XCircle className="h-4 w-4 text-destructive shrink-0" />;
  }
  if (variant === 'warn') {
    return <AlertTriangle className="h-4 w-4 text-warning shrink-0" />;
  }
  return <Info className="h-4 w-4 text-info shrink-0" />;
}

function NotificationItem({
  item,
  onMarkAsRead,
  onRemove,
}: {
  item: AppNotification;
  onMarkAsRead: () => void;
  onRemove: () => void;
}) {
  const { t } = useAppTranslation();
  const timeFormatted = useMemo(() => formatRelativeTime(item.timestamp, t), [item.timestamp, t]);
  const dateFormatted = useMemo(() => new Date(item.timestamp).toLocaleString(), [item.timestamp]);

  return (
    <div
      role="listitem"
      tabIndex={0}
      onClick={() => {
        if (!item.read) onMarkAsRead();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (!item.read) onMarkAsRead();
        }
      }}
      className={cn(
        'group relative flex items-start gap-2.5 px-3 py-2.5 text-xs transition-colors cursor-pointer outline-none select-none',
        'hover:bg-accent/50 focus-visible:bg-accent/60',
        item.read ? 'opacity-85' : 'bg-primary/[0.04]',
      )}
    >
      <div className="mt-0.5 shrink-0">
        <NotificationIcon variant={item.variant} />
      </div>

      <div className="flex-1 min-w-0 pr-1">
        <div
          className={cn(
            'whitespace-pre-wrap break-words leading-relaxed text-foreground',
            !item.read && 'font-medium',
          )}
        >
          {item.message}
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
          <span className="inline-flex items-center gap-0.5" title={dateFormatted}>
            <Clock className="h-3 w-3 opacity-70" />
            {timeFormatted}
          </span>

          {item.action && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                item.action?.onClick();
                onMarkAsRead();
              }}
              className="font-medium text-primary hover:underline"
            >
              {item.action.label}
            </button>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {!item.read && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onMarkAsRead();
            }}
            className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            title={t('toasts:menu.markAsRead', { defaultValue: 'Mark as read' })}
            aria-label={t('toasts:menu.markAsRead', { defaultValue: 'Mark as read' })}
          >
            <Check className="h-3 w-3" />
          </button>
        )}

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="rounded p-0.5 text-muted-foreground opacity-60 hover:opacity-100 hover:bg-destructive/10 hover:text-destructive transition-opacity"
          title={t('toasts:menu.remove', { defaultValue: 'Remove notification' })}
          aria-label={t('toasts:menu.remove', { defaultValue: 'Remove notification' })}
        >
          <X className="h-3 w-3" />
        </button>

        {!item.read && (
          <span
            className="h-1.5 w-1.5 rounded-full bg-primary shrink-0"
            aria-label="Unread indicator"
          />
        )}
      </div>
    </div>
  );
}

export function NotificationMenu({
  defaultOpen,
  open,
  onOpenChange,
}: {
  defaultOpen?: boolean | undefined;
  open?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
} = {}) {
  const { t } = useAppTranslation();
  const notifications = useNotificationStore((s) => s.notifications);
  const markAsRead = useNotificationStore((s) => s.markAsRead);
  const markAllAsRead = useNotificationStore((s) => s.markAllAsRead);
  const clearAll = useNotificationStore((s) => s.clearAll);
  const removeNotification = useNotificationStore((s) => s.removeNotification);

  const [tab, setTab] = useState<'all' | 'unread'>('all');

  const unreadCount = useMemo(
    () => notifications.filter((n) => !n.read).length,
    [notifications],
  );

  const filteredNotifications = useMemo(() => {
    if (tab === 'unread') {
      return notifications.filter((n) => !n.read);
    }
    return notifications;
  }, [notifications, tab]);

  const handleMarkAllRead = useCallback(() => {
    markAllAsRead();
  }, [markAllAsRead]);

  const handleClearAll = useCallback(() => {
    clearAll();
  }, [clearAll]);

  return (
    <DropdownMenu
      defaultOpen={defaultOpen}
      open={open}
      onOpenChange={onOpenChange}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="notification-menu-trigger"
          className={cn(
            'relative inline-flex h-8 w-8 items-center justify-center rounded-md border border-border/70 bg-background/60 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground',
            unreadCount > 0 && 'text-foreground',
          )}
          title={
            unreadCount > 0
              ? `${t('toasts:menu.title', { defaultValue: 'Notifications' })} (${unreadCount} ${t('toasts:menu.unreadCount', { count: unreadCount, defaultValue: `${unreadCount} unread` })})`
              : t('toasts:menu.title', { defaultValue: 'Notifications' })
          }
          aria-label={t('toasts:menu.title', { defaultValue: 'Notifications' })}
        >
          {unreadCount > 0 ? (
            <BellRing className="h-3.5 w-3.5 text-primary" />
          ) : (
            <Bell className="h-3.5 w-3.5" />
          )}

          {unreadCount > 0 && (
            <span
              data-testid="notification-badge"
              className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground shadow-sm"
            >
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        sideOffset={6}
        className="w-80 sm:w-96 max-w-[calc(100vw-1rem)] p-0 rounded-xl border border-border/80 bg-card/95 backdrop-blur-xl shadow-2xl overflow-hidden text-card-foreground"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/60 px-3.5 py-2.5 bg-muted/30">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-xs text-foreground">
              {t('toasts:menu.title', { defaultValue: 'Notifications' })}
            </span>
            {unreadCount > 0 ? (
              <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary tabular-nums">
                {unreadCount} {t('toasts:menu.tabUnread', { defaultValue: 'Unread' }).toLowerCase()}
              </span>
            ) : null}
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={unreadCount === 0}
              onClick={handleMarkAllRead}
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground disabled:opacity-40 disabled:pointer-events-none"
              title={t('toasts:menu.markAllRead', { defaultValue: 'Mark all as read' })}
            >
              <CheckCheck className="h-3.5 w-3.5" />
              <span>{t('toasts:menu.markAllRead', { defaultValue: 'Mark all as read' })}</span>
            </button>

            <button
              type="button"
              disabled={notifications.length === 0}
              onClick={handleClearAll}
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40 disabled:pointer-events-none"
              title={t('toasts:menu.clearAll', { defaultValue: 'Clear all' })}
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>{t('toasts:menu.clearAll', { defaultValue: 'Clear all' })}</span>
            </button>
          </div>
        </div>

        {/* Tab filters */}
        <div className="flex border-b border-border/50 bg-background/50 px-3 py-1.5 gap-1.5 text-xs">
          <button
            type="button"
            onClick={() => setTab('all')}
            className={cn(
              'flex-1 rounded-md px-2.5 py-1 text-center font-medium transition-all',
              tab === 'all'
                ? 'bg-accent text-accent-foreground shadow-xs'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            )}
          >
            {t('toasts:menu.tabAll', { defaultValue: 'All' })} ({notifications.length})
          </button>
          <button
            type="button"
            onClick={() => setTab('unread')}
            className={cn(
              'flex-1 rounded-md px-2.5 py-1 text-center font-medium transition-all',
              tab === 'unread'
                ? 'bg-accent text-accent-foreground shadow-xs'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            )}
          >
            {t('toasts:menu.tabUnread', { defaultValue: 'Unread' })} ({unreadCount})
          </button>
        </div>

        {/* Notification list */}
        <div
          role="list"
          className="max-h-[340px] overflow-y-auto divide-y divide-border/30"
          aria-label={t('toasts:menu.title', { defaultValue: 'Notifications' })}
        >
          {filteredNotifications.length === 0 ? (
            <div className="flex flex-col items-center justify-center px-4 py-8 text-center text-muted-foreground">
              <BellOff className="h-7 w-7 text-muted-foreground/40 mb-2" />
              <p className="text-xs font-medium text-foreground">
                {tab === 'unread' && notifications.length > 0
                  ? t('toasts:menu.allRead', { defaultValue: 'All caught up' })
                  : t('toasts:menu.empty', { defaultValue: 'No notifications' })}
              </p>
              <p className="text-[11px] text-muted-foreground mt-0.5 max-w-[220px]">
                {tab === 'unread' && notifications.length > 0
                  ? t('toasts:menu.allRead', { defaultValue: 'All caught up' })
                  : t('toasts:menu.emptyHint', {
                      defaultValue: 'Toasts and system notifications will appear here.',
                    })}
              </p>
            </div>
          ) : (
            filteredNotifications.map((item) => (
              <NotificationItem
                key={item.id}
                item={item}
                onMarkAsRead={() => markAsRead(item.id)}
                onRemove={() => removeNotification(item.id)}
              />
            ))
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
