import { Folder, Terminal, Workflow } from 'lucide-react';
import { useDesktopText } from './desktop-i18n';
import { desktopVersion } from './desktop-version';
import { type Project, type Session, sessionTitle } from './model';
import './desktop-chrome.css';

export function DesktopStatusBar({
  project,
  session,
  connected,
  liveCount,
  onShowLive,
}: {
  project: Project | undefined;
  session: Session | undefined;
  connected: boolean;
  liveCount: number;
  onShowLive: () => void;
}) {
  const { t } = useDesktopText();
  const connection = t(connected ? 'topbar.connected' : 'topbar.disconnected');
  const version = desktopVersion();
  const title = session ? sessionTitle(session, t('workbench.untitled')) : undefined;
  const SessionIcon = session?.kind === 'terminal' ? Terminal : Workflow;
  return (
    <footer className="desktop-status-bar">
      <div className="desktop-status-context">
        <span title={project?.root}>
          <Folder size={13} aria-hidden="true" />
          <span>{project?.name ?? t('rail.missionControl')}</span>
        </span>
        {title && (
          <span className="desktop-status-session" title={title}>
            <SessionIcon size={13} aria-hidden="true" />
            <span>{title}</span>
          </span>
        )}
      </div>
      <div className="desktop-status-meta">
        {version && <span className="desktop-status-version">v{version}</span>}
        {liveCount > 0 && (
          <button
            type="button"
            className="desktop-status-live"
            title={t('topbar.liveTitle')}
            onClick={onShowLive}
          >
            {t('topbar.live', { count: liveCount })}
          </button>
        )}
        <span
          className="desktop-status-connection"
          role="status"
          aria-label={connection}
          title={connection}
          data-connected={connected}
        >
          <i aria-hidden="true" />
          <span>{connection}</span>
        </span>
      </div>
    </footer>
  );
}
