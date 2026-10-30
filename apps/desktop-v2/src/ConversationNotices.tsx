import { AlertTriangle, Info, X } from 'lucide-react';
import { useState } from 'react';
import type { ConversationNotice } from './conversation-notices';

/** Engine reports about this conversation, shown above the composer until dismissed. */
export function ConversationNotices({ notices }: { notices: ConversationNotice[] }) {
  const [dismissed, setDismissed] = useState<string[]>([]);
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
