/**
 * One mailbox message. Shared by the grouped view and the live feed, so a
 * message reads identically wherever it is surfaced.
 *
 * Collapsed by default: the header line (type, priority, subject, route,
 * time, state) is what an operator scans; bodies are opened one at a time.
 */
import { ChevronDown, ChevronRight, Mail } from 'lucide-react';
import type * as React from 'react';
import { useState } from 'react';
import { Mono } from '../../components/hq/primitives.js';
import { Badge } from '../../components/ui/badge.js';
import type { FlatMessage } from '../../domain/mailbox-grouping.js';
import { formatMailboxTime, shortMailboxId } from '../../domain/mailbox-time.js';
import { MAILBOX_TYPE_LABEL } from '../../domain/mailbox-types.js';
import { cn } from '../../lib/utils.js';
import { MessageActions } from './message-actions.js';

/**
 * Identity stamped into `readBy` / `completedBy` for actions taken from the HQ
 * browser. Mirrors the `hq@…` sender convention of `/api/mailbox-send`, so
 * agents can tell operator activity apart from their own.
 */
const HQ_ACTOR_ID = 'hq-operator';

function MetaItem({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <span>
      <strong className="font-medium text-foreground">{label}:</strong> {children}
    </span>
  );
}

export function MessageRow({
  flat,
  defaultExpanded = false,
}: {
  flat: FlatMessage;
  defaultExpanded?: boolean;
}): React.ReactElement {
  const [open, setOpen] = useState(defaultExpanded);
  const message = flat.message;
  const hasBody =
    message.hasBody || (message.bodyPreview !== undefined && message.bodyPreview.length > 0);
  const typeMeta = MAILBOX_TYPE_LABEL[message.type] ?? { icon: Mail, tone: 'info' as const };
  const TypeIcon = typeMeta.icon;

  return (
    <div
      data-testid="message-row"
      data-completed={message.completed}
      className={cn('border border-border bg-card', message.completed && 'opacity-70')}
    >
      <div className="flex flex-wrap items-center gap-1.5 px-2 py-1.5 text-xs">
        <TypeIcon className="size-3.5 shrink-0 text-muted-foreground" aria-label={message.type} />
        <Badge tone={typeMeta.tone}>{message.type}</Badge>
        {message.audience === 'leaders' && <Badge tone="info">leaders only</Badge>}
        {message.priority === 'high' && <Badge tone="error">high</Badge>}
        {message.priority === 'low' && <Badge tone="idle">low</Badge>}

        <span className="min-w-0 flex-1 truncate font-medium" title={message.subject}>
          {message.subject || '(no subject)'}
        </span>

        <Mono className="shrink-0">
          {message.from} → {message.to}
        </Mono>
        <Mono className="tabular shrink-0" title={message.timestamp}>
          {formatMailboxTime(message.timestamp)}
        </Mono>
        <Mono className="shrink-0">{shortMailboxId(message.messageId)}</Mono>

        <span
          className={cn(
            'shrink-0 text-[10px] uppercase tracking-[0.08em]',
            message.completed ? 'text-success' : 'text-warning',
          )}
        >
          {message.completed
            ? `completed${message.completedBy !== undefined ? ` by ${message.completedBy}` : ''}`
            : 'open'}
        </span>

        {hasBody && (
          <button
            type="button"
            onClick={() => setOpen((current) => !current)}
            aria-expanded={open}
            aria-label={open ? 'Collapse body' : 'Expand body'}
            className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
          >
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
        )}
      </div>

      {open && (
        <div className="space-y-2 border-t border-border p-2">
          {message.bodyPreview !== undefined && message.bodyPreview.length > 0 ? (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words border border-border bg-muted/30 p-2 font-mono text-[11px] leading-relaxed">
              {message.bodyPreview}
            </pre>
          ) : (
            <p className="text-[11px] text-muted-foreground">(empty body)</p>
          )}

          {message.outcomePreview !== undefined && message.outcomePreview.length > 0 && (
            <div className="space-y-1">
              <span className="text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
                outcome
              </span>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words border border-border bg-muted/30 p-2 font-mono text-[11px] leading-relaxed">
                {message.outcomePreview}
              </pre>
            </div>
          )}

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
            <MetaItem label="source">{flat.source}</MetaItem>
            {message.replyTo !== undefined && (
              <MetaItem label="reply to">{shortMailboxId(message.replyTo)}</MetaItem>
            )}
            {message.senderSessionId !== undefined && (
              <MetaItem label="sender session">{shortMailboxId(message.senderSessionId)}</MetaItem>
            )}
            {(message.readCount ?? 0) > 0 && <MetaItem label="reads">{message.readCount}</MetaItem>}
            {message.unreadCount !== undefined && message.unreadCount > 0 && (
              <MetaItem label="unread">{message.unreadCount}</MetaItem>
            )}
            {message.task !== undefined && (
              <MetaItem label="task">
                {message.task.taskId ?? '—'}
                {message.task.agentName !== undefined ? ` · ${message.task.agentName}` : ''}
                {message.task.status !== undefined ? ` (${message.task.status})` : ''}
              </MetaItem>
            )}
          </div>

          {flat.projectId !== undefined && (
            <MessageActions
              mailId={message.mailId}
              actorId={HQ_ACTOR_ID}
              projectId={flat.projectId}
            />
          )}
        </div>
      )}
    </div>
  );
}
