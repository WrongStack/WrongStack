import {
  AlertTriangle,
  Ban,
  Brain,
  CircleCheck,
  HandHelping,
  Shield,
  Users,
  X,
  Zap,
} from 'lucide-react';
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
  /** Which tier of the ladder decided — free deterministic, or a model call. */
  tier?: string | undefined;
}

interface BrainStatus {
  maxAutoRisk: string;
  log: BrainLogEntry[];
}

interface BrainAnswer {
  question: string;
  decision: string;
  kind: 'answer' | 'deny' | 'ask_human';
}

/** Tiers that reached a verdict without any provider call. */
const FREE_TIERS = new Set(['rule', 'policy', 'heuristic', 'cache', 'ledger-guard', 'terminal']);

/**
 * Icon and colour for a log row.
 *
 * Keyed on the row's KIND. It used to be keyed on `outcome`, which is free
 * text (a deny reason, an option id, "steered the agent"), so it never
 * matched a risk level and every row got the same amber warning triangle —
 * a routine answered decision looked exactly like a denial.
 */
function logRowStyle(kind: string): { Icon: typeof Brain; color: string } {
  switch (kind) {
    case 'answered':
      return { Icon: CircleCheck, color: 'var(--success)' };
    case 'denied':
      return { Icon: Ban, color: 'var(--danger)' };
    case 'ask_human':
      return { Icon: HandHelping, color: 'var(--warning)' };
    case 'intervention':
      return { Icon: Zap, color: 'var(--warning)' };
    case 'council_warn':
      return { Icon: Users, color: 'var(--danger)' };
    default:
      return { Icon: AlertTriangle, color: 'var(--warning)' };
  }
}

/** `decision` arrives as the raw BrainDecision union. */
function readDecision(raw: unknown): { text: string; kind: BrainAnswer['kind'] } {
  const d = raw as Record<string, unknown> | undefined;
  const type = typeof d?.type === 'string' ? d.type : '';
  if (type === 'deny') {
    return { text: String(d?.reason ?? 'Denied.'), kind: 'deny' };
  }
  if (type === 'ask_human') {
    return { text: String(d?.prompt ?? 'The Brain escalated this to a human.'), kind: 'ask_human' };
  }
  // An `answer` carries its verdict in `text`/`optionId`. Reading `reason`
  // first and falling back to `type` printed the literal word "answer" as
  // the reply to every successful question.
  // The trailing `reason`/`prompt` fallbacks keep an UNDISCRIMINATED payload
  // readable: a decision that arrives without its `type` (an older host, a
  // hand-built reply) still shows whatever text it does carry instead of a
  // generic placeholder.
  const text = d?.text ?? d?.optionId ?? d?.reason ?? d?.prompt;
  const rationale = typeof d?.rationale === 'string' ? d.rationale.trim() : '';
  const body = String(text ?? (typeof raw === 'string' ? raw : 'Decided.'));
  return { text: rationale ? `${body}\n${rationale}` : body, kind: 'answer' };
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
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
      }
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
      const parsed = readDecision(p.decision);
      setAnswer({
        question: String(p.question ?? ''),
        decision: parsed.text,
        kind: parsed.kind,
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
          <div
            className="brain-panel-answer"
            style={{
              borderLeft: `2px solid ${
                answer.kind === 'deny'
                  ? 'var(--danger)'
                  : answer.kind === 'ask_human'
                    ? 'var(--warning)'
                    : 'var(--success)'
              }`,
              paddingLeft: 6,
            }}
          >
            <strong>Q:</strong> {answer.question}
            <br />
            <strong>A:</strong> <span style={{ whiteSpace: 'pre-wrap' }}>{answer.decision}</span>
          </div>
        )}
        <div className="brain-panel-log">
          {(!status || status.log.length === 0) && (
            <p className="brain-panel-empty">No brain activity yet.</p>
          )}
          {status?.log.map((entry) => {
            const { Icon, color } = logRowStyle(entry.kind);
            return (
              // Keyed on the decision itself, not the array index: the log is
              // a ring buffer, so index keys re-label every row on each shift.
              <div key={`${entry.at}-${entry.kind}-${entry.question}`} className="brain-log-entry">
                <Icon size={11} aria-hidden="true" style={{ color }} />
                <span className="brain-log-kind">[{entry.kind}]</span>{' '}
                {/* Which tier decided: a free rule hit and a multi-model
                    council call are otherwise the same row. */}
                {entry.tier ? (
                  <span
                    className="brain-log-kind"
                    style={{ opacity: FREE_TIERS.has(entry.tier) ? 0.55 : 1 }}
                    title={
                      FREE_TIERS.has(entry.tier)
                        ? 'Decided without any provider call'
                        : 'Cost at least one provider call'
                    }
                  >
                    {entry.tier}
                  </span>
                ) : null}{' '}
                <span>
                  {entry.question} → {entry.outcome}
                </span>
              </div>
            );
          })}
        </div>
      </aside>
    </>
  );
}
