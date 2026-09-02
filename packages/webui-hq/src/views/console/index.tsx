/**
 * Live Console — the full transcript for the selected session or agent, plus
 * the control channel that talks back to it.
 *
 * The transcript pipeline (seed fetch, live folding, pin-to-bottom) lives in
 * `domain/use-session-transcript` and is shared with the Fleet Map's chat
 * drawer; this view owns only the console chrome: the navigator, the header
 * counters, the virtualized list and the composer.
 */
import {
  ArrowDownToLine,
  Bot,
  History,
  MessageSquareText,
  OctagonX,
  RadioTower,
  Send,
} from 'lucide-react';
import type * as React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { VList } from 'virtua';
import { useShallow } from 'zustand/react/shallow';
import { EmptyState, StatTile, StatusDot } from '../../components/hq/primitives.js';
import { TranscriptExpansionProvider } from '../../components/hq/transcript/expansion.js';
import { TranscriptTurn } from '../../components/hq/transcript/turn.js';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../components/ui/alert-dialog.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Checkbox } from '../../components/ui/checkbox.js';
import { Input, Select, Textarea } from '../../components/ui/input.js';
import { postCommand } from '../../data/api.js';
import { setHqConsolePrefs, useHqLocalPrefs } from '../../data/local-prefs.js';
import { useHqStore } from '../../data/store/index.js';
import { resolveConsoleControlTarget } from '../../domain/console-target.js';
import { commandLifecycleTone } from '../../domain/status-tone.js';
import { turnKey, useSessionTranscript } from '../../domain/use-session-transcript.js';
import { formatClock } from '../../lib/format.js';
import { cn } from '../../lib/utils.js';
import { FleetNav } from './fleet-nav.js';

type DeliveryMode = 'steer' | 'btw' | 'queue';

/** Locally-tracked dispatches, so a sent message appears before it echoes back. */
const MAX_RECEIPTS = 8;
/**
 * How close in time a transcript entry must be to a receipt for the two to be
 * considered the same message. Generous on purpose: the round trip through the
 * client and back can take a while on a busy fleet, and showing the message
 * twice is worse than showing the optimistic copy a little longer.
 */
const RECEIPT_ECHO_WINDOW_MS = 120_000;

interface CommandReceipt {
  commandId: string;
  type: DeliveryMode | 'abort';
  target: string;
  preview: string;
  createdAt: string;
}

function CommandTurn({
  receipt,
  lifecycle,
}: {
  receipt: CommandReceipt;
  lifecycle: string;
}): React.ReactElement {
  const clock = formatClock(receipt.createdAt);
  const badge = <Badge tone={commandLifecycleTone(lifecycle)}>{lifecycle}</Badge>;

  if (receipt.type === 'abort') {
    return (
      <div
        data-command-id={receipt.commandId}
        className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground"
      >
        <OctagonX className="size-3 text-destructive" />
        <span>{receipt.preview}</span>
        {badge}
        <span className="tabular text-[10px] opacity-70">{clock}</span>
      </div>
    );
  }

  return (
    <div data-command-id={receipt.commandId} className="flex justify-end">
      <div className="max-w-[85%] border border-primary/35 bg-primary/10 px-2.5 py-1.5">
        <div className="flex items-center gap-1.5 pb-0.5">
          <span className="text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
            you → {receipt.target} · {receipt.type}
          </span>
          {badge}
          <span className="tabular text-[10px] text-muted-foreground/70">{clock}</span>
        </div>
        <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">
          {receipt.preview}
        </p>
      </div>
    </div>
  );
}

export function LiveConsoleView(): React.ReactElement {
  const { selectedSessionId, selectedAgentId, snapshot, commandStatuses } = useHqStore(
    useShallow((state) => ({
      selectedSessionId: state.selectedSessionId,
      selectedAgentId: state.selectedAgentId,
      snapshot: state.snapshot,
      commandStatuses: state.commandStatuses,
    })),
  );

  const sessionId = selectedSessionId;
  const agentId = selectedAgentId;
  const viewingAgent = agentId !== null;

  const consolePrefs = useHqLocalPrefs().console;
  const [delivery, setDelivery] = useState<DeliveryMode>(consolePrefs.delivery);
  const [subject, setSubject] = useState(consolePrefs.subject);
  const [body, setBody] = useState(consolePrefs.body);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [interruptOpen, setInterruptOpen] = useState(false);
  const [includeSubagents, setIncludeSubagents] = useState(false);
  const [receipts, setReceipts] = useState<CommandReceipt[]>([]);

  const chat = useSessionTranscript(sessionId, agentId);
  const { entries, meta, stats } = chat;

  /**
   * Drop a receipt once the real transcript carries the same message: keeping
   * the optimistic copy would show every steer twice.
   */
  const visibleReceipts = useMemo(
    () =>
      receipts.filter((receipt) => {
        if (receipt.type === 'abort') return true;
        const sentAt = Date.parse(receipt.createdAt);
        return !entries.some(
          (entry) =>
            entry.role === 'user' &&
            entry.text.trim() === receipt.preview &&
            Math.abs(Date.parse(entry.ts) - sentAt) < RECEIPT_ECHO_WINDOW_MS,
        );
      }),
    [entries, receipts],
  );

  const rowCount = entries.length + visibleReceipts.length;

  // Receipts render after the virtualized entries, so pinning has to be
  // re-applied once they land or the newest message sits below the fold.
  useEffect(() => {
    if (!chat.pinned || visibleReceipts.length === 0) return;
    const frame = window.requestAnimationFrame(() => {
      chat.listRef.current?.scrollToIndex(rowCount - 1, { align: 'end' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [chat.listRef, chat.pinned, rowCount, visibleReceipts.length]);

  const jumpToLatest = (): void => {
    chat.jumpToLatest();
    window.requestAnimationFrame(() => {
      chat.listRef.current?.scrollToIndex(rowCount - 1, { align: 'end' });
    });
  };

  const controlTarget = useMemo(
    () => resolveConsoleControlTarget(snapshot, sessionId, agentId),
    [agentId, sessionId, snapshot],
  );
  const selectedAgent = controlTarget?.agent ?? null;
  const isLeaderTarget = controlTarget?.recipient === 'leader';
  const targetLabel =
    selectedAgent?.name ??
    (isLeaderTarget ? 'Leader agent' : (controlTarget?.recipient ?? 'agent'));
  const controllable = controlTarget?.controllable === true;

  // Changing conversation resets everything conversation-scoped; a receipt or
  // an error from the previous target would be actively misleading here.
  useEffect(() => {
    const clientId = controlTarget?.client?.clientId;
    if (clientId !== undefined) useHqStore.getState().selectClient(clientId);
    setStatus(null);
    setInterruptOpen(false);
    setIncludeSubagents(false);
    setReceipts([]);
  }, [controlTarget?.client?.clientId, sessionId, agentId]);

  const addReceipt = (receipt: CommandReceipt): void => {
    setReceipts((current) => [...current, receipt].slice(-MAX_RECEIPTS));
  };

  const sendMessage = async (): Promise<void> => {
    const client = controlTarget?.client;
    if (
      controlTarget === null ||
      client === null ||
      client === undefined ||
      !controllable ||
      body.trim().length === 0
    ) {
      return;
    }

    setBusy(true);
    setStatus(null);
    const sent = body.trim();
    try {
      const result = await postCommand(client.clientId, delivery, {
        to: controlTarget.recipient,
        subject: subject.trim() || `HQ ${delivery}`,
        body: sent,
        priority: delivery === 'steer' ? 'high' : 'normal',
      });
      setBody('');
      setHqConsolePrefs({ body: '' });
      addReceipt({
        commandId: result.commandId,
        type: delivery,
        target: targetLabel,
        preview: sent,
        createdAt: new Date().toISOString(),
      });
      setStatus({
        tone: 'ok',
        text: `${delivery} queued for ${targetLabel} · ${result.commandId}`,
      });
    } catch (cause) {
      setStatus({ tone: 'error', text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(false);
    }
  };

  const interruptTarget = async (): Promise<void> => {
    const client = controlTarget?.client;
    if (controlTarget === null || client === null || client === undefined) return;

    setBusy(true);
    setStatus(null);
    try {
      const primary = await postCommand(client.clientId, 'abort', {
        target: controlTarget.recipient,
      });
      addReceipt({
        commandId: primary.commandId,
        type: 'abort',
        target: targetLabel,
        preview: `Interrupt ${targetLabel}`,
        createdAt: new Date().toISOString(),
      });

      if (isLeaderTarget && includeSubagents) {
        const fleet = await postCommand(client.clientId, 'abort', { target: 'fleet' });
        addReceipt({
          commandId: fleet.commandId,
          type: 'abort',
          target: 'all subagents',
          preview: 'Interrupt every subagent on this client',
          createdAt: new Date().toISOString(),
        });
      }

      setStatus({
        tone: 'ok',
        text:
          isLeaderTarget && includeSubagents
            ? 'Leader interrupt queued; all subagents will be interrupted too.'
            : `${targetLabel} interrupt queued.`,
      });
      setInterruptOpen(false);
    } catch (cause) {
      setStatus({ tone: 'error', text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header
        data-testid="console-overview"
        className="flex shrink-0 flex-wrap items-center gap-x-8 gap-y-3 border-b border-border px-4 py-2"
      >
        <div className="flex min-w-56 flex-1 items-center gap-2">
          <StatusDot
            tone={controlTarget !== null ? 'active' : 'idle'}
            pulse={controlTarget !== null}
          />
          <div className="min-w-0 leading-tight">
            <div className="text-[10px] uppercase tracking-[0.09em] text-muted-foreground">
              Live transcript
            </div>
            <strong className="block truncate font-display text-sm">
              {sessionId === null
                ? 'Select an endpoint'
                : viewingAgent
                  ? (selectedAgent?.name ?? agentId)
                  : (meta.projectName ?? targetLabel)}
            </strong>
            <span className="text-[11px] text-muted-foreground">
              {sessionId === null
                ? 'Choose a client or agent from the fleet navigator'
                : controllable
                  ? `${targetLabel} · control channel ready`
                  : `${targetLabel} · transcript is read-only`}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <StatTile label="turns" value={rowCount} />
          <StatTile label="tools" value={stats.tools} />
          <StatTile
            label="running"
            value={stats.running}
            tone={stats.running > 0 ? 'running' : 'idle'}
          />
          <StatTile
            label="errors"
            value={stats.errors}
            tone={stats.errors > 0 ? 'error' : 'idle'}
          />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="w-60 shrink-0 overflow-y-auto border-r border-border">
          <FleetNav
            snapshot={snapshot ?? null}
            selectedSessionId={sessionId}
            selectedAgentId={agentId}
          />
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-1.5">
            <MessageSquareText className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="font-display text-[11px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
              Console
            </span>
            {viewingAgent && (
              <Badge tone="active">
                <Bot />
                {selectedAgent?.name ?? agentId}
              </Badge>
            )}
            {meta.projectName !== undefined && !viewingAgent && (
              <Badge tone="neutral">{meta.projectName}</Badge>
            )}
            {controlTarget !== null && (
              <Badge tone="info" title={controlTarget.client?.clientId}>
                {controlTarget.session.hostname ?? controlTarget.session.machineId} ·{' '}
                {controlTarget.session.clientKind.toUpperCase()}
              </Badge>
            )}
            {controlTarget?.mailboxServeActive === true && (
              <Badge tone="active">mailbox serve</Badge>
            )}
            {meta.source !== undefined && (
              <Badge
                tone="neutral"
                title={
                  meta.source === 'disk'
                    ? 'disk = full history replayed from this machine'
                    : 'stream = live ring only (remote, or not yet persisted)'
                }
              >
                {meta.source === 'disk' ? 'full history' : 'live ring'}
              </Badge>
            )}

            <div className="ml-auto flex items-center gap-1.5">
              {stats.running > 0 && <Badge tone="running">{stats.running} running</Badge>}
              {stats.errors > 0 && <Badge tone="error">{stats.errors} err</Badge>}
              {!viewingAgent && !chat.full && meta.total > entries.length && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => chat.setFull(true)}
                  title={`History is truncated — load all ${meta.total} turns`}
                >
                  <History />
                  load all {meta.total}
                </Button>
              )}
            </div>
          </div>

          {sessionId === null ? (
            <EmptyState
              icon={MessageSquareText}
              title="Choose a conversation"
              hint="Pick a live client or agent from the fleet navigator to inspect its transcript."
              className="m-4"
            />
          ) : chat.loading && rowCount === 0 ? (
            <p className="p-4 text-xs text-muted-foreground">
              {viewingAgent ? 'Loading agent history…' : 'Loading transcript…'}
            </p>
          ) : chat.error !== null ? (
            <EmptyState title="Could not load transcript" hint={chat.error} className="m-4" />
          ) : rowCount === 0 ? (
            <EmptyState
              title={
                viewingAgent
                  ? `No messages from ${selectedAgent?.name ?? agentId ?? 'this agent'} yet`
                  : 'No transcript entries yet'
              }
              className="m-4"
            />
          ) : (
            <div className="relative min-h-0 flex-1">
              <TranscriptExpansionProvider>
                <VList
                  ref={chat.listRef}
                  onScroll={chat.onScroll}
                  data-testid="transcript-list"
                  className="h-full px-3 py-2"
                >
                  {entries.map((entry, index) => (
                    <div key={turnKey(entry, index)} className="pb-1.5">
                      <TranscriptTurn
                        entry={entry}
                        running={chat.isRunningAt(entry, index)}
                        turnKey={turnKey(entry, index)}
                      />
                    </div>
                  ))}
                  {visibleReceipts.map((receipt) => {
                    const command = commandStatuses.find(
                      (candidate) => candidate.commandId === receipt.commandId,
                    );
                    const lifecycle = command?.ackStatus ?? command?.status ?? 'queued';
                    return (
                      <div
                        key={`receipt:${receipt.commandId}`}
                        className="pb-1.5"
                        aria-live="polite"
                      >
                        <CommandTurn receipt={receipt} lifecycle={lifecycle} />
                      </div>
                    );
                  })}
                </VList>
              </TranscriptExpansionProvider>

              {!chat.pinned && (
                <Button
                  size="icon"
                  onClick={jumpToLatest}
                  title="Jump to latest"
                  aria-label="Jump to latest"
                  className="absolute bottom-3 right-4 shadow-lg"
                >
                  <ArrowDownToLine />
                </Button>
              )}
            </div>
          )}

          {sessionId !== null && (
            <div className="shrink-0 space-y-1.5 border-t border-border p-2">
              <div className="flex items-center gap-1.5 text-[11px]">
                <RadioTower className="size-3 text-muted-foreground" />
                <span className="text-muted-foreground">
                  Send to <strong className="text-foreground">{targetLabel}</strong>
                </span>
                <Badge tone={controllable ? 'active' : 'error'} className="ml-auto">
                  {controllable ? 'control live' : 'read-only client'}
                </Badge>
              </div>

              <div className="flex gap-1.5">
                <Select
                  aria-label="Message delivery mode"
                  value={delivery}
                  onChange={(event) => {
                    const next = event.target.value as DeliveryMode;
                    setDelivery(next);
                    setHqConsolePrefs({ delivery: next });
                  }}
                  className="w-36 shrink-0"
                >
                  <option value="steer">Steer now</option>
                  <option value="btw">BTW / FYI</option>
                  <option value="queue">Queue next</option>
                </Select>
                <Input
                  aria-label="Message subject"
                  placeholder={`HQ ${delivery} (optional subject)`}
                  value={subject}
                  onChange={(event) => {
                    setSubject(event.target.value);
                    setHqConsolePrefs({ subject: event.target.value });
                  }}
                />
                <Button
                  variant="destructive"
                  disabled={busy || !controllable}
                  onClick={() => {
                    setIncludeSubagents(false);
                    setInterruptOpen(true);
                  }}
                  className="shrink-0"
                >
                  <OctagonX />
                  Interrupt
                </Button>
              </div>

              <div className="flex gap-1.5">
                <Textarea
                  aria-label={`Message ${targetLabel}`}
                  placeholder={`Message ${targetLabel}…`}
                  rows={2}
                  value={body}
                  onChange={(event) => {
                    setBody(event.target.value);
                    setHqConsolePrefs({ body: event.target.value });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                      event.preventDefault();
                      void sendMessage();
                    }
                  }}
                  className="min-h-16"
                />
                <Button
                  disabled={busy || body.trim().length === 0 || !controllable}
                  onClick={() => void sendMessage()}
                  className="shrink-0 self-stretch"
                >
                  <Send />
                  {busy ? 'Queueing…' : 'Send'}
                </Button>
              </div>

              <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                <span>Ctrl+Enter sends · steer interrupts at the next safe turn</span>
                {status !== null && (
                  <span
                    data-testid="composer-status"
                    data-tone={status.tone}
                    className={cn(
                      'ml-auto',
                      status.tone === 'error' ? 'text-destructive' : 'text-success',
                    )}
                  >
                    {status.text}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <AlertDialog open={interruptOpen} onOpenChange={setInterruptOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Interrupt {targetLabel}?</AlertDialogTitle>
            <AlertDialogDescription>
              The current run will stop at its cancellation boundary.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {isLeaderTarget && (
            <div className="flex items-center gap-2 text-xs">
              <Checkbox
                id="hq-interrupt-subagents"
                checked={includeSubagents}
                onCheckedChange={(checked) => setIncludeSubagents(checked === true)}
              />
              <label htmlFor="hq-interrupt-subagents">
                Also interrupt every subagent on this client
              </label>
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={() => void interruptTarget()}>
              <OctagonX />
              Confirm interrupt
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
