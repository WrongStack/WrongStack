import { Square, SquareTerminal, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import { Modal } from './Modal';
import { isLive, type Session, sessionTitle } from './model';
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
  run: (action: () => Promise<unknown>) => Promise<void>;
  /** The session is gone: drop its tab. */
  onRemoved: (id: string) => void;
}) {
  const { t } = useDesktopText();
  const [confirming, setConfirming] = useState(false);
  const title = sessionTitle(session, t('workbench.untitled'));
  const remove = () => {
    setConfirming(false);
    return run(async () => {
      try {
        await request('session.remove', { id: session.id });
      } catch (error) {
        throw olderHost(error) ? new Error(t('explorer.olderHost')) : error;
      }
      onRemoved(session.id);
    });
  };
  return (
    <div className={`tree-session-row ${chosen ? 'chosen' : ''}`}>
      <button
        type="button"
        className={`tree-session ${chosen ? 'chosen' : ''}`}
        onClick={() => onOpen(session)}
      >
        <span className={`status-dot ${session.status}`} />
        <span title={title}>{title}</span>
        {session.kind === 'terminal' && (
          <small className="tree-session-kind" title={t('explorer.terminal')}>
            <SquareTerminal size={12} aria-hidden="true" />
            <span className="tree-session-kind-name">{t('explorer.terminal')}</span>
          </small>
        )}
      </button>
      <span className="tree-session-actions">
        {isLive(session) && (
          <button
            type="button"
            className="icon-button"
            aria-label={t('explorer.stop', { title })}
            title={t('explorer.stop', { title })}
            disabled={disabled}
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
          disabled={disabled}
          onClick={() => setConfirming(true)}
        >
          <Trash2 size={12} />
        </button>
      </span>
      {confirming && (
        <Modal title={t('explorer.removeTitle', { title })} onClose={() => setConfirming(false)}>
          <p className="session-remove-body">{t('explorer.removeBody')}</p>
          <div className="session-remove-actions">
            <button type="button" className="button secondary" onClick={() => setConfirming(false)}>
              {t('explorer.cancel')}
            </button>
            <button type="button" className="button danger" onClick={() => void remove()}>
              {t('explorer.removeConfirm')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
