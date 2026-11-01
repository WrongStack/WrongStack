'use client';

/**
 * One open message: who wrote it to whom, the text in readable prose, what came
 * of it, and the operator's actions.
 *
 * Mark read, Mark done and Reopen are single clicks — each is undone by
 * another. Delete is a soft delete the mailbox can undo, so it acts at once and
 * offers Restore in place instead of asking first.
 */
import { Markdown } from '@hq/components/hq/markdown';
import { mailboxActions } from '@hq/domain/mailbox-actions';
import type { FlatMessage } from '@hq/domain/mailbox-grouping';
import { CornerUpLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { cn } from '@/lib/cn';
import { asksForAction, isUnread, mailTypeLabel } from './model';

/** Identity stamped into `readBy` / `completedBy`, matching the `hq@…` sender convention. */
const HQ_ACTOR_ID = 'hq-operator';

type Action = 'mark-read' | 'acknowledge' | 'reopen' | 'soft-delete' | 'restore';

const DONE_TEXT: Record<Action, string> = {
  'mark-read': 'Marked as read.',
  acknowledge: 'Marked as done.',
  reopen: 'Reopened.',
  'soft-delete': 'Deleted — agents no longer see this message.',
  restore: 'Restored.',
};

export function MessageDetail({
  flat,
  projectName,
  deleted,
  onDeletedChange,
  onReply,
}: {
  flat: FlatMessage;
  projectName: string;
  deleted: boolean;
  onDeletedChange: (deleted: boolean) => void;
  onReply: () => void;
}): ReactNode {
  const message = flat.message;
  const [pending, setPending] = useState<Action | null>(null);
  const [result, setResult] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const when = new Date(message.timestamp);

  const run = async (action: Action): Promise<void> => {
    if (flat.projectId === undefined || pending !== null) return;
    setPending(action);
    setResult(null);
    const input = { mailId: message.mailId, readerId: HQ_ACTOR_ID, projectId: flat.projectId };
    try {
      if (action === 'mark-read') await mailboxActions.markRead(input);
      else if (action === 'acknowledge') await mailboxActions.acknowledge(input);
      else if (action === 'reopen') await mailboxActions.reopen(input);
      else if (action === 'soft-delete') await mailboxActions.softDelete(input);
      else await mailboxActions.restore(input);
      if (action === 'soft-delete') onDeletedChange(true);
      if (action === 'restore') onDeletedChange(false);
      setResult({ tone: 'ok', text: DONE_TEXT[action] });
    } catch (cause) {
      setResult({ tone: 'error', text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setPending(null);
    }
  };

  const button =
    'h-9 border border-border px-3 text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50';
  const body = message.bodyPreview?.trim() ?? '';
  const outcome = message.outcomePreview?.trim() ?? '';

  return (
    <article className="mx-auto flex max-w-3xl flex-col gap-6" aria-labelledby="mail-subject">
      <header className="flex flex-col gap-2">
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{mailTypeLabel(message.type)}</span>
          {message.priority !== 'normal' && (
            <span className={cn(message.priority === 'high' && 'font-medium text-destructive')}>
              {message.priority} priority
            </span>
          )}
          {message.audience === 'leaders' && <span>leaders only</span>}
          <span>{projectName}</span>
          {deleted ? (
            <span>deleted</span>
          ) : message.completed ? (
            <span className="text-success">
              done{message.completedBy !== undefined ? ` by ${message.completedBy}` : ''}
            </span>
          ) : (
            <span className={isUnread(message) ? 'text-primary' : undefined}>
              {isUnread(message) ? 'unread' : 'read'}
              {asksForAction(message) ? ' · waiting for an answer' : ''}
            </span>
          )}
        </p>
        <h2 id="mail-subject" className="font-display text-2xl font-semibold leading-tight">
          {message.subject.trim() || '(no subject)'}
        </h2>
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{message.from}</span> to{' '}
          <span className="font-medium text-foreground">{message.to}</span> ·{' '}
          <time dateTime={message.timestamp}>
            {Number.isNaN(when.getTime()) ? message.timestamp : when.toLocaleString()}
          </time>
        </p>
      </header>

      <section className="hq-prose">
        {body !== '' ? (
          <Markdown text={body} />
        ) : (
          <p className="text-base text-muted-foreground">
            {message.hasBody
              ? 'The body was too long to stream to HQ.'
              : 'This message has no text.'}
          </p>
        )}
      </section>

      {outcome !== '' && (
        <section className="flex flex-col gap-2 border-l-2 border-success/60 pl-4">
          <h3 className="text-sm font-semibold">Outcome</h3>
          <div className="hq-prose">
            <Markdown text={outcome} />
          </div>
        </section>
      )}

      {message.task !== undefined && (
        <p className="text-sm text-muted-foreground">
          Task <span className="font-mono text-foreground">{message.task.taskId ?? '—'}</span>
          {message.task.agentName !== undefined && ` · ${message.task.agentName}`}
          {message.task.status !== undefined && ` · ${message.task.status.replace('_', ' ')}`}
        </p>
      )}

      <div className="flex flex-col gap-3 border-t border-border pt-5">
        {flat.projectId === undefined ? (
          <p className="text-sm text-muted-foreground">
            This message came without a project, so HQ cannot route an action to its mailbox.
          </p>
        ) : deleted ? (
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={pending !== null}
              onClick={() => void run('restore')}
              className={button}
            >
              {pending === 'restore' ? 'Restoring…' : 'Restore'}
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onReply}
              className="inline-flex h-9 items-center gap-2 bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              <CornerUpLeft className="size-4" />
              Reply
            </button>
            {!message.completed && isUnread(message) && (
              <button
                type="button"
                disabled={pending !== null}
                onClick={() => void run('mark-read')}
                className={button}
              >
                {pending === 'mark-read' ? 'Marking…' : 'Mark read'}
              </button>
            )}
            {message.completed ? (
              <button
                type="button"
                disabled={pending !== null}
                onClick={() => void run('reopen')}
                className={button}
              >
                {pending === 'reopen' ? 'Reopening…' : 'Reopen'}
              </button>
            ) : (
              <button
                type="button"
                disabled={pending !== null}
                onClick={() => void run('acknowledge')}
                className={button}
              >
                {pending === 'acknowledge' ? 'Marking…' : 'Mark done'}
              </button>
            )}
            <button
              type="button"
              disabled={pending !== null}
              onClick={() => void run('soft-delete')}
              className={cn(button, 'ml-auto text-destructive hover:bg-destructive/10')}
            >
              {pending === 'soft-delete' ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        )}
        {result !== null && (
          <p
            role="status"
            className={cn('text-sm', result.tone === 'ok' ? 'text-success' : 'text-destructive')}
          >
            {result.text}
          </p>
        )}
        <p className="font-mono text-xs text-muted-foreground">
          {message.messageId}
          {message.replyTo !== undefined && ` · reply to ${message.replyTo}`}
        </p>
      </div>
    </article>
  );
}
