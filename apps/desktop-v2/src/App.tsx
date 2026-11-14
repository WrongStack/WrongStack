import { ExternalLink, Moon, Plus, Radio, Sun, X } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { Trans } from 'react-i18next';
import { useDesktopText } from './desktop-i18n';
import { FleetPanel } from './FleetPanel';
import { sessionTitle } from './model';
import { NotificationMenu } from './NotificationMenu';
import { useNotificationFeed } from './notification-feed';
import { ProjectViews } from './ProjectViews';
import { native, openProjectWindow } from './platform';
import { RenderErrorBoundary } from './RenderErrorBoundary';
import { Sidebar } from './Sidebar';
import { SurfaceLanguageSync } from './SurfaceLanguageSync';
import { useShownSettingsSection } from './settings-section-request';
import { cachedLanguage, surfaceI18n } from './surface-i18n';
import { useDesktop } from './useDesktop';
import { WorkspaceDialogs } from './WorkspaceDialogs';

const SessionWorkbench = lazy(() =>
  import('./SessionWorkbench').then((module) => ({ default: module.SessionWorkbench })),
);
const ProjectWorkspace = lazy(() =>
  import('./ProjectWorkspace').then((module) => ({ default: module.ProjectWorkspace })),
);
const WrongStackSettings = lazy(() =>
  import('./WrongStackSettings').then((module) => ({ default: module.WrongStackSettings })),
);
export function App() {
  const vm = useDesktop();
  const { t } = useDesktopText();
  // Plan quota is a settings section with its own rail button: the title names it too.
  const settingsTitle = t(useShownSettingsSection() === 'quota' ? 'rail.quota' : 'rail.settings');
  // The display language is read from the profile once; afterwards the remembered one opens.
  const [readLanguage, setReadLanguage] = useState(() => native && cachedLanguage() === null);
  const {
    snapshot,
    setProject,
    section,
    setSection,
    setFilter,
    error,
    setError,
    connected,
    pending,
    run,
    newSession,
    currentProject,
    attention,
    currentSession,
    setSelected,
  } = vm;
  useNotificationFeed(error, snapshot.sessions);
  const focused = section === 'fleet' && currentSession !== undefined;
  return (
    <div className="app-shell">
      {readLanguage && <SurfaceLanguageSync onKnown={() => setReadLanguage(false)} />}
      <Sidebar vm={vm} />
      <div
        className={`workspace-shell ${focused ? 'workspace-focused' : ''} ${section === 'project' ? 'project-focused' : ''} ${section === 'wrongstack' ? 'settings-focused' : ''}`}
      >
        <header className="topbar">
          <h1 className="topbar-title">
            {focused ? (
              <>
                <span className="topbar-context">{currentProject?.name}</span>
                <span className="breadcrumb-session">
                  {sessionTitle(currentSession, t('workbench.untitled'))}
                </span>
              </>
            ) : section === 'wrongstack' ? (
              settingsTitle
            ) : section === 'project' && currentProject ? (
              currentProject.name
            ) : (
              {
                fleet: t('rail.missionControl'),
                projects: t('rail.projects'),
                activity: t('rail.activity'),
                engine: t('rail.appearance'),
                project: t('topbar.project'),
                wrongstack: t('rail.settings'),
              }[section]
            )}
          </h1>
          <div className="topbar-right">
            {currentProject && !focused && section !== 'wrongstack' && (
              <button
                type="button"
                className="icon-button"
                title={t('topbar.openInWindow')}
                aria-label={t('topbar.projectWindow')}
                onClick={() => void run(() => openProjectWindow(currentProject.id))}
              >
                <ExternalLink size={15} />
              </button>
            )}
            {section !== 'wrongstack' && section !== 'engine' && (
              <button
                type="button"
                className="button secondary small"
                disabled={!native || !snapshot.projects.length || pending}
                onClick={() => newSession()}
              >
                <Plus size={14} />
                {t('topbar.newSession')}
              </button>
            )}
            <button
              type="button"
              className="icon-button"
              title={t(vm.mode === 'dark' ? 'topbar.toLight' : 'topbar.toDark')}
              aria-label={t(vm.mode === 'dark' ? 'topbar.toLight' : 'topbar.toDark')}
              onClick={() => vm.changeAppearance({ mode: vm.mode === 'dark' ? 'light' : 'dark' })}
            >
              {vm.mode === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <NotificationMenu
              attention={attention.length}
              onAttention={() => {
                setFilter('attention');
                setProject(null);
                setSection('fleet');
                setSelected(null);
              }}
            />
            <span
              className={`connection-dot ${connected ? 'running' : 'stopped'}`}
              role="status"
              title={t(connected ? 'topbar.connected' : 'topbar.disconnected')}
              aria-label={t(connected ? 'topbar.connected' : 'topbar.disconnected')}
            />
          </div>
        </header>
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button
              type="button"
              aria-label={t('topbar.dismissError')}
              onClick={() => setError('')}
            >
              <X size={15} />
            </button>
          </div>
        )}
        {!native && (
          <div className="preview-banner">
            <Radio size={15} />{' '}
            <Trans
              i18n={surfaceI18n}
              ns="desktop"
              i18nKey="topbar.preview"
              components={{ code: <code /> }}
            />
          </div>
        )}
        <main className="main-content">
          <RenderErrorBoundary
            key={`${section}:${vm.project ?? ''}:${currentSession?.id ?? ''}:${vm.projectPage}`}
            onHome={() => {
              setSection('fleet');
              setSelected(null);
              setProject(null);
            }}
          >
            <Suspense fallback={<div className="runtime-state">{t('topbar.opening')}</div>}>
              {section === 'fleet' &&
                (focused ? <SessionWorkbench vm={vm} /> : <FleetPanel vm={vm} />)}
              <ProjectViews vm={vm} />
              {section === 'project' && currentProject && (
                <ProjectWorkspace key={currentProject.id} project={currentProject} vm={vm} />
              )}
              {section === 'wrongstack' && <WrongStackSettings vm={vm} />}
            </Suspense>
          </RenderErrorBoundary>
        </main>
      </div>
      <WorkspaceDialogs vm={vm} />
    </div>
  );
}
