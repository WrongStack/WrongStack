/**
 * LiveConsole view — full chat transcript for the selected session, rendered
 * as a WebUI-grade conversation: user / assistant bubbles with real markdown,
 * collapsed thinking cards, collapsible tool cards with real result views
 * (diffs, terminal output, numbered reads, JSON, todos), and subtle
 * system/error lines.
 *
 * The transcript pipeline (seed fetch + live folding + pinning) lives in
 * `lib/use-session-transcript` and is shared with the Fleet Topology chat
 * drawer; this view owns only the console chrome (picker, pills, layout).
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
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { VList } from 'virtua';
import { useShallow } from 'zustand/react/shallow';
import { turnKey, useSessionTranscript } from '../lib/use-session-transcript.js';
import { postCommand, useHqStore } from '../store.js';
import { setHqConsolePrefs, useHqLocalPrefs } from '../stores/hq-local-prefs.js';
import { resolveConsoleControlTarget } from './console-target.js';
import { FleetNav } from './fleet-nav.js';
import { TranscriptTurn } from './transcript-turn.js';

interface ConsoleCommandReceipt {
  commandId: string;
  type: 'steer' | 'btw' | 'queue' | 'abort';
  target: string;
  preview: string;
  createdAt: string;
}

export function commandLifecycleTone(lifecycle: string): 'active' | 'error' | 'info' | 'warn' {
  if (lifecycle === 'completed') return 'active';
  if (lifecycle === 'failed' || lifecycle === 'rejected') return 'error';
  if (lifecycle === 'delivered' || lifecycle === 'accepted') return 'info';
  return 'warn';
}

function ConsoleCommandTurn({
  receipt,
  lifecycle,
}: {
  receipt: ConsoleCommandReceipt;
  lifecycle: string;
}): React.ReactElement {
  const clock = new Date(receipt.createdAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const lifecyclePill = (
    <span className={`hq-pill ${commandLifecycleTone(lifecycle)}`}>{lifecycle}</span>
  );

  if (receipt.type === 'abort') {
    return (
      <div className="hq-chat-turn system hq-command-turn" data-command-id={receipt.commandId}>
        <span className="hq-chat-system-line">
          <OctagonX size={12} /> {receipt.preview} {lifecyclePill}
          <span className="hq-chat-clock">{clock}</span>
        </span>
      </div>
    );
  }

  return (
    <div className="hq-chat-turn user hq-command-turn" data-command-id={receipt.commandId}>
      <div className="hq-chat-bubble user">
        <div className="hq-chat-role">
          you → {receipt.target} · {receipt.type} {lifecyclePill}
          <span className="hq-chat-clock">{clock}</span>
        </div>
        <div className="hq-chat-prose">{receipt.preview}</div>
      </div>
    </div>
  );
}

export function LiveConsoleView(): React.ReactElement {
  const { selectedSessionId, selectedAgentId, snapshot, commandStatuses } = useHqStore(
    useShallow((s) => ({
      selectedSessionId: s.selectedSessionId,
      selectedAgentId: s.selectedAgentId,
      snapshot: s.snapshot,
      commandStatuses: s.commandStatuses,
    })),
  );
  const sessionId = selectedSessionId;
  const agentId = selectedAgentId;
  const viewingAgent = agentId !== null;
  const consolePrefs = useHqLocalPrefs().console;
  const [delivery, setDelivery] = useState<'steer' | 'btw' | 'queue'>(consolePrefs.delivery);
  const [subject, setSubject] = useState(consolePrefs.subject);
  const [body, setBody] = useState(consolePrefs.body);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [interruptOpen, setInterruptOpen] = useState(false);
  const [includeSubagents, setIncludeSubagents] = useState(false);
  const [receipts, setReceipts] = useState<ConsoleCommandReceipt[]>([]);

  const chat = useSessionTranscript(sessionId, agentId);
  const { entries, meta, stats } = chat;
  const visibleReceipts = useMemo(
    () =>
      receipts.filter((receipt) => {
        if (receipt.type === 'abort') return true;
        const receiptTime = Date.parse(receipt.createdAt);
        return !entries.some(
          (entry) =>
            entry.role === 'user' &&
            entry.text.trim() === receipt.preview &&
            Math.abs(Date.parse(entry.ts) - receiptTime) < 120_000,
        );
      }),
    [entries, receipts],
  );

  useEffect(() => {
    if (!chat.pinned || visibleReceipts.length === 0) return;
    const frame = window.requestAnimationFrame(() => {
      chat.listRef.current?.scrollToIndex(entries.length + visibleReceipts.length - 1, {
        align: 'end',
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [chat.listRef, chat.pinned, entries.length, visibleReceipts.length]);

  const jumpToConsoleLatest = (): void => {
    chat.jumpToLatest();
    window.requestAnimationFrame(() => {
      chat.listRef.current?.scrollToIndex(entries.length + visibleReceipts.length - 1, {
        align: 'end',
      });
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

  useEffect(() => {
    const clientId = controlTarget?.client?.clientId;
    if (clientId !== undefined) useHqStore.getState().selectClient(clientId);
    setStatus(null);
    setInterruptOpen(false);
    setIncludeSubagents(false);
    setReceipts([]);
  }, [controlTarget?.client?.clientId, sessionId, agentId]);

  const sendMessage = async (): Promise<void> => {
    if (
      controlTarget?.client === null ||
      controlTarget?.client === undefined ||
      !controlTarget.controllable ||
      body.trim().length === 0
    ) {
      return;
    }
    setBusy(true);
    setStatus(null);
    const sentBody = body.trim();
    try {
      const result = await postCommand(controlTarget.client.clientId, delivery, {
        to: controlTarget.recipient,
        subject: subject.trim() || `HQ ${delivery}`,
        body: sentBody,
        priority: delivery === 'steer' ? 'high' : 'normal',
      });
      setBody('');
      setHqConsolePrefs({ body: '' });
      setReceipts((current) =>
        [
          ...current,
          {
            commandId: result.commandId,
            type: delivery,
            target: targetLabel,
            preview: sentBody,
            createdAt: new Date().toISOString(),
          },
        ].slice(-8),
      );
      setStatus({
        tone: 'ok',
        text: `${delivery} queued for ${targetLabel} · ${result.commandId}`,
      });
    } catch (error) {
      setStatus({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const interruptTarget = async (): Promise<void> => {
    if (controlTarget?.client === null || controlTarget?.client === undefined) return;
    setBusy(true);
    setStatus(null);
    try {
      const primary = await postCommand(controlTarget.client.clientId, 'abort', {
        target: controlTarget.recipient,
      });
      setReceipts((current) =>
        [
          ...current,
          {
            commandId: primary.commandId,
            type: 'abort' as const,
            target: targetLabel,
            preview: `Interrupt ${targetLabel}`,
            createdAt: new Date().toISOString(),
          },
        ].slice(-8),
      );
      if (isLeaderTarget && includeSubagents) {
        const fleet = await postCommand(controlTarget.client.clientId, 'abort', {
          target: 'fleet',
        });
        setReceipts((current) =>
          [
            ...current,
            {
              commandId: fleet.commandId,
              type: 'abort' as const,
              target: 'all subagents',
              preview: 'Interrupt every subagent on this client',
              createdAt: new Date().toISOString(),
            },
          ].slice(-8),
        );
      }
      setStatus({
        tone: 'ok',
        text:
          isLeaderTarget && includeSubagents
            ? 'Leader interrupt queued; all subagents will be interrupted too.'
            : `${targetLabel} interrupt queued.`,
      });
      setInterruptOpen(false);
    } catch (error) {
      setStatus({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="hq-console-shell">
      <header className="hq-console-overview">
        <div className="hq-console-overview-copy">
          <span
            className="hq-console-live-dot"
            data-live={controlTarget !== null}
            aria-hidden="true"
          />
          <div>
            <span>Live transcript</span>
            <strong>
              {sessionId === null
                ? 'Select an endpoint'
                : viewingAgent
                  ? (selectedAgent?.name ?? agentId)
                  : (meta.projectName ?? targetLabel)}
            </strong>
            <small>
              {sessionId === null
                ? 'Choose a client or agent from the fleet navigator'
                : controlTarget?.controllable === true
                  ? `${targetLabel} · control channel ready`
                  : `${targetLabel} · transcript is read-only`}
            </small>
          </div>
        </div>
        <fieldset className="hq-console-overview-metrics" aria-label="Transcript totals">
          <ConsoleMetric label="turns" value={stats.turns + visibleReceipts.length} />
          <ConsoleMetric label="tools" value={stats.tools} />
          <ConsoleMetric
            label="running"
            value={stats.running}
            tone={stats.running > 0 ? 'active' : undefined}
          />
          <ConsoleMetric
            label="errors"
            value={stats.errors}
            tone={stats.errors > 0 ? 'error' : undefined}
          />
        </fieldset>
      </header>
      <FleetNav
        snapshot={snapshot ?? null}
        selectedSessionId={sessionId}
        selectedAgentId={agentId}
      />
      <div className="hq-console">
        <div className="hq-chat-header">
          <MessageSquareText size={15} className="hq-chat-header-icon" />
          <span className="hq-card-title hq-title-inline">Console</span>
          {viewingAgent && (
            <span className="hq-pill active">
              <Bot size={12} /> {selectedAgent?.name ?? agentId}
            </span>
          )}
          {meta.projectName !== undefined && !viewingAgent && (
            <span className="hq-pill">{meta.projectName}</span>
          )}
          {controlTarget !== null && (
            <span className="hq-pill info" title={controlTarget.client?.clientId}>
              {controlTarget.session.hostname ?? controlTarget.session.machineId} ·{' '}
              {controlTarget.session.clientKind.toUpperCase()}
            </span>
          )}
          {controlTarget?.mailboxServeActive === true && (
            <span className="hq-pill active">mailbox serve</span>
          )}
          {meta.source !== undefined && (
            <span
              className="hq-pill"
              title={
                meta.source === 'disk'
                  ? 'disk = full history replayed from this machine'
                  : 'stream = live ring only (remote or not yet persisted)'
              }
            >
              {meta.source === 'disk' ? 'full history' : 'live ring'}
            </span>
          )}
          <span className="hq-chat-counts">
            <span className="hq-pill">{stats.turns + visibleReceipts.length} turns</span>
            <span className="hq-pill">{stats.tools} tools</span>
            {stats.running > 0 && <span className="hq-pill running">{stats.running} running</span>}
            {stats.errors > 0 && <span className="hq-pill error">{stats.errors} err</span>}
            {!viewingAgent && !chat.full && meta.total > entries.length && (
              <button
                type="button"
                className="hq-btn secondary hq-chat-fullbtn"
                onClick={() => chat.setFull(true)}
                title={`History is truncated — load all ${meta.total} turns`}
              >
                <History size={12} /> load all {meta.total}
              </button>
            )}
          </span>
        </div>

        {sessionId === null ? (
          <div className="hq-console-empty">
            <span aria-hidden="true">
              <MessageSquareText size={24} />
            </span>
            <strong>Choose a conversation</strong>
            <small>
              Pick a live client or agent from the fleet navigator to inspect its transcript.
            </small>
          </div>
        ) : chat.loading && entries.length === 0 && visibleReceipts.length === 0 ? (
          <div className="hq-empty">
            {viewingAgent ? 'Loading agent history…' : 'Loading transcript…'}
          </div>
        ) : chat.error !== null ? (
          <div className="hq-empty">Error: {chat.error}</div>
        ) : (
          <div className="hq-chat-scroll">
            {entries.length === 0 && visibleReceipts.length === 0 ? (
              <div className="hq-empty">
                {viewingAgent
                  ? `No messages from ${selectedAgent?.name ?? agentId ?? 'this agent'} yet.`
                  : 'No transcript entries yet.'}
              </div>
            ) : (
              <VList ref={chat.listRef} onScroll={chat.onScroll} className="hq-chat-vlist">
                {entries.map((entry, i) => (
                  <div key={turnKey(entry, i)} className="hq-chat-rowpad">
                    <TranscriptTurn entry={entry} running={chat.isRunningAt(entry, i)} />
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
                      className="hq-chat-rowpad"
                      aria-live="polite"
                    >
                      <ConsoleCommandTurn receipt={receipt} lifecycle={lifecycle} />
                    </div>
                  );
                })}
              </VList>
            )}
            {!chat.pinned && (entries.length > 0 || visibleReceipts.length > 0) && (
              <button
                type="button"
                className="hq-chat-jump"
                onClick={jumpToConsoleLatest}
                title="Jump to latest"
              >
                <ArrowDownToLine size={14} />
              </button>
            )}
          </div>
        )}

        {sessionId !== null && (
          <div className="hq-console-composer">
            <div className="hq-console-composer-head">
              <span>
                <RadioTower size={13} /> Send to <strong>{targetLabel}</strong>
              </span>
              <span
                className={`hq-pill ${controlTarget?.controllable === true ? 'active' : 'error'}`}
              >
                {controlTarget?.controllable === true ? 'control live' : 'read-only client'}
              </span>
            </div>
            <div className="hq-console-compose-row">
              <select
                className="hq-select hq-console-delivery"
                aria-label="Message delivery mode"
                value={delivery}
                onChange={(event) => {
                  const next = event.target.value as 'steer' | 'btw' | 'queue';
                  setDelivery(next);
                  setHqConsolePrefs({ delivery: next });
                }}
              >
                <option value="steer">Steer now</option>
                <option value="btw">BTW / FYI</option>
                <option value="queue">Queue next</option>
              </select>
              <input
                className="hq-input hq-console-subject"
                aria-label="Message subject"
                placeholder={`HQ ${delivery} (optional subject)`}
                value={subject}
                onChange={(event) => {
                  setSubject(event.target.value);
                  setHqConsolePrefs({ subject: event.target.value });
                }}
              />
              <button
                type="button"
                className="hq-btn danger hq-console-interrupt"
                disabled={busy || controlTarget?.controllable !== true}
                onClick={() => {
                  setIncludeSubagents(false);
                  setInterruptOpen(true);
                }}
              >
                <OctagonX size={13} /> Interrupt
              </button>
            </div>
            <div className="hq-console-compose-row hq-console-message-row">
              <textarea
                className="hq-textarea hq-console-message"
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
              />
              <button
                type="button"
                className="hq-btn primary hq-console-send"
                disabled={busy || body.trim().length === 0 || controlTarget?.controllable !== true}
                onClick={() => void sendMessage()}
              >
                <Send size={13} /> {busy ? 'Queueing…' : 'Send'}
              </button>
            </div>
            <div className="hq-console-compose-foot">
              <span>Ctrl+Enter sends · steer interrupts at the next safe turn</span>
              {status !== null && (
                <span className={`hq-console-status ${status.tone}`}>{status.text}</span>
              )}
            </div>
          </div>
        )}
      </div>

      {interruptOpen && controlTarget !== null && (
        <div className="hq-confirm-layer" role="presentation">
          <button
            type="button"
            className="hq-confirm-scrim"
            aria-label="Cancel interrupt"
            onClick={() => setInterruptOpen(false)}
          />
          <section
            className="hq-confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="hq-interrupt-title"
          >
            <OctagonX size={22} className="hq-confirm-danger" />
            <div>
              <h2 id="hq-interrupt-title">Interrupt {targetLabel}?</h2>
              <p>The current run will stop at its cancellation boundary.</p>
            </div>
            {isLeaderTarget && (
              <label className="hq-confirm-check">
                <input
                  type="checkbox"
                  checked={includeSubagents}
                  onChange={(event) => setIncludeSubagents(event.target.checked)}
                />
                Also interrupt every subagent on this client
              </label>
            )}
            <div className="hq-confirm-actions">
              <button
                type="button"
                className="hq-btn secondary"
                onClick={() => setInterruptOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="hq-btn danger"
                disabled={busy}
                onClick={() => void interruptTarget()}
              >
                <OctagonX size={13} /> Confirm interrupt
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function ConsoleMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'active' | 'error';
}): React.ReactElement {
  return (
    <div className="hq-console-overview-metric" data-tone={tone}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
