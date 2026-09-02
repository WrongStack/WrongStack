import { AlertTriangle, Brain, Shield, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusTrap } from './hooks/use-focus-trap.js';
import { onSimplePanel } from './lib/panel-events.js';
import { type SocketRequestHandle, socketRequest } from './lib/socket-request.js';
import type { SimpleSocket } from './lib/ws.js';

interface BrainLogEntry {
  at: number;
  kind: string;
  question: string;
  outcome: string;
}

interface BrainStatus {
  maxAutoRisk: string;
  log: BrainLogEntry[];
}

interface BrainAnswer {
  question: string;
  decision: string;
}

interface BrainPanelProps {
  socketRef: React.RefObject<SimpleSocket | null>;
}

export function BrainPanel({ socketRef }: BrainPanelProps) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<BrainStatus | null>(null);
  const [question, setQuestion] = useState('');
  const [thinking, setThinking] = useState(false);
  const [answer, setAnswer] = useState<BrainAnswer | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  useFocusTrap(dialogRef, open);
  // Handle of the in-flight brain.status request so a repeat load (or an
  // unmount) cancels the previous subscription and its 3s timeout.
  const pendingStatusRef = useRef<SocketRequestHandle | null>(null);

  useEffect(() => () => pendingStatusRef.current?.cancel(), []);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // Listen for brain.answer responses — stays subscribed while the panel is open.
  useEffect(() => {
    if (!open) return;
    const socket = socketRef.current;
    if (!socket) return;
    const unsub = socket.onMessage((msg) => {
      if (msg.type !== 'brain.answer') return;
      const p = msg.payload as Record<string, unknown> | undefined;
      if (!p) return;
      setThinking(false);
      const decision = p.decision as Record<string, unknown> | undefined;
      setAnswer({
        question: String(p.question ?? ''),
        decision: String(decision?.reason ?? decision?.type ?? p.decision ?? ''),
      });
    });
    return unsub;
  }, [open, socketRef]);

  const loadStatus = useCallback(() => {
    const socket = socketRef.current;
    if (!socket) return;
    pendingStatusRef.current?.cancel();
    const handle = socketRequest({
      socket,
      sendType: 'brain.status',
      payload: {},
      expectType: 'brain.status',
      timeoutMs: 3000,
    });
    pendingStatusRef.current = handle;
    void handle.promise.then((p) => {
      if (pendingStatusRef.current !== handle) return;
      pendingStatusRef.current = null;
      if (!p) return;
      setStatus({
        maxAutoRisk: String(p.maxAutoRisk ?? 'medium'),
        log: Array.isArray(p.log) ? (p.log as BrainLogEntry[]) : [],
      });
    });
  }, [socketRef]);

  useEffect(() => {
    const onOpen = () => {
      setOpen(true);
      loadStatus();
    };
    return onSimplePanel('open-brain-panel', onOpen);
  }, [loadStatus]);

  const askBrain = () => {
    if (!question.trim()) return;
    setThinking(true);
    setAnswer(null);
    socketRef.current?.send('brain.ask', { question: question.trim() });
    setQuestion('');
  };

  const riskColor = (level: string) =>
    level === 'low'
      ? 'var(--success)'
      : level === 'high' || level === 'critical'
        ? 'var(--danger)'
        : 'var(--warning)';

  if (!open) {
    return (
      <button
        type="button"
        className="brain-panel-trigger"
        title="Brain status"
        aria-label="Open brain panel"
        onClick={() => {
          setOpen(true);
          loadStatus();
        }}
      >
        <Brain size={13} aria-hidden="true" />
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        className="settings-overlay"
        tabIndex={-1}
        onClick={() => setOpen(false)}
      />
      <aside
        className="brain-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Brain"
        ref={dialogRef}
        tabIndex={-1}
      >
        <header className="brain-panel-head">
          <span>
            <Brain size={13} aria-hidden="true" /> BRAIN
          </span>
          <button type="button" onClick={() => setOpen(false)} aria-label="Close" ref={closeRef}>
            <X size={14} />
          </button>
        </header>
        {status && (
          <div className="brain-panel-risk">
            <Shield size={13} aria-hidden="true" />
            <span>
              Auto-risk:{' '}
              <b style={{ color: riskColor(status.maxAutoRisk) }}>{status.maxAutoRisk}</b>
            </span>
          </div>
        )}
        <div className="brain-panel-ask">
          <input
            type="text"
            placeholder="Ask the brain…"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') askBrain();
            }}
          />
          <button type="button" onClick={askBrain} disabled={!question.trim()}>
            Ask
          </button>
        </div>
        {thinking && (
          <div className="brain-panel-answer">
            <em>Thinking…</em>
          </div>
        )}
        {answer && (
          <div className="brain-panel-answer">
            <strong>Q:</strong> {answer.question}
            <br />
            <strong>A:</strong> {answer.decision}
          </div>
        )}
        <div className="brain-panel-log">
          {(!status || status.log.length === 0) && (
            <p className="brain-panel-empty">No brain activity yet.</p>
          )}
          {status?.log.map((entry, i) => (
            <div key={i} className="brain-log-entry">
              <AlertTriangle
                size={11}
                aria-hidden="true"
                style={{ color: riskColor(entry.outcome) }}
              />
              <span className="brain-log-kind">[{entry.kind}]</span>{' '}
              <span>
                {entry.question} → {entry.outcome}
              </span>
            </div>
          ))}
        </div>
      </aside>
    </>
  );
}
