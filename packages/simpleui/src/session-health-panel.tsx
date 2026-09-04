import { Activity, ChevronRight, Clock, Cpu, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useFocusTrap } from './hooks/use-focus-trap.js';
import { onSimplePanel } from './lib/panel-events.js';
import { formatUptime } from './lib/session-helpers.js';
import type { ChatMessage, ContextInfo } from './types.js';

interface SessionHealthPanelProps {
  context: ContextInfo;
  messages: ChatMessage[];
  sessionStart: number | null;
  /** Drill into the token breakdown modal from any of the stat rows. */
  onOpenContextBreakdown: () => void;
}

export function SessionHealthPanel({
  context,
  messages,
  sessionStart,
  onOpenContextBreakdown,
}: SessionHealthPanelProps) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  useFocusTrap(dialogRef, open);

  useEffect(() => {
    if (!open) return;
    // Reset the clock snapshot at open time — `now` otherwise still holds the
    // app-mount value and the uptime reads short until the first 1s tick.
    setNow(Date.now());
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      document.removeEventListener('keydown', onKey);
      clearInterval(timer);
    };
  }, [open]);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    return onSimplePanel('open-session-health', onOpen);
  }, []);

  const ctxPct =
    context.maxContext > 0 ? Math.round((context.tokens / context.maxContext) * 100) : 0;

  const drillIntoBreakdown = () => {
    // Close the panel so the centered details modal is unobstructed.
    setOpen(false);
    onOpenContextBreakdown();
  };

  if (!open) {
    return (
      <button
        type="button"
        className="health-panel-trigger"
        title="Session health"
        aria-label="Open session health panel"
        onClick={() => setOpen(true)}
      >
        <Activity size={13} aria-hidden="true" />
        <span className="health-pct">{ctxPct}%</span>
      </button>
    );
  }

  // These scan the full message array — only needed once the panel is open, so
  // they must stay below the collapsed-state early return. The parent re-renders
  // on every stream delta; computing them above the guard did 3 O(n) scans per
  // token while the panel was closed.
  const uptime = sessionStart ? now - sessionStart : 0;
  let userMsgs = 0;
  let assistantMsgs = 0;
  let thinkingMsgs = 0;
  for (const m of messages) {
    if (m.role === 'user') userMsgs++;
    else if (m.role === 'assistant') assistantMsgs++;
    else if (m.role === 'thinking') thinkingMsgs++;
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
        className="health-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Session health"
        ref={dialogRef}
        tabIndex={-1}
      >
        <header className="health-panel-head">
          <span>
            <Activity size={13} aria-hidden="true" /> HEALTH
          </span>
          <button type="button" onClick={() => setOpen(false)} aria-label="Close" ref={closeRef}>
            <X size={14} />
          </button>
        </header>
        <div className="health-panel-body">
          <button
            type="button"
            className="health-stat health-stat-action"
            onClick={drillIntoBreakdown}
            title="View session uptime details"
            aria-label="Open session uptime details"
          >
            <Clock size={14} aria-hidden="true" />
            <div>
              <strong>Uptime</strong>
              <span>{formatUptime(uptime)}</span>
            </div>
            <ChevronRight size={12} className="health-stat-chevron" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="health-stat health-stat-action"
            onClick={drillIntoBreakdown}
            title="View token breakdown"
            aria-label="Open context breakdown"
          >
            <Cpu size={14} aria-hidden="true" />
            <div>
              <strong>Context</strong>
              <span>
                {(context.tokens ?? 0).toLocaleString()} /{' '}
                {(context.maxContext ?? 0).toLocaleString()} tokens ({ctxPct}%)
              </span>
            </div>
            <ChevronRight size={12} className="health-stat-chevron" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="health-stat health-stat-action"
            onClick={drillIntoBreakdown}
            title="View message breakdown"
            aria-label="Open message breakdown"
          >
            <Activity size={14} aria-hidden="true" />
            <div>
              <strong>Messages</strong>
              <span>
                {userMsgs} user · {assistantMsgs} assistant · {thinkingMsgs} thinking
              </span>
            </div>
            <ChevronRight size={12} className="health-stat-chevron" aria-hidden="true" />
          </button>
        </div>
      </aside>
    </>
  );
}
