import { CheckCheck, Inbox, MailOpen, RotateCcw } from 'lucide-react';
import type * as React from 'react';
import { useMemo, useState } from 'react';
import { EmptyState } from '../components/hq/primitives.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Switch } from '../components/ui/switch.js';
import { useHqStore } from '../data/store/index.js';
import { mailboxActions } from '../domain/mailbox-actions.js';
import { type FlatMessage, groupMailboxEvents } from '../domain/mailbox-grouping.js';
import { formatMailboxTime } from '../domain/mailbox-time.js';
import { MAILBOX_TYPE_LABEL } from '../domain/mailbox-types.js';
import { useBackfilledEvents } from '../domain/use-backfilled-events.js';

const MOBILE_MAILBOX_BACKFILL = 300;
const HQ_MOBILE_ACTOR = 'hq-mobile-operator';

function MobileMessage({ flat }: { flat: FlatMessage }): React.ReactElement {
  const message = flat.message;
  const [completed, setCompleted] = useState(message.completed);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const meta = MAILBOX_TYPE_LABEL[message.type];
  const Icon = meta.icon;
  const input = { mailId: message.mailId, readerId: HQ_MOBILE_ACTOR, projectId: flat.projectId };

  const run = async (label: string, action: () => Promise<unknown>): Promise<void> => {
    if (pending !== null || flat.projectId === undefined) return;
    setPending(label);
    setError(null);
    try {
      await action();
      if (label === 'acknowledge') setCompleted(true);
      if (label === 'reopen') setCompleted(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  };

  return (
    <article
      data-testid="mobile-mailbox-message"
      data-completed={completed}
      className="space-y-2 border border-border bg-card p-3"
    >
      <div className="flex items-center gap-1.5">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <Badge tone={meta.tone}>{message.type}</Badge>
        {message.priority === 'high' && <Badge tone="error">high</Badge>}
        {completed && <Badge tone="active">done</Badge>}
        <span className="ml-auto text-[10px] text-muted-foreground">
          {formatMailboxTime(message.timestamp)}
        </span>
      </div>
      <div>
        <h3 className="text-sm font-medium">{message.subject || '(no subject)'}</h3>
        <p className="text-[11px] text-muted-foreground">
          {message.from} → {message.to}
        </p>
      </div>
      {message.bodyPreview !== undefined && message.bodyPreview.length > 0 && (
        <p className="whitespace-pre-wrap break-words border-l-2 border-border pl-2 text-xs leading-relaxed">
          {message.bodyPreview}
        </p>
      )}
      {flat.projectId !== undefined && (
        <div className="flex flex-wrap gap-1.5">
          <Button
            variant="outline"
            size="sm"
            disabled={pending !== null}
            onClick={() => void run('mark-read', () => mailboxActions.markRead(input))}
          >
            <MailOpen />
            {pending === 'mark-read' ? '…' : 'Read'}
          </Button>
          {completed ? (
            <Button
              variant="outline"
              size="sm"
              disabled={pending !== null}
              onClick={() => void run('reopen', () => mailboxActions.reopen(input))}
            >
              <RotateCcw />
              {pending === 'reopen' ? '…' : 'Reopen'}
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={pending !== null}
              onClick={() => void run('acknowledge', () => mailboxActions.acknowledge(input))}
            >
              <CheckCheck />
              {pending === 'acknowledge' ? '…' : 'Acknowledge'}
            </Button>
          )}
        </div>
      )}
      {error !== null && <p className="text-[11px] text-destructive">{error}</p>}
    </article>
  );
}

export function MobileInbox(): React.ReactElement {
  const snapshot = useHqStore((state) => state.snapshot);
  const { events, loading } = useBackfilledEvents('mailbox.event', MOBILE_MAILBOX_BACKFILL);
  const [includeCompleted, setIncludeCompleted] = useState(false);
  const grouping = useMemo(() => groupMailboxEvents(snapshot, events), [events, snapshot]);
  const messages = useMemo(
    () =>
      grouping.projects
        .flatMap((project) => project.messages)
        .filter((flat) => includeCompleted || !flat.message.completed)
        .sort((left, right) => {
          const priority =
            Number(right.message.priority === 'high') - Number(left.message.priority === 'high');
          return priority || right.message.timestamp.localeCompare(left.message.timestamp);
        }),
    [grouping.projects, includeCompleted],
  );

  return (
    <section data-testid="mobile-inbox" className="min-h-0 flex-1 overflow-y-auto p-3">
      <div className="mb-3 flex items-center gap-2">
        <div>
          <h2 className="font-display text-base font-semibold">Coordination inbox</h2>
          <p className="text-[11px] text-muted-foreground">
            {snapshot?.totals.unreadMailboxMessages ?? 0} unread ·{' '}
            {snapshot?.totals.incompleteMailboxMessages ?? 0} incomplete
          </p>
        </div>
        <label
          htmlFor="mobile-inbox-completed"
          className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground"
        >
          completed
          <Switch
            id="mobile-inbox-completed"
            checked={includeCompleted}
            onCheckedChange={setIncludeCompleted}
          />
        </label>
      </div>
      {loading && messages.length === 0 ? (
        <p className="text-xs text-muted-foreground">Loading mailbox history…</p>
      ) : messages.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="Inbox clear"
          hint="New cross-project coordination messages appear here."
        />
      ) : (
        <div className="space-y-2">
          {messages.map((flat) => (
            <MobileMessage key={flat.message.mailId} flat={flat} />
          ))}
        </div>
      )}
    </section>
  );
}
