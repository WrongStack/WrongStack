/** Shared mailbox message row used by grouped and live mailbox views. */
import type React from 'react';
import { useState } from 'react';
import { Mail } from 'lucide-react';
import { MessageActions } from './mailbox-actions.js';
import type { FlatMessage } from './mailbox-grouping.js';
import { formatMailboxTime, shortMailboxId } from './mailbox-time.js';
import { MAILBOX_TYPE_LABEL } from './mailbox-types.js';

/**
 * Identity stamped into `readBy` / `completedBy` for operator actions taken
 * from the HQ browser. Mirrors the `hq@…` sender convention of
 * /api/mailbox-send so agents can tell HQ operator activity apart.
 */
const HQ_ACTOR_ID = 'hq-operator';

export interface MessageRowProps {
  flat: FlatMessage;
  /** Open the body on first render (default: collapsed). */
  defaultExpanded?: boolean | undefined;
}

export function MessageRow({ flat, defaultExpanded }: MessageRowProps): React.ReactElement {
  const [open, setOpen] = useState(Boolean(defaultExpanded));
  const m = flat.message;
  const hasBody = m.hasBody || (m.bodyPreview !== undefined && m.bodyPreview.length > 0);
  const typeMeta = MAILBOX_TYPE_LABEL[m.type] ?? { icon: Mail, tone: 'info' as const };
  const TypeIcon = typeMeta.icon;
  const fromTo = `${m.from} → ${m.to}`;

  return (
    <div className={'hq-msg' + (m.completed ? ' done' : '')}>
      <div className="hq-msg-head">
        <span className="hq-msg-icon" title={m.type}>
          <TypeIcon size={13} />
        </span>
        <span className={'hq-pill ' + typeMeta.tone}>{m.type}</span>
        {m.priority === 'high' && <span className="hq-pill error">high</span>}
        {m.priority === 'low' && <span className="hq-pill idle">low</span>}
        <span className="hq-msg-subject" title={m.subject}>
          {m.subject || '(no subject)'}
        </span>
        <span className="hq-mono hq-msg-route">{fromTo}</span>
        <span className="hq-mono hq-msg-time" title={m.timestamp}>
          {formatMailboxTime(m.timestamp)}
        </span>
        <span className="hq-mono hq-msg-id">{shortMailboxId(m.messageId)}</span>
        <span className={'hq-msg-flag ' + (m.completed ? 'done' : 'open')}>
          {m.completed
            ? `completed${m.completedBy !== undefined ? ` by ${m.completedBy}` : ''}`
            : 'open'}
        </span>
        {hasBody && (
          <button
            type="button"
            className="hq-toggle hq-msg-toggle"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={open ? 'Collapse body' : 'Expand body'}
          >
            {open ? '▾' : '▸'}
          </button>
        )}
      </div>
      {open && (
        <div className="hq-msg-body">
          {m.bodyPreview !== undefined && m.bodyPreview.length > 0 ? (
            <pre className="hq-msg-pre">{m.bodyPreview}</pre>
          ) : (
            <div className="hq-empty hq-pad-sm">
              (empty body)
            </div>
          )}
          {m.outcomePreview !== undefined && m.outcomePreview.length > 0 && (
            <>
              <div className="hq-msg-sublabel">outcome</div>
              <pre className="hq-msg-pre">{m.outcomePreview}</pre>
            </>
          )}
          <div className="hq-msg-meta">
            <span>
              <strong>source:</strong> {flat.source}
            </span>
            {m.replyTo !== undefined && (
              <span>
                <strong>reply to:</strong> {shortMailboxId(m.replyTo)}
              </span>
            )}
            {m.senderSessionId !== undefined && (
              <span>
                <strong>sender session:</strong> {shortMailboxId(m.senderSessionId)}
              </span>
            )}
            {(m.readCount ?? 0) > 0 && (
              <span>
                <strong>reads:</strong> {m.readCount}
              </span>
            )}
            {m.unreadCount !== undefined && m.unreadCount > 0 && (
              <span>
                <strong>unread:</strong> {m.unreadCount}
              </span>
            )}
            {m.task !== undefined && (
              <span>
                <strong>task:</strong> {m.task.taskId ?? '—'}
                {m.task.agentName !== undefined ? ` · ${m.task.agentName}` : ''}
                {m.task.status !== undefined ? ` (${m.task.status})` : ''}
              </span>
            )}
          </div>
          {flat.projectId !== undefined && (
            <MessageActions mailId={m.mailId} actorId={HQ_ACTOR_ID} projectId={flat.projectId} />
          )}
        </div>
      )}
    </div>
  );
}
