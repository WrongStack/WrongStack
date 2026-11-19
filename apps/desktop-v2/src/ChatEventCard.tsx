import type { ReactNode } from 'react';
import './chat-cards.css';

export type ChatEventTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

/**
 * The conversation's card for something that happened beside the messages (a Brain decision,
 * a review, a model switch): an icon in its tone, a title with a short meta line, an optional
 * badge, the decisions on the right, and a body under them.
 */
export function ChatEventCard({
  tone = 'neutral',
  attention = false,
  icon,
  title,
  meta,
  badge,
  actions,
  children,
  className = '',
  label,
  role,
  data,
}: {
  tone?: ChatEventTone | undefined;
  /** Waits on the reader (a question, a countdown): the whole card carries its tone. */
  attention?: boolean | undefined;
  icon: ReactNode;
  title: ReactNode;
  meta?: ReactNode | undefined;
  badge?: ReactNode | undefined;
  actions?: ReactNode | undefined;
  children?: ReactNode | undefined;
  className?: string | undefined;
  label?: string | undefined;
  role?: 'alert' | 'status' | undefined;
  /** `data-*` attributes that identify the card to tests and scripts. */
  data?: Record<`data-${string}`, string> | undefined;
}) {
  return (
    <section
      className={`chat-event tone-${tone}${attention ? ' attention' : ''}${className ? ` ${className}` : ''}`}
      aria-label={label}
      role={role}
      {...data}
    >
      <header className="chat-event-head">
        <span className="chat-event-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="chat-event-title">
          <strong>{title}</strong>
          {meta ? <small>{meta}</small> : null}
        </span>
        {badge ? <span className="chat-event-badge">{badge}</span> : null}
        {actions ? <span className="chat-event-actions">{actions}</span> : null}
      </header>
      {children ? <div className="chat-event-body">{children}</div> : null}
    </section>
  );
}
