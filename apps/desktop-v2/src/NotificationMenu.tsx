import {
  AlertTriangle,
  Bell,
  BellOff,
  BellRing,
  Check,
  CheckCheck,
  Info,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import { displayDateTime } from './display-dates';
import {
  type DesktopNotification,
  NOTIFICATION_FILTERS,
  type NotificationFilter,
  notificationAge,
  notificationStore,
  notificationView,
  useNotifications,
} from './notification-center';
import { useDetailsDismiss } from './useDetailsDismiss';
import './notification-center.css';

function VariantIcon({ variant }: { variant: DesktopNotification['variant'] }) {
  if (variant === 'success') return <Check size={14} className="notification-icon success" />;
  if (variant === 'error') return <XCircle size={14} className="notification-icon error" />;
  if (variant === 'warn') return <AlertTriangle size={14} className="notification-icon warn" />;
  return <Info size={14} className="notification-icon info" />;
}

/**
 * The top bar's bell: the notification history with a type filter, all/unread tabs, mark-read and
 * clear, as the WebUI's notification menu offers. The conversations needing attention stay one
 * press away inside it.
 */
export function NotificationMenu({
  attention,
  onAttention,
}: {
  /** Conversations that failed or were interrupted. */
  attention: number;
  onAttention: () => void;
}) {
  const { t } = useDesktopText();
  const state = useNotifications();
  const [tab, setTab] = useState<'all' | 'unread'>('all');
  const details = useRef<HTMLDetailsElement | null>(null);
  const dismiss = useDetailsDismiss();
  const { scoped, unread, rows } = notificationView(state, tab);
  const title = t('notificationCenter.title');
  return (
    <details
      className="notification-menu"
      ref={(element) => {
        details.current = element;
        return dismiss(element);
      }}
    >
      <summary
        className="icon-button"
        data-testid="notification-menu-trigger"
        title={unread ? t('notificationCenter.unreadTitle', { count: unread }) : title}
        aria-label={title}
      >
        {unread ? <BellRing size={16} /> : <Bell size={16} />}
        {unread > 0 ? (
          <span className="notification-badge" data-testid="notification-badge">
            {unread > 99 ? '99+' : unread}
          </span>
        ) : (
          attention > 0 && <span className="notification-dot" />
        )}
      </summary>
      <div className="notification-panel">
        <header>
          <strong>{title}</strong>
          {unread > 0 && (
            <span className="notification-unread">
              {t('notificationCenter.unread', { count: unread })}
            </span>
          )}
          <span className="notification-actions">
            <button
              type="button"
              disabled={!state.notifications.some((n) => !n.read)}
              onClick={() => notificationStore.markAllRead()}
            >
              <CheckCheck size={13} />
              {t('notificationCenter.markAllRead')}
            </button>
            <button
              type="button"
              disabled={!state.notifications.length}
              onClick={() => notificationStore.clear()}
            >
              <Trash2 size={13} />
              {t('notificationCenter.clearAll')}
            </button>
          </span>
        </header>
        <label className="notification-filter">
          <span>{t('notificationCenter.show')}</span>
          <select
            aria-label={t('notificationCenter.show')}
            value={state.filter}
            onChange={(event) =>
              notificationStore.setFilter(event.target.value as NotificationFilter)
            }
          >
            {NOTIFICATION_FILTERS.map((filter) => (
              <option key={filter} value={filter}>
                {t(`notificationCenter.filter.${filter}`)}
              </option>
            ))}
          </select>
        </label>
        {/* biome-ignore lint/a11y/useSemanticElements: a fieldset's border and padding would change this segmented control. */}
        <div className="notification-tabs" role="group" aria-label={t('notificationCenter.tabs')}>
          {(['all', 'unread'] as const).map((name) => (
            <button
              key={name}
              type="button"
              aria-pressed={tab === name}
              onClick={() => setTab(name)}
            >
              {t(`notificationCenter.tab.${name}`, {
                n: name === 'all' ? scoped.length : unread,
              })}
            </button>
          ))}
        </div>
        {attention > 0 && (
          <button
            type="button"
            className="notification-attention"
            onClick={() => {
              if (details.current) details.current.open = false;
              onAttention();
            }}
          >
            <AlertTriangle size={13} />
            {t('notificationCenter.attention', { count: attention })}
          </button>
        )}
        <ul className="notification-list" aria-label={title}>
          {rows.length === 0 ? (
            <li className="notification-empty">
              <BellOff size={22} />
              <strong>
                {tab === 'unread' && scoped.length
                  ? t('notificationCenter.allRead')
                  : state.notifications.length
                    ? t('notificationCenter.emptyFiltered')
                    : t('notificationCenter.empty')}
              </strong>
              <small>
                {tab === 'unread' && scoped.length
                  ? t('notificationCenter.allReadHint')
                  : state.notifications.length
                    ? t('notificationCenter.emptyFilteredHint')
                    : t('notificationCenter.emptyHint')}
              </small>
            </li>
          ) : (
            rows.map((item) => (
              <li key={item.id} className={item.read ? 'read' : 'unread'} data-unread={!item.read}>
                <VariantIcon variant={item.variant} />
                <div>
                  <p>{item.message}</p>
                  <time dateTime={new Date(item.timestamp).toISOString()}>
                    <span title={displayDateTime(item.timestamp)}>
                      {notificationAge(item.timestamp, (key, count) =>
                        count === undefined ? t(key) : t(key, { count }),
                      )}
                    </span>
                  </time>
                </div>
                {!item.read && (
                  <button
                    type="button"
                    className="icon-button"
                    title={t('notificationCenter.markRead')}
                    aria-label={t('notificationCenter.markRead')}
                    onClick={() => notificationStore.markRead(item.id)}
                  >
                    <Check size={12} />
                  </button>
                )}
                <button
                  type="button"
                  className="icon-button"
                  title={t('notificationCenter.remove')}
                  aria-label={t('notificationCenter.remove')}
                  onClick={() => notificationStore.remove(item.id)}
                >
                  <X size={12} />
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </details>
  );
}
