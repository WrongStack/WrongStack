import { Activity, Clock, Cpu, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ChatMessage, ContextInfo } from './types.js';

interface SessionHealthPanelProps {
  context: ContextInfo;
  messages: ChatMessage[];
  sessionStart: number | null;
}

function formatUptime(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

export function SessionHealthPanel({ context, messages, sessionStart }: SessionHealthPanelProps) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { document.removeEventListener('keydown', onKey); clearInterval(timer); };
  }, [open]);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener('simpleui:open-session-health', onOpen);
    return () => window.removeEventListener('simpleui:open-session-health', onOpen);
  }, []);

  const ctxPct = context.maxContext > 0 ? Math.round((context.tokens / context.maxContext) * 100) : 0;

  if (!open) {
    return (
      <button type="button" className="health-panel-trigger" title="Session health"
        aria-label="Open session health panel" onClick={() => setOpen(true)}>
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
      <button type="button" className="settings-overlay" tabIndex={-1} onClick={() => setOpen(false)} />
      <aside className="health-panel" role="dialog" aria-modal="true" aria-label="Session health">
        <header className="health-panel-head">
          <span><Activity size={13} aria-hidden="true" /> HEALTH</span>
          <button type="button" onClick={() => setOpen(false)} aria-label="Close" ref={closeRef}><X size={14} /></button>
        </header>
        <div className="health-panel-body">
          <div className="health-stat">
            <Clock size={14} aria-hidden="true" />
            <div>
              <strong>Uptime</strong>
              <span>{formatUptime(uptime)}</span>
            </div>
          </div>
          <div className="health-stat">
            <Cpu size={14} aria-hidden="true" />
            <div>
              <strong>Context</strong>
              <span>{(context.tokens ?? 0).toLocaleString()} / {(context.maxContext ?? 0).toLocaleString()} tokens ({ctxPct}%)</span>
            </div>
          </div>
          <div className="health-stat">
            <Activity size={14} aria-hidden="true" />
            <div>
              <strong>Messages</strong>
              <span>{userMsgs} user · {assistantMsgs} assistant · {thinkingMsgs} thinking</span>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
