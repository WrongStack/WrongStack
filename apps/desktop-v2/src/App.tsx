import { Bell, ExternalLink, Moon, Plus, Radio, Sun, X } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { FleetPanel } from './FleetPanel';
import { ProjectViews } from './ProjectViews';
import { native, openProjectWindow } from './platform';
import { Sidebar } from './Sidebar';
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
  const focused = section === 'fleet' && currentSession !== undefined;
  return (
    <div className="app-shell">
      <Sidebar vm={vm} />
      <div
        className={`workspace-shell ${focused ? 'workspace-focused' : ''} ${section === 'project' ? 'project-focused' : ''} ${section === 'wrongstack' ? 'settings-focused' : ''}`}
      >
        <header className="topbar">
          <h1 className="topbar-title">
            {focused ? (
              <>
                <span className="topbar-context">{currentProject?.name}</span>
                <span className="breadcrumb-session">{currentSession.title}</span>
              </>
            ) : section === 'wrongstack' ? (
              'WrongStack settings'
            ) : section === 'project' && currentProject ? (
              currentProject.name
            ) : (
              {
                fleet: 'Mission control',
                projects: 'Projects',
                activity: 'Activity',
                engine: 'Appearance',
                project: 'Project',
                wrongstack: 'WrongStack settings',
              }[section]
            )}
          </h1>
          <div className="topbar-right">
            {currentProject && !focused && section !== 'wrongstack' && (
              <button
                type="button"
                className="icon-button"
                title="Open in its own window"
                aria-label="Project window"
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
                New session
              </button>
            )}
            <button
              type="button"
              className="icon-button"
              title={`Switch to ${vm.mode === 'dark' ? 'light' : 'dark'} mode`}
              aria-label={`Switch to ${vm.mode === 'dark' ? 'light' : 'dark'} mode`}
              onClick={() => vm.changeAppearance({ mode: vm.mode === 'dark' ? 'light' : 'dark' })}
            >
              {vm.mode === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <button
              type="button"
              className="icon-button"
              title="Sessions needing attention"
              aria-label="Sessions needing attention"
              onClick={() => {
                setFilter('attention');
                setProject(null);
                setSection('fleet');
                setSelected(null);
              }}
            >
              <Bell size={16} />
              {attention.length > 0 && <span className="notification-dot" />}
            </button>
            <span
              className={`connection-dot ${connected ? 'running' : 'stopped'}`}
              role="status"
              title={connected ? 'Local engine connected' : 'Local engine disconnected'}
              aria-label={connected ? 'Local engine connected' : 'Local engine disconnected'}
            />
          </div>
        </header>
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button type="button" aria-label="Dismiss error" onClick={() => setError('')}>
              <X size={15} />
            </button>
          </div>
        )}
        {!native && (
          <div className="preview-banner">
            <Radio size={15} /> Shell preview · Launch with <code>bun run desktop:v2</code> to
            connect your local projects and sessions.
          </div>
        )}
        <main className="main-content">
          <Suspense fallback={<div className="runtime-state">Opening your workspace…</div>}>
            {section === 'fleet' &&
              (focused ? <SessionWorkbench vm={vm} /> : <FleetPanel vm={vm} />)}
            <ProjectViews vm={vm} />
            {section === 'project' && currentProject && (
              <ProjectWorkspace key={currentProject.id} project={currentProject} vm={vm} />
            )}
            {section === 'wrongstack' && <WrongStackSettings vm={vm} />}
          </Suspense>
        </main>
      </div>
      <WorkspaceDialogs vm={vm} />
    </div>
  );
}
