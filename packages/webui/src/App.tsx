import { lazy, Suspense, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useF5Resilience } from '@/hooks/useF5Resilience';
import { useGlobalKeyboardShortcuts } from '@/hooks/useGlobalKeyboardShortcuts';
import { useSessionSubscription } from '@/hooks/useSessionSubscription';
import { useViewport } from '@/hooks/useViewport';
import { useWebSocketBootstrap } from '@/hooks/useWebSocket';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import {
  useActiveSessionId,
  useChatStore,
  useConfigStore,
  useFileStore,
  useFleetStore,
  useSessionStore,
  useUIStore,
} from '@/stores';
import { ArtifactPreview } from './components/ArtifactPreview';
import { ActivityBar } from './components/activity-bar';
import { navigateToView, openMainView } from './components/activity-bar/nav';
import { CommandPalette } from './components/CommandPalette';
import { ConfirmDialog } from './components/ConfirmDialog';
import { ConfirmModalHost, PromptModalHost } from './components/ConfirmModal';
import { ConnectionBanner } from './components/ConnectionBanner';
import { ErrorBoundary } from './components/ErrorBoundary';
import { FallbackModal } from './components/FallbackModal';
import { InspectorPanel } from './components/InspectorPanel';
import { PromptLibraryModal } from './components/PromptLibraryModal';
import { QuickModelSwitcher } from './components/QuickModelSwitcher';
import { RestoreTabsModal } from './components/RestoreTabsModal';
import { SessionTabBar } from './components/SessionTabBar';
import { ShortcutsOverlay } from './components/ShortcutsOverlay';
import { SidePanel } from './components/SidePanel';
import { SystemPromptDialog } from './components/SystemPromptDialog';
import { ThemeProvider, useTheme } from './components/ThemeProvider';
import { Toaster } from './components/Toaster';
import { UpdateBanner } from './components/UpdateBanner';
import { UserInputDialog } from './components/UserInputDialog';
import { ViewRouter } from './components/ViewRouter';
import { WorkbenchTopbar } from './components/WorkbenchTopbar';
import { WorkspaceDockInspector } from './components/WorkspaceDock';
import { useSystemPromptStore } from './stores/system-prompt-store';

// Per-view lazy imports live in `./components/view-registry.ts`, which is the
// single place that maps a `View` to its component, wrapper and boundary.
// A parallel block of `const _X = lazy(...)` declarations used to sit here;
// every one of them was unreferenced (module-local, never rendered), so the
// code-splitting comment they carried described chunks this file no longer
// requests. Add new views to the registry, not here.

// These three are NOT main-area views — they are overlay panels App.tsx
// renders itself, outside the registry — so their lazy handles stay here.
const CronJobsPanel = lazy(() =>
  import('./components/CronJobsPanel').then((m) => ({ default: m.CronJobsPanel })),
);
const ProcessMonitor = lazy(() =>
  import('./components/ProcessMonitor').then((m) => ({ default: m.ProcessMonitor })),
);
const QueuePanel = lazy(() =>
  import('./components/QueuePanel').then((m) => ({ default: m.QueuePanel })),
);

// WorkbenchTopbar, useServerProcessMetrics, ServerProcessMetrics, formatCompactBytes,
// and viewLabel have been extracted to ./components/WorkbenchTopbar.tsx

function AppInner() {
  const { t } = useAppTranslation();
  const { theme } = useTheme();
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
    toggleInspector,
    processMonitorOpen,
    setProcessMonitorOpen,
    queuePanelOpen,
    setQueuePanelOpen,
    cronJobsOpen,
    setCronJobsOpen,
  } = useUIStore(
    useShallow((s) => ({
      currentView: s.currentView,
      sidebarOpen: s.sidebarOpen,
      toggleSidebar: s.toggleSidebar,
      setSearchOpen: s.setSearchOpen,
      setSidebarOpen: s.setSidebarOpen,
      setInspectorTab: s.setInspectorTab,
      setPaletteOpen: s.setPaletteOpen,
      toggleInspector: s.toggleInspector,
      processMonitorOpen: s.processMonitorOpen,
      setProcessMonitorOpen: s.setProcessMonitorOpen,
      queuePanelOpen: s.queuePanelOpen,
      setQueuePanelOpen: s.setQueuePanelOpen,
      cronJobsOpen: s.cronJobsOpen,
      setCronJobsOpen: s.setCronJobsOpen,
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
  const sessionRecordId = useSessionStore((s) => s.session?.id);
  const activeSessionId = useActiveSessionId();
  const sessionId = activeSessionId ?? sessionRecordId;
  const nickname = useUIStore((s) => (sessionId ? s.sessionNicknames[sessionId] : undefined));
  const _fleetAgents = useFleetStore((s) => s.agents);

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
      useUIStore.getState().setCurrentView('files');
      const ws = getWSClient(useConfigStore.getState().wsUrl);
      if (ws) {
        ws.send({ type: 'files.read', payload: ws.withSession({ filePath }) });
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
          payload: ws.withSession({ filePath, content: file.content }),
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
      className={cn(
        'ws-app-root flex min-h-0 min-w-0 overflow-hidden',
        currentView !== 'setup' && 'max-md:pb-14',
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
      {currentView !== 'setup' && <ActivityBar />}

      {/* ── Secondary Panel — collapsible, context-sensitive ── */}
      {sidebarOpen && currentView !== 'setup' && <SidePanel />}

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
        {/* Session tabs belong to the chat surface: parked (kept mounted,
            hidden + inert) on every other view, so tab state never tears
            down — the strip is simply not displayed outside chat. */}
        {currentView !== 'setup' && (
          <div
            className={cn(currentView !== 'chat' && 'ws-view-parked')}
            {...(currentView !== 'chat' ? { inert: true, 'aria-hidden': true } : {})}
          >
            <SessionTabBar />
          </div>
        )}
        {currentView !== 'setup' && <ConnectionBanner />}
        {currentView !== 'setup' && <UpdateBanner />}
        {/* Main view content — routed by ViewRouter.
            `relative` is the positioning context parked views anchor to: chat
            stays mounted behind whatever view is in front, sized to this box
            so its virtualized transcript keeps measuring. */}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <ViewRouter sessionId={sessionId ?? null} />
          {/* The workspace dock inspector is anchored to THIS box, so it
              overlays the work surface only. Fixed to the viewport it also
              covered the top chrome — the session tab strip included — and
              swallowed clicks on the rightmost tabs while a dock section was
              open. */}
          {currentView !== 'setup' && (
            <ErrorBoundary level="panel" name={t('activity:panels.workspaceInspector')}>
              {sessionId && <WorkspaceDockInspector sessionId={sessionId} />}
            </ErrorBoundary>
          )}
        </div>
      </main>

      {/* The global Fleet/Agents/Audit inspector is a MODAL sheet and stays
          viewport-level: it dims the shell and owns the foreground on purpose.
          Workspace dock content owns the foreground only while a dock section
          is selected, and is scoped to the work surface above. */}
      {currentView !== 'setup' && (
        <ErrorBoundary level="panel" name={t('activity:panels.inspector')}>
          <InspectorPanel />
        </ErrorBoundary>
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

      {/* The context breakdown modal is mounted once, by ChatView
          (chatContextBreakdownOpen). A second copy used to sit here behind
          `sideContextBreakdownOpen`, which nothing in the app ever opened. */}

      {/* Global overlays */}
      <ConfirmDialog />
      <UserInputDialog />
      <SystemPromptDialog />
      <ConfirmModalHost />
      <RestoreTabsModal />
      <PromptModalHost />
      <CommandPalette />
      <ShortcutsOverlay />
      <QuickModelSwitcher />
      <FallbackModal />
      <Toaster />
      <ArtifactPreview />
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
