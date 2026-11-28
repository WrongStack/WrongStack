import { LoaderCircle, MessageSquare, Square, SquareTerminal, Trash2 } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import { Modal } from './Modal';
import { compactAge } from './mark-hue';
import { isLive, type Session, sessionStatus, sessionTitle } from './model';
import { request } from './platform';
import './sidebar-sessions.css';

/** A session host started before `session.remove` existed answers with this. */
const olderHost = (error: unknown) =>
  String(error instanceof Error ? error.message : error).includes('Unknown method');

/**
 * A session under its project in the sidebar. It opens the session as a tab; a running one can
 * be stopped from here, and any one removed after asking. A stopped agent conversation opens
 * where it left off (the tab offers to reconnect it).
 */
export function SidebarSessionRow({
  session,
  chosen,
  disabled,
  onOpen,
  run,
  onRemoved,
}: {
  session: Session;
  chosen: boolean;
  disabled: boolean;
  onOpen: (session: Session) => void;
  /** Runs a host request, reports its failure and refreshes the workspace. */
  run: (action: () => Promise<unknown>, options?: { background?: boolean }) => Promise<void>;
  /** The session is gone: drop its tab. */
  onRemoved: (id: string) => void;
}) {
  const { t } = useDesktopText();
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const removeLock = useRef(false);
  const removed = useRef(onRemoved);
  removed.current = onRemoved;
  const title = sessionTitle(session, t('workbench.untitled'));
  const state = sessionStatus(session);
  const metaId = useId();
  const remove = async () => {
    if (removeLock.current) return;
    removeLock.current = true;
    setRemoving(true);
    setConfirming(false);
    try {
      await run(
        async () => {
          try {
            await request('session.remove', { id: session.id });
          } catch (error) {
            throw olderHost(error) ? new Error(t('explorer.olderHost')) : error;
          }
          removed.current(session.id);
        },
        { background: true },
      );
    } finally {
      removeLock.current = false;
      setRemoving(false);
    }
  };
  return (
    <div className={`tree-session-row ${chosen ? 'chosen' : ''}`} aria-busy={removing || undefined}>
      <button
        type="button"
        className={`tree-session ${chosen ? 'chosen' : ''}`}
        aria-current={chosen ? 'page' : undefined}
        aria-describedby={metaId}
        disabled={removing}
        onClick={() => onOpen(session)}
      >
        <span className="tree-session-icon" aria-hidden="true">
          {session.kind === 'terminal' ? <SquareTerminal size={15} /> : <MessageSquare size={14} />}
          <span className={`status-dot ${session.status}`} />
        </span>
        <span className="tree-session-text">
          <span className="tree-session-title" title={title}>
            {title}
          </span>
          {/* Status and age under the name; the row's accessible name stays the title. */}
          <span id={metaId} className={`tree-session-meta is-${state}`}>
            <span>{t(`fleetView.status.${state}`)}</span>
            <span aria-hidden="true">·</span>
            <time dateTime={new Date(session.updatedAt).toISOString()}>
              {compactAge(session.updatedAt, (key, count) => t(`explorer.age.${key}`, { count }))}
            </time>
          </span>
        </span>
        {session.kind === 'terminal' && (
          <span className="project-menu-sr">{t('explorer.terminal')}</span>
        )}
      </button>
      <span className="tree-session-actions">
        {isLive(session) && (
          <button
            type="button"
            className="icon-button"
            aria-label={t('explorer.stop', { title })}
            title={t('explorer.stop', { title })}
            disabled={disabled || removing}
            onClick={() => void run(() => request('session.kill', { id: session.id }))}
          >
            <Square size={11} />
          </button>
        )}
        <button
          type="button"
          className="icon-button danger"
          aria-label={t('explorer.remove', { title })}
          title={t('explorer.remove', { title })}
          disabled={disabled || removing}
          onClick={() => setConfirming(true)}
        >
          {removing ? <LoaderCircle size={12} className="spin" /> : <Trash2 size={12} />}
        </button>
      </span>
      {confirming && (
        <Modal title={t('explorer.removeTitle', { title })} onClose={() => setConfirming(false)}>
          <h2 className="session-remove-title">
            <span className="session-remove-icon" aria-hidden="true">
              <Trash2 size={16} />
            </span>
            {t('explorer.removeTitle', { title })}
          </h2>
          <p className="session-remove-body">{t('explorer.removeBody')}</p>
          <div className="session-remove-actions">
            <button type="button" className="button secondary" onClick={() => setConfirming(false)}>
              {t('explorer.cancel')}
            </button>
            <button type="button" className="button primary danger" onClick={() => void remove()}>
              {t('explorer.removeConfirm')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
