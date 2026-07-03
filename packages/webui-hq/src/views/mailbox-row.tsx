/**
 * Shared message row component (skeleton).
 *
 * Phase 2 skeleton: a placeholder that accepts the same `flat`
 * prop the current `MessageRow` in `mailbox.tsx` takes, so the
 * view-mode toggle in Phase 5 can swap the two views without
 * changing the row markup. The full row render (icon + subject +
 * from→to + body preview + meta line) lands in Phase 4 — for now
 * the component just renders the subject so the build is green
 * and the integration site is obvious.
 *
 * Keeping the row as its own file means the grouped view and the
 * live view share the exact same message markup, so a tweak to
 * how (e.g.) a "high priority" indicator is shown applies to both
 * at once.
 */
import type React from 'react';
import { useState } from 'react';
import type { FlatMessage } from './mailbox-grouping.js';
import { formatMailboxTime, shortMailboxId } from './mailbox-time.js';
import { MAILBOX_TYPE_LABEL } from './mailbox-types.js';

export interface MessageRowProps {
  flat: FlatMessage;
  /** Open the body on first render (default: collapsed). */
  defaultExpanded?: boolean | undefined;
}

export function MessageRow({ flat, defaultExpanded }: MessageRowProps): React.ReactElement {
  const [open, setOpen] = useState(Boolean(defaultExpanded));
  const m = flat.message;
  const typeMeta = MAILBOX_TYPE_LABEL[m.type] ?? { icon: '✉️', tone: 'info' };

  // Skeleton render — the real row (subject + from→to + body + meta) is
  // added in Phase 4. For now we render a minimal placeholder so the
  // build is green and Phase 5 (view-mode toggle) has something to
  // call.
  return (
    <div className="hq-msg" onClick={() => setOpen((v) => !v)}>
      <span className="hq-msg-icon" title={m.type}>
        {typeMeta.icon}
      </span>
      <span className="hq-pill">{m.type}</span>
      <span className="hq-msg-subject">{m.subject || '(no subject)'}</span>
      <span className="hq-mono hq-msg-time">{formatMailboxTime(m.timestamp)}</span>
      <span className="hq-mono hq-msg-id">{shortMailboxId(m.messageId)}</span>
      {open ? <div className="hq-msg-body">{m.bodyPreview ?? '(no body)'}</div> : null}
    </div>
  );
}
