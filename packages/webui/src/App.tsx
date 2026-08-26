import { lazy, Suspense, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useDesktopBridge } from '@/hooks/useDesktopBridge';
import { useF5Resilience } from '@/hooks/useF5Resilience';
import { useGlobalKeyboardShortcuts } from '@/hooks/useGlobalKeyboardShortcuts';
import { useSessionSubscription } from '@/hooks/useSessionSubscription';
import { useViewport } from '@/hooks/useViewport';
import { useWebSocketBootstrap } from '@/hooks/useWebSocket';
import { useAppTranslation } from '@/i18n';
import { isDesktopShell } from '@/lib/desktop-shell';
import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import {
  useChatStore,
  useConfigStore,
  useFileStore,
  useFleetStore,
  useSessionStore,
  useUIStore,
} from '@/stores';
import { ActivityBar } from './components/activity-bar';
import { navigateToView, openMainView } from './components/activity-bar/nav';
import { CommandPalette } from './components/CommandPalette';
import { ConfirmDialog } from './components/ConfirmDialog';
import { ConfirmModalHost, PromptModalHost } from './components/ConfirmModal';
import { ConnectionBanner } from './components/ConnectionBanner';
import { ContextBreakdownModal } from './components/ContextBreakdownModal';
import { ErrorBoundary } from './components/ErrorBoundary';
import { FallbackModal } from './components/FallbackModal';
import { InspectorPanel } from './components/InspectorPanel';
import { PromptLibraryModal } from './components/PromptLibraryModal';
import { QuickModelSwitcher } from './components/QuickModelSwitcher';
import { SessionTabBar } from './components/SessionTabBar';
import { ShortcutsOverlay } from './components/ShortcutsOverlay';
import { SidePanel } from './components/SidePanel';
import { SystemPromptDialog } from './components/SystemPromptDialog';
import { ThemeProvider, useTheme } from './components/ThemeProvider';
import { Toaster } from './components/Toaster';
import { UpdateBanner } from './components/UpdateBanner';
import { ViewRouter } from './components/ViewRouter';
import { WorkbenchTopbar } from './components/WorkbenchTopbar';
import { WorkspaceDockInspector } from './components/WorkspaceDock';
import { useSystemPromptStore } from './stores/system-prompt-store';

// ── Lazy-loaded views ──────────────────────────────────────────────────────
// These pull heavy libraries (Monaco ~4MB, @xyflow, xterm) or are themselves
// large, and are gated behind specific `currentView` values. Code-splitting
// them keeps the initial bundle small; the chunk is fetched on first open.
const _AnalyticsDashboard = lazy(() =>
  import('./components/AnalyticsDashboard').then((m) => ({ default: m.AnalyticsDashboard })),
);
const _CodeMap = lazy(() => import('./components/CodeMap').then((m) => ({ default: m.CodeMap })));
const _ChronicleDashboard = lazy(() =>
  import('./components/ChronicleDashboard').then((m) => ({ default: m.ChronicleDashboard })),
);
const _GoalView = lazy(() =>
  import('./components/GoalView').then((m) => ({ default: m.GoalView })),
);
const _ChangesView = lazy(() =>
  import('./components/ChangesView').then((m) => ({ default: m.ChangesView })),
);
const CronJobsPanel = lazy(() =>
  import('./components/CronJobsPanel').then((m) => ({ default: m.CronJobsPanel })),
);
const _CodeEditor = lazy(() =>
  import('./components/CodeEditor').then((m) => ({ default: m.CodeEditor })),
);
const _DebugDashboard = lazy(() =>
  import('./components/DebugDashboard').then((m) => ({ default: m.DebugDashboard })),
);
const _DesignGalleryView = lazy(() =>
  import('./components/DesignGalleryView').then((m) => ({ default: m.DesignGalleryView })),
);
const _MailboxDetailView = lazy(() =>
  import('./components/MailboxDetailView').then((m) => ({ default: m.MailboxDetailView })),
);
const _SageTabs = lazy(() =>
  import('./components/MemoryManager/SageTabs').then((m) => ({ default: m.SageTabs })),
);
const _AgentRosterView = lazy(() =>
  import('./components/AgentRosterView').then((m) => ({ default: m.AgentRosterView })),
);
const _KanbanView = lazy(() =>
  import('./components/KanbanView').then((m) => ({ default: m.KanbanView })),
);
const _OfficeMapPanel = lazy(() =>
  import('./components/OfficeMapPanel').then((m) => ({ default: m.OfficeMapPanel })),
);
const ProcessMonitor = lazy(() =>
  import('./components/ProcessMonitor').then((m) => ({ default: m.ProcessMonitor })),
);
const QueuePanel = lazy(() =>
  import('./components/QueuePanel').then((m) => ({ default: m.QueuePanel })),
);
const _RefreshDebugView = lazy(() =>
  import('./components/RefreshDebugView').then((m) => ({ default: m.RefreshDebugView })),
);
const _SddHub = lazy(() => import('./components/SddHub').then((m) => ({ default: m.SddHub })));
const _SessionsDashboard = lazy(() =>
  import('./components/SessionsDashboard').then((m) => ({ default: m.SessionsDashboard })),
);
const _SetupScreen = lazy(() =>
  import('./components/SetupScreen').then((m) => ({ default: m.SetupScreen })),
);
const _SkillDetailView = lazy(() =>
  import('./components/SkillDetailView').then((m) => ({ default: m.SkillDetailView })),
);
const _SpecsView = lazy(() =>
  import('./components/SpecsView').then((m) => ({ default: m.SpecsView })),
);
const _TechStackView = lazy(() =>
  import('./components/TechStackView').then((m) => ({ default: m.TechStackView })),
);
const _TerminalPanel = lazy(() =>
  import('./components/TerminalPanel').then((m) => ({ default: m.TerminalPanel })),
);

// WorkbenchTopbar, useServerProcessMetrics, ServerProcessMetrics, formatCompactBytes,
// and viewLabel have been extracted to ./components/WorkbenchTopbar.tsx

function AppInner() {
  const { t } = useAppTranslation();
  const { theme } = useTheme();
  const desktopShell = isDesktopShell();
  // Subscribe with a shallow selector, NOT the bare store: AppInner is the
  // root of the whole tree, and a bare useUIStore() re-renders it on EVERY
  // ui-store mutation (scroll nonces, nickname edits, inspector tabs, …).
  const {
    currentView,
    sidebarOpen,
    toggleSidebar,
    setSearchOpen,
    setSidebarOpen,
    setInspectorTab,
    setPaletteOpen,
    setShortcutsOpen,
    setModelSwitcherOpen,
    setPromptLibraryOpen,
    toggleInspector,
    setFleetMonitorOpen,
    setAgentsMonitorOpen,
    processMonitorOpen,
    setProcessMonitorOpen,
    queuePanelOpen,
    setQueuePanelOpen,
    cronJobsOpen,
    setCronJobsOpen,
    setTerminalOpen,
  } = useUIStore(
    useShallow((s) => ({
      currentView: s.currentView,
      sidebarOpen: s.sidebarOpen,
      toggleSidebar: s.toggleSidebar,
      setSearchOpen: s.setSearchOpen,
      setSidebarOpen: s.setSidebarOpen,
      setInspectorTab: s.setInspectorTab,
      setPaletteOpen: s.setPaletteOpen,
      setShortcutsOpen: s.setShortcutsOpen,
      setModelSwitcherOpen: s.setModelSwitcherOpen,
      setPromptLibraryOpen: s.setPromptLibraryOpen,
      toggleInspector: s.toggleInspector,
      setFleetMonitorOpen: s.setFleetMonitorOpen,
      setAgentsMonitorOpen: s.setAgentsMonitorOpen,
      processMonitorOpen: s.processMonitorOpen,
      setProcessMonitorOpen: s.setProcessMonitorOpen,
      queuePanelOpen: s.queuePanelOpen,
      setQueuePanelOpen: s.setQueuePanelOpen,
      cronJobsOpen: s.cronJobsOpen,
      setCronJobsOpen: s.setCronJobsOpen,
      setTerminalOpen: s.setTerminalOpen,
    })),
  );
  const isLoading = useChatStore((s) => s.isLoading);
  const chatMessageCount = useChatStore((s) => s.messages.length);
  const systemPromptInfo = useSystemPromptStore((s) => s.info);
  const systemPromptPrompted = useSystemPromptStore((s) => s.promptedThisSession);

  // First run: ask for the identity-prompt size before the chat has any
  // history. Deliberately gated on `chosen === false` rather than on the
  // current variant — the server materializes a default for every config, so
  // "current is Standard" would re-ask a user who already picked Standard.
  // `promptedThisSession` keeps a reconnect or a re-render from reopening it.
  useEffect(() => {
    if (!systemPromptInfo || systemPromptInfo.chosen) return;
    if (systemPromptInfo.variants.length === 0) return;
    if (chatMessageCount > 0 || systemPromptPrompted) return;
    useSystemPromptStore.getState().openPicker();
  }, [systemPromptInfo, chatMessageCount, systemPromptPrompted]);
  const iteration = useSessionStore((s) => s.iteration);
  const projectName = useSessionStore((s) => s.projectName);
  const sessionTitle = useSessionStore((s) => s.session?.title);
  const sessionId = useSessionStore((s) => s.session?.id);
  const nickname = useUIStore((s) => (sessionId ? s.sessionNicknames[sessionId] : undefined));
  const sideContextBreakdownOpen = useUIStore((s) => s.sideContextBreakdownOpen);
  const setSideContextBreakdownOpen = useUIStore((s) => s.setSideContextBreakdownOpen);
  const _fleetAgents = useFleetStore((s) => s.agents);

  useDesktopBridge({
    setPaletteOpen,
    setSearchOpen,
    setShortcutsOpen,
    setModelSwitcherOpen,
    setPromptLibraryOpen,
    setFleetMonitorOpen,
    setAgentsMonitorOpen,
    setProcessMonitorOpen,
    setQueuePanelOpen,
    setCronJobsOpen,
    setTerminalOpen,
  });

  // Detect /debug, /analytics, /refresh-debug URL paths and switch views.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.location.pathname === '/debug') {
      navigateToView('debug');
    } else if (window.location.pathname === '/analytics') {
      navigateToView('analytics');
    } else if (window.location.pathname === '/refresh-debug') {
      navigateToView('refresh-debug');
    }
  }, []);

  // Handle file open requests from FileExplorer (dispatches custom events on window)
  useEffect(() => {
    const onOpenFile = (e: Event) => {
      const { filePath } = (e as CustomEvent<{ filePath: string }>).detail;
      const ws = getWSClient(useConfigStore.getState().wsUrl);
      if (ws) {
        ws.send({ type: 'files.read', payload: { filePath } });
      }
    };
    window.addEventListener('wrongstack:open-file', onOpenFile);
    return () => window.removeEventListener('wrongstack:open-file', onOpenFile);
  }, []);

  // Handle file save requests from CodeEditor (Ctrl+S)
  useEffect(() => {
    const onSaveFile = (e: Event) => {
      const { filePath } = (e as CustomEvent<{ filePath: string }>).detail;
      const file = useFileStore.getState().openFiles.find((f) => f.path === filePath);
      if (!file) return;
      const ws = getWSClient(useConfigStore.getState().wsUrl);
      if (ws) {
        ws.send({
          type: 'files.write',
          payload: { filePath, content: file.content },
        });
      }
    };
    window.addEventListener('wrongstack:save-file', onSaveFile);
    return () => window.removeEventListener('wrongstack:save-file', onSaveFile);
  }, []);

  // Mobile-friendly: collapse the sidebar automatically below the md
  // breakpoint (768px). Tracks viewport changes so a window resize behaves
  // the same as a fresh load. We only AUTO-close — re-opening (or keeping
  // it open) on small screens stays a user decision, so we never call
  // setSidebarOpen(true) here.
  //
  // Also tracks whether the sidebar is currently acting as a modal overlay
  // (below md + open) so we can set `inert` on <main> for accessibility.
  const { isMobile } = useViewport();

  // Auto-close sidebar when entering mobile breakpoint.
  useEffect(() => {
    if (isMobile) {
      const open = useUIStore.getState().sidebarOpen;
      if (open) setSidebarOpen(false);
    }
  }, [isMobile, setSidebarOpen]);

  // Track whether the sidebar is acting as a modal overlay (mobile + open).
  const mobileSidebarModal = isMobile && sidebarOpen;
  // Install WS handlers exactly once for the whole app. Every other consumer
  // (ChatInput, ConfirmDialog, SettingsPanel) uses the cheap `useWebSocket()`
  // hook which returns action methods only — see hooks/useWebSocket.ts for
  // the duplicate-handler trap this avoids.
  useWebSocketBootstrap();

  // Four tabs share one socket: the server has to be told which sessions this
  // page displays or it filters three of them out of every broadcast.
  useSessionSubscription();

  useF5Resilience();

  // Reflect the agent's run state + session identity in the browser tab
  // title. Pinned/grouped tab strips become readable at a glance — the
  // project name surfaces first so multiple WrongStack windows on the same
  // bar can still be distinguished, then the session title (if any), then
  // the running indicator. Falls back gracefully when fields are missing.
  useEffect(() => {
    const parts: string[] = [];
    if (isLoading) {
      const it = iteration
        ? ` iter ${iteration.index}${iteration.max ? `/${iteration.max}` : ''}`
        : '';
      parts.push(`●${it}`);
    }
    const sessionLabel = nickname?.trim() || sessionTitle?.trim();
    const projectLabel = projectName?.trim();
    if (sessionLabel) parts.push(sessionLabel);
    if (projectLabel) parts.push(projectLabel);
    if (parts.length === 0) parts.push(projectLabel || 'AI Agent');
    const title = parts.filter(Boolean).join(' · ');
    document.title = title;
    return () => {
      document.title = projectName || 'AI Agent';
    };
  }, [isLoading, iteration, projectName, sessionTitle, nickname]);

  useGlobalKeyboardShortcuts({
    toggleSidebar,
    setSearchOpen,
    toggleInspector,
    setInspectorTab,
  });

  return (
    <div
      data-shell={desktopShell ? 'desktop' : 'browser'}
      className={cn(
        'ws-app-root flex min-h-0 min-w-0 overflow-hidden',
        desktopShell && 'ws-desktop-shell',
        theme,
      )}
    >
      {/* ── Skip to content (a11y) — visible on focus only ── */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[100] focus:rounded-md focus:bg-background focus:px-3 focus:py-1.5 focus:text-sm focus:font-medium focus:shadow-lg focus:ring-2 focus:ring-primary"
      >
        {t('activity:app.skipToContent')}
      </a>

      {/* ── Activity Bar — hidden during setup ── */}
      {currentView !== 'setup' && <ActivityBar desktopShell={desktopShell} />}

      {/* ── Secondary Panel — collapsible, context-sensitive ── */}
      {sidebarOpen && currentView !== 'setup' && <SidePanel desktopShell={desktopShell} />}

      {/* ── Main area ── */}
      <main
        id="main-content"
        className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden bg-background/70"
        {...(mobileSidebarModal ? { inert: true } : {})}
      >
        {currentView !== 'setup' && (
          <WorkbenchTopbar
            currentView={currentView}
            projectName={projectName}
            sessionLabel={nickname || sessionTitle || sessionId || undefined}
            isLoading={isLoading}
            iteration={iteration ?? null}
            onPalette={() => setPaletteOpen(true)}
            onSettings={() => openMainView('settings')}
          />
        )}
        {currentView !== 'setup' && <SessionTabBar />}
        {currentView !== 'setup' && <ConnectionBanner />}
        {currentView !== 'setup' && <UpdateBanner />}
        {/* Main view content — routed by ViewRouter.
            `relative` is the positioning context parked views anchor to: chat
            stays mounted behind whatever view is in front, sized to this box
            so its virtualized transcript keeps measuring. */}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <ViewRouter sessionId={sessionId ?? null} desktopShell={desktopShell} />
        </div>
      </main>

      {/* Right-side inspectors overlay the work surface without shrinking it.
          Workspace dock content owns the foreground while a dock section is
          selected; the global Fleet/Agents/Audit inspector remains separate. */}
      {currentView !== 'setup' && (
        <>
          <ErrorBoundary level="panel" name={t('activity:panels.inspector')}>
            <InspectorPanel />
          </ErrorBoundary>
          {sessionId && currentView === 'chat' && (
            <ErrorBoundary level="panel" name={t('activity:panels.workspaceInspector')}>
              <WorkspaceDockInspector sessionId={sessionId} />
            </ErrorBoundary>
          )}
        </>
      )}

      {/* Process Monitor overlay — triggered by /kill */}
      {processMonitorOpen && (
        <ErrorBoundary level="panel" name={t('activity:panels.processMonitor')}>
          <Suspense fallback={null}>
            <ProcessMonitor
              open={processMonitorOpen}
              onClose={() => setProcessMonitorOpen(false)}
            />
          </Suspense>
        </ErrorBoundary>
      )}

      {/* Queue Panel overlay — triggered by /queue */}
      {queuePanelOpen && (
        <ErrorBoundary level="panel" name={t('activity:panels.queue')}>
          <Suspense fallback={null}>
            <QueuePanel open={queuePanelOpen} onClose={() => setQueuePanelOpen(false)} />
          </Suspense>
        </ErrorBoundary>
      )}

      {/* Cron Jobs overlay — triggered by /cron */}
      {cronJobsOpen && (
        <ErrorBoundary level="panel" name={t('activity:panels.cronJobs')}>
          <Suspense fallback={null}>
            <CronJobsPanel open={cronJobsOpen} onClose={() => setCronJobsOpen(false)} />
          </Suspense>
        </ErrorBoundary>
      )}

      {/* Agent detail is now shown in the inspector sidebar — no modal needed */}

      {/* Prompt library modal — triggered by /prompt slash command or library button */}
      <PromptLibraryModal />

      {/* Context breakdown modal — triggered from side-panel session panel */}
      {sideContextBreakdownOpen && (
        <ContextBreakdownModal
          open={sideContextBreakdownOpen}
          onClose={() => setSideContextBreakdownOpen(false)}
        />
      )}

      {/* Global overlays */}
      <ConfirmDialog />
      <SystemPromptDialog />
      <ConfirmModalHost />
      <PromptModalHost />
      <CommandPalette />
      <ShortcutsOverlay />
      <QuickModelSwitcher />
      <FallbackModal />
      <Toaster />
    </div>
  );
}

export function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="system">
        <AppInner />
      </ThemeProvider>
    </ErrorBoundary>
  );
}
