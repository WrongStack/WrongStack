'use client';

/**
 * Console — read a live conversation and talk back to it.
 *
 * Left: every open session and its agents. Centre: the transcript, pinned to
 * the newest turn unless the operator scrolls up. Bottom: the composer, whose
 * three delivery modes say plainly what they do. Interrupting is a separate,
 * confirmed action in the header — never one keystroke away from Send.
 *
 * The selected conversation is mirrored into the URL (`?session=&agent=`) so
 * it survives a reload and can be linked.
 */
import { TranscriptExpansionProvider } from '@hq/components/hq/transcript/expansion';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@hq/components/ui/alert-dialog';
import { useHqStore } from '@hq/data/store/index';
import { resolveConsoleControlTarget } from '@hq/domain/console-target';
import { turnKey, useSessionTranscript } from '@hq/domain/use-session-transcript';
import { formatClock, formatUsd } from '@hq/lib/format';
import type { HqCommandAuditEntry } from '@wrongstack/hq';
import { ArrowDown, History, ListTree, MessageSquareText, OctagonX, Send, X } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { VList } from 'virtua';
import { useShallow } from 'zustand/react/shallow';
import { agentNameMap } from '@/features/transcript/model';
import { TranscriptTurn } from '@/features/transcript/turn';
import { cn } from '@/lib/cn';
import { useScopedSnapshot } from '@/lib/use-scope';
import { AcpSessionSettings } from './acp-session-settings';
import { type AgentFacts, agentFacts } from './model';
import { SessionNavigator } from './session-navigator';
import {
  type ChannelState,
  type CommandReceipt,
  type DeliveryMode,
  useConsoleControl,
} from './use-console-control';

const DELIVERY: { mode: DeliveryMode; label: string; hint: string }[] = [
  { mode: 'steer', label: 'Steer now', hint: 'Redirects the run at its next safe turn.' },
  { mode: 'btw', label: 'Add context', hint: 'Shared as background; the run keeps going.' },
  { mode: 'queue', label: 'Queue next', hint: 'Waits until the current task finishes.' },
];

const CHANNEL: Record<ChannelState, { label: string; tone: string; explain: string }> = {
  live: { label: 'Control live', tone: 'text-success', explain: '' },
  mailbox: {
    label: 'Mailbox only',
    tone: 'text-warning',
    explain: 'This client takes no live commands; messages go through its project mailbox.',
  },
  'read-only': {
    label: 'Read only',
    tone: 'text-muted-foreground',
    explain: 'This client publishes its transcript but accepts no commands or mail.',
  },
  none: { label: '', tone: '', explain: '' },
};

/** Keep `?session=&agent=` and the store selection in step, both directions. */
function useSelectionInUrl(sessionId: string | null, agentId: string | null): void {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const hydrated = useRef(false);

  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    const session = params.get('session');
    if (session === null) return;
    const agent = params.get('agent');
    if (agent === null) useHqStore.getState().selectSession(session);
    else useHqStore.getState().selectAgent(session, agent);
  }, [params]);

  useEffect(() => {
    if (!hydrated.current) return;
    const next = new URLSearchParams();
    if (sessionId !== null) next.set('session', sessionId);
    if (sessionId !== null && agentId !== null) next.set('agent', agentId);
    const query = next.toString();
    if (query === params.toString()) return;
    router.replace(query.length > 0 ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [sessionId, agentId, params, pathname, router]);
}

export function ConsoleView(): ReactNode {
  const { sessionId, agentId, snapshot, commandStatuses } = useHqStore(
    useShallow((state) => ({
      sessionId: state.selectedSessionId,
      agentId: state.selectedAgentId,
      snapshot: state.snapshot,
      commandStatuses: state.commandStatuses,
    })),
  );
  useSelectionInUrl(sessionId, agentId);
  // The picker lists the scope; a session opened by link resolves fleet-wide.
  const scopedSnapshot = useScopedSnapshot();

  const chat = useSessionTranscript(sessionId, agentId);
  const target = useMemo(
    () => resolveConsoleControlTarget(snapshot, sessionId, agentId),
    [snapshot, sessionId, agentId],
  );
  const control = useConsoleControl(target, chat.entries);
  const acpLeader = target?.session.agents.find((agent) => agent.id === 'leader');
  const agentNames = useMemo(() => agentNameMap(target?.session.agents), [target?.session.agents]);
  const [interruptOpen, setInterruptOpen] = useState(false);
  const [includeSubagents, setIncludeSubagents] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  // A dialog opened for one conversation must not survive into the next.
  useEffect(() => {
    setInterruptOpen(false);
    setIncludeSubagents(false);
    setPickerOpen(false);
  }, [sessionId, agentId]);

  const rowCount = chat.entries.length + control.visibleReceipts.length;
  useEffect(() => {
    if (!chat.pinned || control.visibleReceipts.length === 0) return;
    const frame = window.requestAnimationFrame(() =>
      chat.listRef.current?.scrollToIndex(rowCount - 1, { align: 'end' }),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [chat.listRef, chat.pinned, rowCount, control.visibleReceipts.length]);

  const title =
    sessionId === null
      ? 'Choose a conversation'
      : agentId !== null
        ? (target?.agent?.name ?? agentId)
        : (chat.meta.projectName ?? target?.session.projectName ?? control.targetLabel);
  const channel = CHANNEL[control.channel];
  const session = target?.session;
  const version = target?.client?.version ?? session?.clientVersion;
  const facts = agentFacts(session, target?.agent, agentId);

  return (
    <div className="grid h-full min-h-0 lg:grid-cols-[300px_minmax(0,1fr)]">
      <aside className="hidden min-h-0 border-r border-border bg-card lg:block">
        <SessionNavigator
          snapshot={scopedSnapshot}
          selectedSessionId={sessionId}
          selectedAgentId={agentId}
        />
      </aside>

      <section className="flex min-h-0 min-w-0 flex-col">
        <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-border px-6 py-4">
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="inline-flex h-9 items-center gap-2 border border-border px-3 text-sm hover:bg-muted lg:hidden"
          >
            <ListTree className="size-4" />
            Conversations
          </button>
          <div className="min-w-0 flex-1 max-sm:order-first max-sm:basis-full">
            <h2 className="truncate font-display text-xl font-semibold tracking-tight">{title}</h2>
            {session !== undefined && (
              <p className="mt-0.5 text-sm text-muted-foreground sm:truncate">
                {agentId !== null && `${session.projectName} · `}
                {session.hostname ?? session.machineId} · {session.clientKind.toUpperCase()}
                {version !== undefined && ` v${version.replace(/^v/, '')}`}
                {session.gitBranch !== undefined && ` · ${session.gitBranch}`}
                {channel.label.length > 0 && (
                  <>
                    {' · '}
                    <span className={channel.tone}>{channel.label}</span>
                  </>
                )}
              </p>
            )}
            {facts !== null && <AgentFactsLine facts={facts} />}
            {agentId === null &&
              acpLeader?.provider === 'acp' &&
              acpLeader.model &&
              target?.client && (
                <AcpSessionSettings
                  key={`${target.client.clientId}/${target.session.sessionId}/${acpLeader.model}`}
                  clientId={target.client.clientId}
                  sessionId={target.session.sessionId}
                  agentId={acpLeader.model}
                  connected={target.client.connected}
                  supported={target.client.capabilities.includes('acp.config')}
                />
              )}
          </div>
          {sessionId !== null && (
            <dl className="flex gap-5 text-sm">
              <Stat label="Turns" value={rowCount} />
              <Stat label="Tools" value={chat.stats.tools} />
              <Stat
                label="Running"
                value={chat.stats.running}
                tone={chat.stats.running > 0 ? 'text-success' : undefined}
              />
              <Stat
                label="Errors"
                value={chat.stats.errors}
                tone={chat.stats.errors > 0 ? 'text-destructive' : undefined}
              />
            </dl>
          )}
          {agentId === null && !chat.full && chat.meta.total > chat.entries.length && (
            <button
              type="button"
              onClick={() => chat.setFull(true)}
              className="inline-flex h-9 items-center gap-2 border border-border px-3 text-sm hover:bg-muted"
            >
              <History className="size-4" />
              Load all {chat.meta.total} turns
            </button>
          )}
          {control.channel === 'live' && (
            <button
              type="button"
              disabled={control.busy}
              onClick={() => {
                setIncludeSubagents(false);
                setInterruptOpen(true);
              }}
              className="inline-flex h-9 items-center gap-2 border border-destructive/50 px-3 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-50"
            >
              <OctagonX className="size-4" />
              Interrupt
            </button>
          )}
        </header>

        <div className="relative min-h-0 flex-1">
          {sessionId === null ? (
            <Placeholder
              title="Pick a conversation"
              hint="Choose a session or one of its agents on the left to read its transcript and talk to it."
            />
          ) : chat.loading && rowCount === 0 ? (
            <Placeholder
              title={agentId !== null ? 'Loading agent history…' : 'Loading transcript…'}
            />
          ) : chat.error !== null ? (
            <Placeholder title="The transcript could not be loaded" hint={chat.error} />
          ) : rowCount === 0 ? (
            <Placeholder title="Nothing has been said in this conversation yet" />
          ) : (
            <TranscriptExpansionProvider>
              <VList
                ref={chat.listRef}
                onScroll={chat.onScroll}
                className="hq-transcript h-full px-6 py-4"
                data-testid="transcript-list"
              >
                {chat.entries.map((entry, index) => (
                  <div key={turnKey(entry, index)} className="mx-auto max-w-3xl">
                    <TranscriptTurn
                      entry={entry}
                      running={chat.isRunningAt(entry, index)}
                      turnKey={turnKey(entry, index)}
                      agentNames={agentNames}
                    />
                  </div>
                ))}
                {control.visibleReceipts.map((receipt) => (
                  <div
                    key={`receipt:${receipt.commandId}`}
                    className="mx-auto max-w-3xl py-2"
                    aria-live="polite"
                  >
                    <Receipt
                      receipt={receipt}
                      command={commandStatuses.find((c) => c.commandId === receipt.commandId)}
                    />
                  </div>
                ))}
              </VList>
            </TranscriptExpansionProvider>
          )}
          {sessionId !== null && rowCount > 0 && !chat.pinned && (
            <button
              type="button"
              onClick={() => {
                chat.jumpToLatest();
                window.requestAnimationFrame(() =>
                  chat.listRef.current?.scrollToIndex(rowCount - 1, { align: 'end' }),
                );
              }}
              className="absolute bottom-4 right-6 inline-flex h-9 items-center gap-2 bg-foreground px-3 text-sm text-background shadow-lg"
            >
              <ArrowDown className="size-4" />
              Latest
            </button>
          )}
        </div>

        {sessionId !== null && <Composer control={control} />}
      </section>

      {pickerOpen && (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <div className="flex h-full w-[min(340px,90vw)] flex-col border-r border-border bg-card shadow-xl">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <span className="text-sm font-semibold">Conversations</span>
              <button
                type="button"
                onClick={() => setPickerOpen(false)}
                aria-label="Close conversations"
                className="grid size-8 place-items-center text-muted-foreground hover:bg-muted"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <SessionNavigator
                snapshot={scopedSnapshot}
                selectedSessionId={sessionId}
                selectedAgentId={agentId}
              />
            </div>
          </div>
          <button
            type="button"
            tabIndex={-1}
            aria-label="Close conversations"
            onClick={() => setPickerOpen(false)}
            className="flex-1 bg-background/70"
          />
        </div>
      )}

      <AlertDialog open={interruptOpen} onOpenChange={setInterruptOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Interrupt {control.targetLabel}?</AlertDialogTitle>
            <AlertDialogDescription>
              The current run stops at its next cancellation boundary. Work already written stays
              written.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {control.isLeader && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={includeSubagents}
                onChange={(event) => setIncludeSubagents(event.target.checked)}
              />
              Also interrupt every subagent on this client
            </label>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={control.busy}
              onClick={() => {
                void control.interrupt(includeSubagents).then((sent) => {
                  if (sent) setInterruptOpen(false);
                });
              }}
            >
              <OctagonX />
              Confirm interrupt
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

const CONTEXT_TONE: Record<AgentFacts['contextTone'], { text: string; bar: string }> = {
  ok: { text: 'text-muted-foreground', bar: 'bg-primary' },
  warn: { text: 'text-warning', bar: 'bg-warning' },
  bad: { text: 'text-destructive', bar: 'bg-destructive' },
};

function AgentFactsLine({ facts }: { facts: AgentFacts }): ReactNode {
  const tone = CONTEXT_TONE[facts.contextTone];
  const rest = [
    facts.tokens,
    facts.costUsd !== undefined ? formatUsd(facts.costUsd) : undefined,
  ].filter((part): part is string => part !== undefined);
  return (
    <p
      data-testid="agent-facts"
      className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
    >
      {facts.model !== undefined && <span className="font-mono">{facts.model}</span>}
      {facts.contextPct !== undefined && (
        <span className={cn('inline-flex items-center gap-1.5', tone.text)}>
          <span aria-hidden className="inline-block h-1.5 w-12 bg-muted">
            <span
              className={cn('block h-full', tone.bar)}
              style={{ width: `${facts.contextPct}%` }}
            />
          </span>
          Context {facts.contextPct}%
        </span>
      )}
      {rest.length > 0 && <span className="tabular">{rest.join(' · ')}</span>}
    </p>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: string | undefined;
}): ReactNode {
  return (
    <div className="flex flex-col items-end leading-tight">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn('tabular font-display text-base font-semibold', tone)}>{value}</dd>
    </div>
  );
}

function Placeholder({ title, hint }: { title: string; hint?: string }): ReactNode {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <MessageSquareText className="size-6 text-muted-foreground/60" />
      <p className="text-base font-medium">{title}</p>
      {hint !== undefined && <p className="max-w-md text-sm text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Receipt({
  receipt,
  command,
}: {
  receipt: CommandReceipt;
  command: HqCommandAuditEntry | undefined;
}): ReactNode {
  const lifecycle = command?.ackStatus ?? command?.status ?? 'queued';
  const failed = lifecycle === 'failed' || lifecycle === 'rejected';
  if (receipt.type === 'abort') {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <OctagonX className="size-4 text-destructive" />
        {receipt.preview}
        <span className={cn(failed && 'text-destructive')}>· {lifecycle}</span>
        <span className="tabular text-xs">{formatClock(receipt.createdAt)}</span>
      </p>
    );
  }
  return (
    <div className="ml-auto max-w-[85%] border border-primary/35 bg-primary/10 px-4 py-2.5">
      <p className="text-xs text-muted-foreground">
        You → {receipt.target} · {receipt.type} ·{' '}
        <span className={cn(failed ? 'text-destructive' : 'text-foreground')}>{lifecycle}</span> ·{' '}
        {formatClock(receipt.createdAt)}
      </p>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed">
        {receipt.preview}
      </p>
    </div>
  );
}

function Composer({ control }: { control: ReturnType<typeof useConsoleControl> }): ReactNode {
  const [subjectOpen, setSubjectOpen] = useState(control.subject.length > 0);
  const canSend = control.channel === 'live' || control.channel === 'mailbox';
  const active = DELIVERY.find((option) => option.mode === control.delivery) ?? DELIVERY[0]!;

  if (!canSend) {
    return (
      <footer className="border-t border-border bg-card px-6 py-3 text-sm text-muted-foreground">
        {CHANNEL[control.channel].explain || 'Select a conversation to send a message.'}
      </footer>
    );
  }

  return (
    <footer className="border-t border-border bg-card px-6 py-3">
      <div className="mx-auto flex max-w-3xl flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <fieldset className="inline-flex border border-border">
            <legend className="sr-only">Delivery</legend>
            {DELIVERY.map((option) => (
              <label
                key={option.mode}
                className={cn(
                  'flex h-8 cursor-pointer items-center px-3 text-sm has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring',
                  control.delivery === option.mode
                    ? 'bg-foreground text-background'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <input
                  type="radio"
                  name="hq-delivery"
                  value={option.mode}
                  checked={control.delivery === option.mode}
                  onChange={() => control.setDelivery(option.mode)}
                  className="sr-only"
                />
                {option.label}
              </label>
            ))}
          </fieldset>
          <span className="text-sm text-muted-foreground">{active.hint}</span>
          {!subjectOpen && (
            <button
              type="button"
              onClick={() => setSubjectOpen(true)}
              className="ml-auto text-sm text-muted-foreground hover:text-foreground"
            >
              Add a subject
            </button>
          )}
        </div>
        {subjectOpen && (
          <input
            value={control.subject}
            onChange={(event) => control.setSubject(event.target.value)}
            placeholder={`Subject (default: HQ ${control.delivery})`}
            aria-label="Message subject"
            className="h-9 border border-border bg-background px-3 text-sm"
          />
        )}
        <div className="flex items-end gap-2">
          <textarea
            value={control.body}
            onChange={(event) => control.setBody(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                void control.send();
              }
            }}
            rows={2}
            aria-label={`Message ${control.targetLabel}`}
            placeholder={`Message ${control.targetLabel}…`}
            className="min-h-16 flex-1 resize-y border border-border bg-background px-3 py-2 text-sm leading-relaxed"
          />
          <button
            type="button"
            disabled={control.busy || control.body.trim().length === 0}
            onClick={() => void control.send()}
            className="inline-flex h-10 items-center gap-2 bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            <Send className="size-4" />
            {control.busy ? 'Sending…' : 'Send'}
          </button>
        </div>
        <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
          <span>Ctrl+Enter sends</span>
          {control.channel === 'mailbox' && (
            <span className="text-warning">{CHANNEL.mailbox.explain}</span>
          )}
          {control.status !== null && (
            <span
              role="status"
              className={cn(
                'ml-auto',
                control.status.tone === 'error' ? 'text-destructive' : 'text-success',
              )}
            >
              {control.status.text}
            </span>
          )}
        </p>
      </div>
    </footer>
  );
}
