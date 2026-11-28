import { Folder } from 'lucide-react';
import { useDesktopText } from './desktop-i18n';
import { desktopVersion } from './desktop-version';
import type { Project } from './model';
import './desktop-chrome.css';

/**
 * The window's bottom line: where the open project lives on disk, then the version, the live
 * sessions and the engine connection. The project's and session's names are the top bar's; the
 * status bar repeated them (and said "Mission control" on Settings and Appearance).
 */
export function DesktopStatusBar({
  project,
  connected,
  liveCount,
  onShowLive,
}: {
  project: Project | undefined;
  connected: boolean;
  liveCount: number;
  onShowLive: () => void;
}) {
  const { t } = useDesktopText();
  const connection = t(connected ? 'topbar.connected' : 'topbar.disconnected');
  const version = desktopVersion();
  return (
    <footer className="desktop-status-bar">
      <div className="desktop-status-context">
        {project?.root && (
          <span title={project.root}>
            <Folder size={13} aria-hidden="true" />
            <span>{project.root}</span>
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
