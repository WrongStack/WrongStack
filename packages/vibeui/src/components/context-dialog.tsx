'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { contentText, record, rows, text } from '../lib/session';
import type { SessionController } from '../lib/use-session';
import { CodePanel } from './code-panel';
import { ContentView } from './content-view';
import { Modal } from './dialogs';
import { usePresentation } from './presentation-mode';

export function ContextDialog({
  controller,
  open,
  onOpenChange,
}: {
  controller: SessionController;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { state, send, subscribe, compactPending, connection } = controller;
  const [snapshot, setSnapshot] = useState<Record<string, unknown> | null>(null);
  const [debug, setDebug] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [revision, setRevision] = useState(0);
  const { mode: view } = usePresentation();
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    setSnapshot(null);
    setDebug(null);
    setError('');
    setQuery('');
    if (!open || connection !== 'open' || compactPending) return;
    setLoading(view === 'extended');
    const timer =
      view === 'extended'
        ? setTimeout(() => {
            setLoading(false);
            setError('Context snapshot timed out. Refresh to retry.');
          }, 10_000)
        : undefined;
    const off = subscribe((frame) => {
      const p = record(frame.payload);
      if (p.sessionId !== state.id) return;
      if (frame.type === 'context.debug') setDebug(p);
      if (
        frame.type === 'context.editor.snapshot' &&
        Array.isArray(p.messages) &&
        typeof p.revision === 'string'
      ) {
        setSnapshot(p);
        setLoading(false);
        clearTimeout(timer);
      }
      if (
        frame.type === 'error' ||
        (frame.type === 'key.operation_result' && p.success === false)
      ) {
        setError(text(p.message) || 'Context unavailable.');
        setLoading(false);
        clearTimeout(timer);
      }
    });
    send('context.debug', { sessionId: state.id });
    if (view === 'extended')
      send('context.editor.open', { sessionId: state.id, includeReadonlyContent: true });
    send('stats.get', { sessionId: state.id });
    const statsTimer = setInterval(() => send('stats.get', { sessionId: state.id }), 10_000);
    return () => {
      clearTimeout(timer);
      clearInterval(statsTimer);
      off();
    };
  }, [open, state.id, connection, send, subscribe, revision, compactPending, view]);
  const metrics = record(snapshot?.readonlyContext);
  // Price-cliff awareness: the server publishes the models.dev long-context
  // step-up tier and the compaction trigger it forces, `min(threshold x
  // window, cliff)`. Rows appear only while a cliff is actually in force, so
  // models without a step-up tier keep the three original metric cards.
  const cliff = record(debug?.cliff);
  const cliffRows: Array<[string, unknown]> =
    cliff.binding === true
      ? [
          ['Price cliff', cliff.cliffTokens],
          ['Fires at', cliff.triggerTokens],
          ['Window-only', cliff.uncappedTriggerTokens],
        ]
      : [];
  const messages = useMemo(
    () =>
      rows(snapshot?.messages)
        .map((message, index) => ({
          index,
          role: text(message.role),
          content:
            typeof message.content === 'string'
              ? message.content
              : (JSON.stringify(
                  message.content,
                  (_key, value) =>
                    record(value).type === 'image'
                      ? {
                          type: 'image',
                          mediaType: record(record(value).source).media_type,
                          note: 'Image bytes omitted from text view',
                        }
                      : value,
                  2,
                ) ?? ''),
        }))
        .filter((message) =>
          `${message.role} ${message.content}`.toLowerCase().includes(query.toLowerCase()),
        ),
    [snapshot, query],
  );
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Context window"
      description="Usage, cache and the conversation in memory."
      wide
      detailToggle
    >
      <div className="context-toolbar">
        <span>
          {text(debug?.mode) || 'Current context'} ·{' '}
          {Number(metrics.totalTokens ?? state.tokens).toLocaleString()} tokens
        </span>
        <button
          type="button"
          className="secondary-button"
          disabled={connection !== 'open' || loading || compactPending}
          onClick={refresh}
        >
          Refresh context
        </button>
      </div>
      {view === 'simple' && (
        <section id="context-simple-panel" aria-label="Simple context metrics">
          <div className="context-capacity">
            <span>Context window capacity</span>
            <progress
              aria-label="Context window capacity"
              max={100}
              value={Math.max(0, Math.min(100, Math.round(state.load * 100)))}
            />
            <small>{Math.max(0, Math.round((1 - state.load) * 100))}% available</small>
          </div>
          <div className="context-metrics">
            {[
              [
                'Context usage',
                `${state.tokens.toLocaleString()} / ${state.maxContext.toLocaleString()}`,
              ],
              ['Session input', state.usage.input.toLocaleString()],
              ['Session output', state.usage.output.toLocaleString()],
              ['Session total', state.usage.total.toLocaleString()],
            ].map(([label, value]) => (
              <div key={label}>
                <small>{label}</small>
                <strong>{value}</strong>
                <small>tokens</small>
              </div>
            ))}
          </div>
        </section>
      )}
      <section className="cache-details" aria-label="Prompt cache">
        <h3>Prompt cache</h3>
        {state.cache ? (
          <>
            <div className="context-metrics">
              {[
                [
                  'Last request hit',
                  state.cache.lastHitRatio === null
                    ? 'Not reported'
                    : `${Math.round(state.cache.lastHitRatio * 100)}%`,
                ],
                ['Session hit', `${Math.round(state.cache.hitRatio * 100)}%`],
                ['Current cached prefix', `${state.cache.coverageTokens.toLocaleString()} tokens`],
                ['Session cache read', `${state.cache.readTokens.toLocaleString()} tokens`],
                ['Session cache write', `${state.cache.writeTokens.toLocaleString()} tokens`],
              ].map(([label, value]) => (
                <div key={label}>
                  <small>{label}</small>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
            <p className="fine-print">
              Last updated {new Date(state.cache.capturedAt).toLocaleTimeString()}. Cache reads and
              writes are cumulative; prefix coverage belongs to the current request.
            </p>
          </>
        ) : (
          <p className="fine-print">The backend has not reported cache usage yet.</p>
        )}
      </section>
      {connection !== 'open' && <p role="status">Reconnect to load context.</p>}
      {loading && <p role="status">Loading context snapshot…</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <section
        id="context-extended-panel"
        aria-label="Extended context content"
        hidden={view !== 'extended'}
      >
        {snapshot && (
          <>
            <div className="context-metrics">
              {[
                ['Messages', metrics.messageTokens],
                ['System prompt', metrics.systemPromptTokens],
                ['Tool schemas', metrics.toolSchemaTokens],
                ...cliffRows,
              ].map(([label, value]) => (
                <div key={String(label)}>
                  <small>{String(label)}</small>
                  <strong>{Number(value ?? 0).toLocaleString()}</strong>
                  <small>tokens</small>
                </div>
              ))}
            </div>
            <p className="fine-print">
              Token estimates describe this snapshot; the context bar shows the latest reported
              request usage.
            </p>
            <details className="context-tools">
              <summary>System instructions</summary>
              <ContentView
                label="System instructions"
                value={
                  contentText(record(snapshot.readonlyContent).systemPrompt) ||
                  'Instruction content was not included by this backend.'
                }
              />
            </details>
            <details className="context-tools">
              <summary>{Number(metrics.toolCount ?? 0)} tool schemas</summary>
              {rows(record(debug?.tools).breakdown).map((tool, index) => (
                <div key={index}>
                  {text(tool.name)}{' '}
                  <small>{Number(tool.tokens ?? 0).toLocaleString()} tokens</small>
                </div>
              ))}
              {rows(record(snapshot.readonlyContent).tools).map((tool, index) => (
                <details key={index}>
                  <summary>{text(tool.name)} · schema</summary>
                  <CodePanel
                    label="Tool schema"
                    value={JSON.stringify(tool, null, 2)}
                    defaultView="tree"
                  />
                </details>
              ))}
            </details>
            <input
              className="context-search"
              aria-label="Search context"
              placeholder="Search context messages…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="context-messages">
              {messages.map((message) => (
                <details key={message.index}>
                  <summary>
                    <strong>{message.role}</strong>
                    <span>{message.content.slice(0, 110)}</span>
                    <small>#{message.index + 1}</small>
                  </summary>
                  <ContentView label={`${message.role} message`} value={message.content} />
                </details>
              ))}
              {!messages.length && <p>No matching context messages.</p>}
            </div>
          </>
        )}
        {debug && (
          <details className="context-tools">
            <summary>Request residency and history retention</summary>
            <CodePanel
              label="Request details"
              defaultView="tree"
              value={JSON.stringify(
                {
                  residency: debug.residency ?? 'Not reported',
                  retention: debug.retention ?? 'Not reported',
                },
                null,
                2,
              )}
            />
          </details>
        )}
      </section>
      <section className="compact-section">
        <div>
          <strong>Compact context</strong>
          <p>
            Summarize older history to free space. The message queue pauses until you resume it.
          </p>
        </div>
        <button
          type="button"
          className="secondary-button"
          disabled={
            state.running ||
            !controller.ready ||
            controller.modelPending ||
            connection !== 'open' ||
            compactPending
          }
          onClick={controller.compactContext}
        >
          {compactPending ? 'Compacting…' : 'Compact now'}
        </button>
      </section>
      {state.running && (
        <p className="fine-print">Compaction is available after the current run finishes.</p>
      )}
    </Modal>
  );
}
