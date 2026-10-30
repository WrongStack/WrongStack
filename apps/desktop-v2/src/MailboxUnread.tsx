import { useEffect, useRef, useState } from 'react';
import type { EngineCommand } from './engine-operations';
import { entries } from './engine-values';
import { unreadMail } from './mailbox-model';

/** Messages read for the badge; more than this shows as "100+". */
export const MAILBOX_UNREAD_PAGE = 100;

const stamp = (mail: Record<string, unknown>) =>
  typeof mail['timestamp'] === 'number'
    ? mail['timestamp']
    : Date.parse(String(mail['timestamp'])) || 0;

/** Count and newest of the messages nobody has read yet (the mailbox's aggregate view). */
export function mailboxUnreadSummary(messages: readonly Record<string, unknown>[]): {
  count: string;
  latest: { from: string; subject: string } | null;
} {
  const unread = messages.filter(unreadMail);
  const newest = unread.reduce<Record<string, unknown> | null>(
    (best, mail) => (!best || stamp(mail) > stamp(best) ? mail : best),
    null,
  );
  return {
    count:
      messages.length >= MAILBOX_UNREAD_PAGE && unread.length === messages.length
        ? `${MAILBOX_UNREAD_PAGE}+`
        : String(unread.length),
    latest: newest
      ? {
          from: String(newest['from'] ?? 'unknown sender'),
          subject: String(newest['subject'] ?? '').trim() || '(no subject)',
        }
      : null,
  };
}

/**
 * Unread mail on the project overview: read once, then again shortly after a mailbox event
 * arrives. "Unread" means nobody has read the message yet; it does not prove a worker acted.
 */
export function MailboxUnread({
  command,
  trigger,
}: {
  command: EngineCommand;
  /** Changes whenever the engine reports mailbox activity. */
  trigger: unknown;
}) {
  const [summary, setSummary] = useState<ReturnType<typeof mailboxUnreadSummary> | null>(null);
  const sequence = useRef(0);
  useEffect(() => {
    void trigger;
    const seq = ++sequence.current;
    const timer = setTimeout(() => {
      void command('mailbox.messages', { limit: MAILBOX_UNREAD_PAGE, unreadOnly: true }, [
        'mailbox.messages',
      ])
        .then((reply) => {
          if (seq === sequence.current)
            setSummary(mailboxUnreadSummary(entries(reply['messages'])));
        })
        // The overview stays usable without the badge; the Mailbox page reports errors.
        .catch(() => {
          if (seq === sequence.current) setSummary(null);
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [command, trigger]);
  if (!summary || summary.count === '0') return null;
  return (
    <span className="mailbox-unread" role="status">
      <strong>{summary.count} unread</strong>
      {summary.latest && (
        <>
          {' '}
          · newest from {summary.latest.from}: {summary.latest.subject}
        </>
      )}
    </span>
  );
}
