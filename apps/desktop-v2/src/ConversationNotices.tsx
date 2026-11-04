import { AlertTriangle, Info, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ConversationNotice } from './conversation-notices';

/** How long a passing notice stays before it closes by itself. */
const TRANSIENT_NOTICE_MS = 8000;

/** Engine reports about this conversation, shown above the composer until dismissed. */
export function ConversationNotices({
  notices,
  onAction,
}: {
  notices: ConversationNotice[];
  /** Makes a notice's engine request; the notice closes once it succeeds. */
  onAction?: ((action: NonNullable<ConversationNotice['action']>) => Promise<void>) | undefined;
}) {
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [busy, setBusy] = useState('');
  // A passing notice closes by itself, as a WebUI toast does.
  useEffect(() => {
    const timers = notices
      .filter((notice) => notice.transient && !dismissed.includes(notice.id))
      .map((notice) =>
        window.setTimeout(
          () => setDismissed((ids) => (ids.includes(notice.id) ? ids : [...ids, notice.id])),
          Math.max(0, notice.at + TRANSIENT_NOTICE_MS - Date.now()),
        ),
      );
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [notices, dismissed]);
  const shown = notices.filter((notice) => !dismissed.includes(notice.id));
  if (!shown.length) return null;
  return (
    <section className="conversation-notices" aria-label="Conversation notices">
      {shown.map((notice) => (
        <div
          key={notice.id}
          className={`conversation-notice ${notice.severity}`}
          role={notice.severity === 'error' ? 'alert' : 'status'}
        >
          {notice.severity === 'info' ? <Info size={14} /> : <AlertTriangle size={14} />}
          <p>
            {notice.text}
            {notice.hint && <small> {notice.hint}</small>}
          </p>
          {notice.action && onAction && (
            <button
              type="button"
              className="button secondary small"
              disabled={busy === notice.id}
              onClick={() => {
                const action = notice.action!;
                setBusy(notice.id);
                void onAction(action)
                  .then(() => setDismissed((ids) => [...ids, notice.id]))
                  .catch(() => {})
                  .finally(() => setBusy(''));
              }}
            >
              {notice.action.label}
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            aria-label="Dismiss notice"
            onClick={() => setDismissed((ids) => [...ids, notice.id])}
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </section>
  );
}
