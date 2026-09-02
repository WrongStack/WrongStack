/**
 * Per-message actions — mark read, acknowledge, reopen, soft-delete, restore.
 *
 * The visibility rules mirror the server's, so the operator never sees a
 * button that would 4xx. The server remains the source of truth for what has
 * already been done: repeating an action is a no-op there, which is why these
 * buttons do not try to track per-recipient state the wire format omits.
 */
import type * as React from 'react';
import { useState } from 'react';
import { Button } from '../../components/ui/button.js';
import { mailboxActions } from '../../domain/mailbox-actions.js';

export function MessageActions({
  mailId,
  actorId,
  projectId,
  isDeleted = false,
  onAction,
  disabled = false,
}: {
  /**
   * Mail id only — deliberately not a `FlatMessage`. The HQ summary is a wire
   * format that omits per-recipient `readBy` and soft-delete metadata, so the
   * real rules live server-side and the client only needs the id.
   */
  mailId: string;
  actorId: string;
  /** The server's routing key for resolving the project mailbox. */
  projectId: string;
  isDeleted?: boolean;
  onAction?: (mailId: string, action: string) => void;
  disabled?: boolean;
}): React.ReactElement {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (label: string, action: () => Promise<unknown>): Promise<void> => {
    if (disabled || pending !== null) return;
    setPending(label);
    setError(null);
    try {
      await action();
      onAction?.(mailId, label);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  };

  const input = { mailId, readerId: actorId, projectId };
  const busy = disabled || pending !== null;

  return (
    <div data-testid="message-actions" className="flex flex-wrap items-center gap-1.5">
      {isDeleted ? (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void run('restore', () => mailboxActions.restore(input))}
        >
          {pending === 'restore' ? '…' : 'Restore'}
        </Button>
      ) : (
        <>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void run('mark-read', () => mailboxActions.markRead(input))}
          >
            {pending === 'mark-read' ? '…' : 'Mark read'}
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void run('acknowledge', () => mailboxActions.acknowledge(input))}
          >
            {pending === 'acknowledge' ? '…' : 'Acknowledge'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void run('reopen', () => mailboxActions.reopen(input))}
          >
            {pending === 'reopen' ? '…' : 'Reopen'}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={busy}
            onClick={() => void run('soft-delete', () => mailboxActions.softDelete(input))}
          >
            {pending === 'soft-delete' ? '…' : 'Delete'}
          </Button>
        </>
      )}
      {error !== null && (
        <span title={error} className="truncate text-[11px] text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}
