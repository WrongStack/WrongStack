import { ExternalLink, Moon, Plus, Radio, Sun, X } from 'lucide-react';
import { type CSSProperties, lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Trans } from 'react-i18next';
import { DesktopStatusBar } from './DesktopStatusBar';
import { useDesktopText } from './desktop-i18n';
import { FleetPanel } from './FleetPanel';
import { HostBuildNotice } from './HostBuildNotice';
import { sessionTitle } from './model';
import { NotificationMenu } from './NotificationMenu';
import { useNotificationFeed } from './notification-feed';
import { OfficeShortcut } from './OfficeShortcut';
import { PaneLayoutDialog } from './PaneLayoutDialog';
import { ProjectViews } from './ProjectViews';
import { PaneLayoutProvider } from './pane-layout-context';
import { layoutKey, native, openProjectWindow } from './platform';
import { RenderErrorBoundary } from './RenderErrorBoundary';
import { Sidebar } from './Sidebar';
import { SurfaceLanguageSync } from './SurfaceLanguageSync';
import { useShownSettingsSection } from './settings-section-request';
import { cachedLanguage, surfaceI18n } from './surface-i18n';
import { UpdateNotice } from './UpdateNotice';
import { useDesktop } from './useDesktop';
import { useWorkbenchExplorer } from './useWorkbenchExplorer';
import { WindowsTitleBar } from './WindowsTitleBar';
import { WorkbenchMenu } from './WorkbenchMenu';
import { HostedTerminal, TerminalDock } from './WorkbenchTerminals';
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
  const [layoutOpen, setLayoutOpen] = useState(false);
  return (
    <PaneLayoutProvider scope={layoutKey ?? 'layout'} showSettings={() => setLayoutOpen(true)}>
      <DesktopShell />
      {layoutOpen && <PaneLayoutDialog onClose={() => setLayoutOpen(false)} />}
    </PaneLayoutProvider>
  );
}

function DesktopShell() {
  const vm = useDesktop();
  const { t } = useDesktopText();
  // Plan quota is a settings section with its own rail button: the title names it too.
  const settingsTitle = t(useShownSettingsSection() === 'quota' ? 'rail.quota' : 'rail.settings');
  // Use the remembered language (or English) at launch. Read the profile when settings opens,
  // rather than booting an entire settings engine just to learn its display language.
  const [readLanguage, setReadLanguage] = useState(() => native && cachedLanguage() === null);
  const [customCaption, setCustomCaption] = useState(false);
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
  const [dock, setDock] = useState<{ id: string; open: boolean }>();
  const [tabSlot, setTabSlot] = useState<HTMLDivElement | null>(null);
  const [dockSlot, setDockSlot] = useState<HTMLDivElement | null>(null);
  // Only explicit placement changes request focus; merely revisiting the project does not.
  const terminalFocus = useRef<{ id: string; placement: 'dock' | 'tab' } | null>(null);
  const focusTerminalControl = (
    button: HTMLButtonElement | null,
    id: string,
    placement: 'dock' | 'tab',
  ) => {
    if (
      button &&
      terminalFocus.current?.id === id &&
      terminalFocus.current.placement === placement
    ) {
      terminalFocus.current = null;
      button.focus({ preventScroll: true });
    }
  };
  const dockId = dock?.id;
  const dockAttached = dockId !== undefined && vm.openSessionIds?.includes(dockId);
  useEffect(() => {
    if (dockId && !dockAttached) setDock(undefined);
  }, [dockId, dockAttached]);
  const docked =
    dock &&
    snapshot.sessions.find(
      (session) =>
        session.kind === 'terminal' &&
        session.id === dock.id &&
        vm.openSessionIds.includes(session.id),
    );
  const tabTerminal = focused && currentSession?.kind === 'terminal' ? currentSession : undefined;
  const lastConversation = useRef<string | null>(null);
  const conversationId = focused && currentSession?.kind === 'agent' ? currentSession.id : null;
  useEffect(() => {
    if (conversationId) lastConversation.current = conversationId;
  }, [conversationId]);
  const dockTerminal = (terminal: NonNullable<typeof tabTerminal>) => {
    terminalFocus.current = { id: terminal.id, placement: 'dock' };
    setDock({ id: terminal.id, open: true });
    const previous = snapshot.sessions.find(
      (session) =>
        session.id === lastConversation.current &&
        session.kind === 'agent' &&
        session.projectId === terminal.projectId &&
        vm.openSessionIds.includes(session.id),
    );
    if (previous) vm.jumpToSession(previous);
    else vm.openProjectPage(terminal.projectId, 'files');
  };
  const dockVisible =
    docked && (focused || section === 'project') && currentProject?.id === docked.projectId;
  const terminals =
    docked && docked.id !== tabTerminal?.id
      ? tabTerminal
        ? [docked, tabTerminal]
        : [docked]
      : tabTerminal
        ? [tabTerminal]
        : [];
  const explorer = useWorkbenchExplorer(
    JSON.stringify([section, vm.project, vm.selected, vm.projectPage]),
  );
  return (
    <div
      className="app-shell"
      data-custom-caption={customCaption}
      style={{ '--explorer-width': `${explorer.width ?? 220}px` } as CSSProperties}
    >
      {readLanguage && section === 'wrongstack' && (
        <SurfaceLanguageSync onKnown={() => setReadLanguage(false)} />
      )}
      <WindowsTitleBar onActiveChange={setCustomCaption} />
      <Sidebar vm={vm} explorer={explorer} />
      <div
        className={`workspace-shell ${focused ? 'workspace-focused' : ''} ${section === 'project' ? 'project-focused' : ''} ${section === 'wrongstack' ? 'settings-focused' : ''}`}
      >
        <header className="topbar">
          <WorkbenchMenu vm={vm} explorer={explorer} />
          <h1 className="topbar-title">
            {focused
              ? (currentProject?.name ?? t('rail.missionControl'))
              : section === 'wrongstack'
                ? settingsTitle
                : section === 'project' && currentProject
                  ? currentProject.name
                  : {
                      fleet: t('rail.missionControl'),
                      projects: t('rail.projects'),
                      activity: t('rail.activity'),
                      engine: t('rail.appearance'),
                      project: t('topbar.project'),
                      wrongstack: t('rail.settings'),
                    }[section]}
          </h1>
          {/* The open session, named after the project the title already gives. */}
          {focused && currentSession && (
            <span className="topbar-context">
              {sessionTitle(currentSession, t('workbench.untitled'))}
            </span>
          )}
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
                aria-label={t('topbar.newSession')}
                title={t('topbar.newSession')}
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
            <OfficeShortcut vm={vm} />
            <NotificationMenu
              attention={attention.length}
              onAttention={() => {
                setFilter('attention');
                setProject(null);
                setSection('fleet');
                setSelected(null);
              }}
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
        <HostBuildNotice />
        <UpdateNotice />
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
            resetKey={`${section}:${vm.project ?? ''}:${currentSession?.id ?? ''}:${vm.projectPage}`}
            onHome={() => {
              setSection('fleet');
              setSelected(null);
              setProject(null);
            }}
          >
            <Suspense fallback={<div className="runtime-state">{t('topbar.opening')}</div>}>
              {section === 'fleet' &&
                (focused ? (
                  <SessionWorkbench
                    vm={vm}
                    terminal={{
                      setSlot: setTabSlot,
                      dock: tabTerminal && !docked ? () => dockTerminal(tabTerminal) : undefined,
                      dockButtonRef: (button) => {
                        if (tabTerminal) focusTerminalControl(button, tabTerminal.id, 'tab');
                      },
                      docked: Boolean(docked && docked.id === tabTerminal?.id),
                    }}
                  />
                ) : (
                  <FleetPanel vm={vm} />
                ))}
              <ProjectViews vm={vm} />
              {section === 'project' && currentProject && (
                <ProjectWorkspace key={currentProject.id} project={currentProject} vm={vm} />
              )}
              {section === 'wrongstack' && <WrongStackSettings vm={vm} />}
            </Suspense>
          </RenderErrorBoundary>
        </main>
        {dockVisible && (
          <TerminalDock
            session={docked}
            open={dock?.open === true}
            setSlot={setDockSlot}
            toggleButtonRef={(button) => focusTerminalControl(button, docked.id, 'dock')}
            toggle={() => setDock((previous) => previous && { ...previous, open: !previous.open })}
            undock={() => {
              terminalFocus.current = { id: docked.id, placement: 'tab' };
              setDock(undefined);
              vm.jumpToSession(docked);
            }}
          />
        )}
        {terminals.map((session) => (
          <HostedTerminal
            key={session.id}
            session={session}
            slot={session.id === docked?.id ? (dockVisible ? dockSlot : null) : tabSlot}
            onError={vm.reportError}
            autoFocus={session.id !== docked?.id}
          />
        ))}
      </div>
      <DesktopStatusBar
        project={section !== 'wrongstack' && section !== 'engine' ? currentProject : undefined}
        session={focused ? currentSession : undefined}
        connected={connected}
        liveCount={vm.active.length}
        onShowLive={() => {
          setFilter('active');
          setProject(null);
          setSection('fleet');
          setSelected(null);
        }}
      />
      <WorkspaceDialogs vm={vm} />
    </div>
  );
}
