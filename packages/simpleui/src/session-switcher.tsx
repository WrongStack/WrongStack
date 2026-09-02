import { Check, ChevronDown, History, Plus } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFocusTrap } from './hooks/use-focus-trap.js';
import { relativeSessionTime, sessionDisplayName } from './lib/session-model.js';
import type { SessionInfo, SimpleSessionSummary } from './types.js';

export interface SessionSwitcherProps {
  session: SessionInfo | null;
  sessions: SimpleSessionSummary[];
  running: boolean;
  /** Called the first time the dropdown opens in this session (triggers
   *  `sessions.list` from the server). */
  onRefreshSessions: () => void;
  onCreateSession: () => void;
  onResumeSession: (id: string) => void;
}

export function SessionSwitcher(props: SessionSwitcherProps): React.JSX.Element {
  const { session, sessions, running, onRefreshSessions, onCreateSession, onResumeSession } = props;
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const refreshedRef = useRef(false);
  const dialogRef = useRef<HTMLElement | null>(null);
  useFocusTrap(dialogRef, open);

  const currentSummary = useMemo(() => sessions.find((item) => item.isCurrent), [sessions]);
  const currentName = sessionDisplayName(currentSummary, session?.id ?? undefined);

  // Outside-click closes the dropdown.
  useEffect(() => {
    if (!open) return;
    const handler = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [open]);

  // Request sessions.list on first open only.
  const handleTriggerClick = () => {
    if (!open && session) {
      if (!refreshedRef.current) {
        refreshedRef.current = true;
        onRefreshSessions();
      }
    }
    setOpen((current) => !current);
  };

  const handleCreate = () => {
    setOpen(false);
    onCreateSession();
  };

  const handleResume = (id: string) => {
    setOpen(false);
    onResumeSession(id);
  };

  return (
    <div className="session-switcher" ref={containerRef}>
      <button
        type="button"
        className="session-trigger"
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={!session || running}
        onClick={handleTriggerClick}
        title={session ? currentName : 'Connecting…'}
      >
        <History size={11} aria-hidden="true" />
        <span>{session ? currentName : 'Connecting…'}</span>
        <ChevronDown size={11} aria-hidden="true" />
      </button>
      {open && (
        <section
          className="session-menu"
          role="dialog"
          aria-label="Recent sessions"
          ref={dialogRef}
          tabIndex={-1}
        >
          <div className="session-menu-heading">
            <span>RECENT SESSIONS</span>
            <button type="button" disabled={running} onClick={handleCreate}>
              <Plus size={11} aria-hidden="true" />
              NEW
            </button>
          </div>
          <div className="session-menu-list">
            {sessions.length === 0 ? (
              <div className="session-menu-empty">No saved sessions yet</div>
            ) : (
              sessions.slice(0, 12).map((item) => {
                const active = item.isCurrent || item.id === session?.id;
                return (
                  <button
                    type="button"
                    className={active ? 'active' : undefined}
                    aria-current={active ? 'page' : undefined}
                    disabled={active || running}
                    key={item.id}
                    onClick={() => handleResume(item.id)}
                  >
                    <span className="session-menu-main">
                      {active ? (
                        <Check size={12} aria-hidden="true" />
                      ) : (
                        <History size={12} aria-hidden="true" />
                      )}
                      <span className="session-menu-copy">
                        <b>{sessionDisplayName(item)}</b>
                        {item.lastUserMessage ? (
                          <small title={item.lastUserMessage}>{item.lastUserMessage}</small>
                        ) : null}
                        <small>
                          {[
                            item.provider,
                            item.model,
                            (item.messageCount ?? 0) > 0 ? `${item.messageCount} msg` : '',
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </small>
                      </span>
                    </span>
                    <time dateTime={item.lastActivityAt ?? item.startedAt}>
                      {relativeSessionTime(item.lastActivityAt ?? item.startedAt)}
                    </time>
                  </button>
                );
              })
            )}
          </div>
        </section>
      )}
    </div>
  );
}
