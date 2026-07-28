import { Bot, Command, Cpu, Moon, Search, Settings, Sparkles, Sun, Wifi, WifiOff } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useDesktopBridge } from '@/hooks/useDesktopBridge';
import { useF5Resilience } from '@/hooks/useF5Resilience';
import { useGlobalKeyboardShortcuts } from '@/hooks/useGlobalKeyboardShortcuts';
import { useWebSocketBootstrap } from '@/hooks/useWebSocket';
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
import { navigateToView, openMainView, showPanel } from './components/activity-bar/nav';
import { ChatView } from './components/ChatView';
import { CommandPalette } from './components/CommandPalette';
import { ConfirmDialog } from './components/ConfirmDialog';
import { ConfirmModalHost, PromptModalHost } from './components/ConfirmModal';
import { ConnectionBanner } from './components/ConnectionBanner';
import { ContextBreakdownModal } from './components/ContextBreakdownModal';
import { ContextDashboard } from './components/ContextDashboard';
import { CronTrigger } from './components/CronTrigger';
import { ErrorBoundary } from './components/ErrorBoundary';
import { InspectorPanel, InspectorTrigger } from './components/InspectorPanel';
import { PromptLibraryModal } from './components/PromptLibraryModal';
import { QuickModelSwitcher } from './components/QuickModelSwitcher';
import { SettingsPanel } from './components/SettingsPanel';
import { ShortcutsOverlay } from './components/ShortcutsOverlay';
import { SidePanel } from './components/SidePanel';
import { ThemeProvider, useTheme } from './components/ThemeProvider';
import { Toaster } from './components/Toaster';
import { WorkspaceDock, WorkspaceDockInspector } from './components/WorkspaceDock';

// ── Lazy-loaded views ──────────────────────────────────────────────────────
// These pull heavy libraries (Monaco ~4MB, @xyflow, xterm) or are themselves
// large, and are gated behind specific `currentView` values. Code-splitting
// them keeps the initial bundle small; the chunk is fetched on first open.
const AnalyticsDashboard = lazy(() =>
  import('./components/AnalyticsDashboard').then((m) => ({ default: m.AnalyticsDashboard })),
);
const CodeMap = lazy(() => import('./components/CodeMap').then((m) => ({ default: m.CodeMap })));
const ChronicleDashboard = lazy(() =>
  import('./components/ChronicleDashboard').then((m) => ({ default: m.ChronicleDashboard })),
);
const GoalView = lazy(() => import('./components/GoalView').then((m) => ({ default: m.GoalView })));
const ChangesView = lazy(() =>
  import('./components/ChangesView').then((m) => ({ default: m.ChangesView })),
);
const CronJobsPanel = lazy(() =>
  import('./components/CronJobsPanel').then((m) => ({ default: m.CronJobsPanel })),
);
const CodeEditor = lazy(() =>
  import('./components/CodeEditor').then((m) => ({ default: m.CodeEditor })),
);
const DebugDashboard = lazy(() =>
  import('./components/DebugDashboard').then((m) => ({ default: m.DebugDashboard })),
);
const DesignGalleryView = lazy(() =>
  import('./components/DesignGalleryView').then((m) => ({ default: m.DesignGalleryView })),
);
const MailboxDetailView = lazy(() =>
  import('./components/MailboxDetailView').then((m) => ({ default: m.MailboxDetailView })),
);
const SageTabs = lazy(() =>
  import('./components/MemoryManager/SageTabs').then((m) => ({ default: m.SageTabs })),
);
const AgentRosterView = lazy(() =>
  import('./components/AgentRosterView').then((m) => ({ default: m.AgentRosterView })),
);
const KanbanView = lazy(() =>
  import('./components/KanbanView').then((m) => ({ default: m.KanbanView })),
);
const OfficeMapPanel = lazy(() =>
  import('./components/OfficeMapPanel').then((m) => ({ default: m.OfficeMapPanel })),
);
const ProcessMonitor = lazy(() =>
  import('./components/ProcessMonitor').then((m) => ({ default: m.ProcessMonitor })),
);
const QueuePanel = lazy(() =>
  import('./components/QueuePanel').then((m) => ({ default: m.QueuePanel })),
);
const RefreshDebugView = lazy(() =>
  import('./components/RefreshDebugView').then((m) => ({ default: m.RefreshDebugView })),
);
const SddHub = lazy(() => import('./components/SddHub').then((m) => ({ default: m.SddHub })));
const SessionsDashboard = lazy(() =>
  import('./components/SessionsDashboard').then((m) => ({ default: m.SessionsDashboard })),
);
const SetupScreen = lazy(() =>
  import('./components/SetupScreen').then((m) => ({ default: m.SetupScreen })),
);
const SkillDetailView = lazy(() =>
  import('./components/SkillDetailView').then((m) => ({ default: m.SkillDetailView })),
);
const _SpecsView = lazy(() =>
  import('./components/SpecsView').then((m) => ({ default: m.SpecsView })),
);
const TechStackView = lazy(() =>
  import('./components/TechStackView').then((m) => ({ default: m.TechStackView })),
);
const TerminalPanel = lazy(() =>
  import('./components/TerminalPanel').then((m) => ({ default: m.TerminalPanel })),
);

function viewLabel(view: string): string {
  return view
    .split('-')
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ');
}

interface ServerProcessMetrics {
  pid: number;
  memoryUsage: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
  };
  heapLimit: number;
  codebaseIndexServer?: {
    status:
      | 'unavailable'
      | 'offline'
      | 'connecting'
      | 'connected'
      | 'degraded'
      | 'unresponsive'
      | 'error'
      | 'stopping';
    connected: boolean;
    pid?: number | undefined;
    health?: {
      status: 'healthy' | 'degraded' | 'unresponsive';
      latencyMs: number | null;
      missedHeartbeats: number;
      server?: {
        uptimeMs: number;
        memory: { rss: number; heapUsed: number; heapTotal: number };
        clients: number;
        activeRequests: number;
        queuedWrites: number;
        pendingExternalFiles: number;
        watchingExternal: boolean;
        watchingClients?: number | undefined;
        clientLeaseTimeoutMs?: number | undefined;
        oldestClientIdleMs?: number | undefined;
      } | undefined;
    } | undefined;
  } | undefined;
}

function formatCompactBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes)} B`;
}

function useServerProcessMetrics(): ServerProcessMetrics | null {
  const [metrics, setMetrics] = useState<ServerProcessMetrics | null>(null);

  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const response = await fetch('/debug/system', { cache: 'no-store' });
        if (!response.ok) return;
        const next = (await response.json()) as ServerProcessMetrics;
        if (!disposed && Number.isFinite(next.memoryUsage?.rss)) setMetrics(next);
      } catch {
        // Keep the rest of the workbench usable if diagnostics are unavailable.
      }
    };

    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  return metrics;
}

function WorkbenchTopbar({
  currentView,
  projectName,
  sessionLabel,
  isLoading,
  iteration,
  onPalette,
  onSearch,
  onModel,
  onSettings,
}: {
  currentView: string;
  projectName?: string | undefined;
  sessionLabel?: string | undefined;
  isLoading: boolean;
  iteration: { index: number; max: number } | null;
  onPalette: () => void;
  onSearch: () => void;
  onModel: () => void;
  onSettings: () => void;
}) {
  const { theme, setTheme } = useTheme();
  const wsConnected = useConfigStore((s) => s.wsConnected);
  const effectiveTheme =
    theme === 'system'
      ? typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme;
  // Cycle light → dark → light. The 'system' option stays accessible via
  // the ActivityBar "More" menu and Settings → Appearance.
  const toggleTheme = useCallback(() => {
    setTheme(effectiveTheme === 'dark' ? 'light' : 'dark');
  }, [effectiveTheme, setTheme]);
  const serverProcess = useServerProcessMetrics();
  const heapLoad = serverProcess ? serverProcess.memoryUsage.heapUsed / serverProcess.heapLimit : 0;
  const indexServer = serverProcess?.codebaseIndexServer;
  const indexHealth = indexServer?.health;
  const indexMetrics = indexHealth?.server;
  return (
    <div className="hidden shrink-0 border-b border-border/70 bg-card/85 px-3 py-2 shadow-sm backdrop-blur-xl md:block">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-semibold">{projectName || 'WrongStack'}</span>
              <span className="rounded-md border border-border/70 bg-muted/50 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {viewLabel(currentView)}
              </span>
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium',
                  isLoading ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
                )}
              >
                {isLoading ? (
                  <Bot className="h-3 w-3 animate-pulse" />
                ) : (
                  <Sparkles className="h-3 w-3" />
                )}
                {isLoading ? 'Running' : 'Ready'}
                {iteration ? (
                  <span className="tabular">
                    {iteration.index}
                    {iteration.max > 0 ? `/${iteration.max}` : ''}
                  </span>
                ) : null}
              </span>
              {serverProcess ? (
                <span
                  className={cn(
                    'rounded-md border border-border/70 bg-muted/50 px-1.5 py-0.5 text-[11px] font-medium tabular-nums',
                    heapLoad >= 0.85
                      ? 'text-destructive'
                      : heapLoad >= 0.6
                        ? 'text-warning'
                        : 'text-success',
                  )}
                  title={`WebUI server PID ${serverProcess.pid} · heap ${formatCompactBytes(serverProcess.memoryUsage.heapUsed)} / ${formatCompactBytes(serverProcess.heapLimit)}`}
                >
                  RAM {formatCompactBytes(serverProcess.memoryUsage.rss)}
                </span>
              ) : null}
              {indexServer ? (
                <span
                  className={cn(
                    'rounded-md border border-border/70 bg-muted/50 px-1.5 py-0.5 text-[11px] font-medium tabular-nums',
                    indexServer.status === 'connected'
                      ? 'text-success'
                      : indexServer.status === 'unresponsive' || indexServer.status === 'error'
                        ? 'text-destructive'
                        : indexServer.status === 'degraded' ||
                            indexServer.status === 'connecting' ||
                            indexServer.status === 'stopping'
                          ? 'text-warning'
                          : 'text-muted-foreground',
                  )}
                  title={[
                    `Codebase index: ${indexHealth?.status ?? indexServer.status}`,
                    indexServer.pid ? `PID ${indexServer.pid}` : null,
                    indexHealth?.latencyMs != null ? `RTT ${indexHealth.latencyMs}ms` : null,
                    indexMetrics ? `RAM ${formatCompactBytes(indexMetrics.memory.rss)}` : null,
                    indexHealth?.missedHeartbeats
                      ? `missed ${indexHealth.missedHeartbeats}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                >
                  Index {indexHealth?.status ?? indexServer.status}
                </span>
              ) : null}
            </div>
            <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {sessionLabel || 'No named session'}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onSearch}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border/70 bg-background/60 px-2 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground"
            title="Search chat"
          >
            <Search className="h-3.5 w-3.5" />
            Search
          </button>
          <button
            type="button"
            onClick={onPalette}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border/70 bg-background/60 px-2 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground"
            title="Command palette"
          >
            <Command className="h-3.5 w-3.5" />
            Command
          </button>
          <button
            type="button"
            onClick={onModel}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border/70 bg-background/60 px-2 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground"
            title="Switch model"
          >
            <Cpu className="h-3.5 w-3.5" />
            Model
          </button>
          <button
            type="button"
            onClick={toggleTheme}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border/70 bg-background/60 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
            title={effectiveTheme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          >
            {effectiveTheme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
          </button>
          <InspectorTrigger />
          <CronTrigger />
          <span
            role="status"
            aria-label={wsConnected ? 'Connected' : 'Disconnected'}
            className={cn(
              'inline-flex h-8 w-8 items-center justify-center rounded-md border border-border/70 bg-background/60',
              wsConnected ? 'text-success' : 'text-warning',
            )}
            title={wsConnected ? 'Connected' : 'Disconnected'}
          >
            {wsConnected ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
          </span>
          <button
            type="button"
            onClick={onSettings}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border/70 bg-background/60 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
            title="Settings"
          >
            <Settings className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

/** Suspense fallback for lazy-loaded views — a quiet centered spinner so the
 *  first open of the editor / terminal / office map doesn't look frozen. */
function PanelSuspense({ label }: { label?: string }) {
  return (
    <div className="flex flex-1 min-h-0 min-w-0 items-center justify-center bg-background text-muted-foreground">
      <div className="flex flex-col items-center gap-3">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-primary" />
        {label ? <span className="text-xs">{label}</span> : null}
      </div>
    </div>
  );
}

function AppInner() {
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
    terminalOpen,
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
      terminalOpen: s.terminalOpen,
      setTerminalOpen: s.setTerminalOpen,
    })),
  );
  const isLoading = useChatStore((s) => s.isLoading);
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
  const [mobileSidebarModal, setMobileSidebarModal] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 768px)');
    const apply = () => {
      const open = useUIStore.getState().sidebarOpen;
      if (mq.matches && open) {
        setSidebarOpen(false);
      }
      setMobileSidebarModal(mq.matches && open);
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [setSidebarOpen]);

  // Update mobileSidebarModal when sidebarOpen changes (user opens/closes).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 768px)');
    setMobileSidebarModal(mq.matches && sidebarOpen);
  }, [sidebarOpen]);
  // Install WS handlers exactly once for the whole app. Every other consumer
  // (ChatInput, ConfirmDialog, SettingsPanel) uses the cheap `useWebSocket()`
  // hook which returns action methods only — see hooks/useWebSocket.ts for
  // the duplicate-handler trap this avoids.
  useWebSocketBootstrap();

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
        Skip to content
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
            onSearch={() => setSearchOpen(true)}
            onModel={() => setModelSwitcherOpen(true)}
            onSettings={() => openMainView('settings')}
          />
        )}
        {currentView !== 'setup' && <ConnectionBanner />}
        {currentView === 'chat' && (
          <>
            {/* The dock stays above chat as a compact control strip; selected
                content opens in the right-side workspace inspector. */}
            {sessionId && (
              <div className="ws-workspace-dock-wrap shrink-0 px-3 pt-2 sm:px-4">
                <WorkspaceDock />
              </div>
            )}
            <ErrorBoundary level="panel" name="Chat">
              <ChatView />
            </ErrorBoundary>
          </>
        )}
        {currentView === 'settings' && (
          <ErrorBoundary level="panel" name="Settings">
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
              <SettingsPanel />
            </div>
          </ErrorBoundary>
        )}
        {currentView === 'memory' && (
          <ErrorBoundary level="panel" name="SAGE Memory">
            <Suspense fallback={<PanelSuspense label="Loading SAGE…" />}>
              <SageTabs />
            </Suspense>
          </ErrorBoundary>
        )}
        {currentView === 'roster' && (
          <ErrorBoundary level="panel" name="Agent Roster">
            <Suspense fallback={<PanelSuspense label="Loading agent roster…" />}>
              <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
                <AgentRosterView />
              </div>
            </Suspense>
          </ErrorBoundary>
        )}
        {currentView === 'context' && (
          <ErrorBoundary level="panel" name="Context Dashboard">
            <ContextDashboard />
          </ErrorBoundary>
        )}
        {currentView === 'setup' && (
          <ErrorBoundary level="panel" name="Setup">
            <Suspense fallback={<PanelSuspense />}>
              <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
                <SetupScreen />
              </div>
            </Suspense>
          </ErrorBoundary>
        )}
        {currentView === 'goal' && (
          <ErrorBoundary level="panel" name="Goal">
            <Suspense fallback={<PanelSuspense />}>
              <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
                <GoalView onClose={() => showPanel('chat')} />
              </div>
            </Suspense>
          </ErrorBoundary>
        )}
        {currentView === 'sddhub' && (
          <ErrorBoundary level="panel" name="SDD Hub">
            <Suspense fallback={<PanelSuspense />}>
              <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
                <SddHub />
              </div>
            </Suspense>
          </ErrorBoundary>
        )}
        {currentView === 'kanban' && (
          <ErrorBoundary level="panel" name="Kanban">
            <Suspense fallback={<PanelSuspense />}>
              <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
                <KanbanView onClose={() => showPanel('chat')} />
              </div>
            </Suspense>
          </ErrorBoundary>
        )}
        {currentView === 'sessions' && (
          <ErrorBoundary level="panel" name="Sessions">
            <Suspense fallback={<PanelSuspense />}>
              <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
                <SessionsDashboard />
              </div>
            </Suspense>
          </ErrorBoundary>
        )}
        {currentView === 'chronicle' && (
          <ErrorBoundary level="panel" name="Chronicle">
            <Suspense fallback={<PanelSuspense />}>
              <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
                <ChronicleDashboard />
              </div>
            </Suspense>
          </ErrorBoundary>
        )}
        {/* ── Debug Dashboard — accessed via /debug URL ── */}
        {currentView === 'debug' && (
          <ErrorBoundary level="panel" name="Debug Dashboard">
            <Suspense fallback={<PanelSuspense />}>
              <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
                <DebugDashboard />
              </div>
            </Suspense>
          </ErrorBoundary>
        )}

        {/* ── Refresh-resilience verifier — accessed via /refresh-debug URL. ──
         *  Lets the user confirm in-app that the latest active session
         *  pointer, transcript, and UI state survived an F5. Without a
         *  visible surface there's no way for the user to verify the
         *  contract from the WebUI itself, which was a stated requirement. */}
        {currentView === 'refresh-debug' && (
          <ErrorBoundary level="panel" name="Refresh Debug">
            <Suspense fallback={<PanelSuspense />}>
              <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
                <RefreshDebugView />
              </div>
            </Suspense>
          </ErrorBoundary>
        )}

        {/* ── IDE Code Editor (only in Files view) ── */}
        {currentView === 'files' && (
          <ErrorBoundary level="panel" name="Editor">
            <Suspense fallback={<PanelSuspense label="Loading editor…" />}>
              <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
                <CodeEditor />
              </div>
            </Suspense>
          </ErrorBoundary>
        )}

        {/* ── Source-control diff — file list lives in the SidePanel ── */}
        {currentView === 'changes' && (
          <ErrorBoundary level="panel" name="Changes">
            <Suspense fallback={<PanelSuspense label="Loading diff…" />}>
              <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
                <ChangesView className="h-full min-h-0" />
              </div>
            </Suspense>
          </ErrorBoundary>
        )}

        {/* ── Mailbox detail — wide main area; list lives in the SidePanel ── */}
        {currentView === 'mailbox' && (
          <ErrorBoundary level="panel" name="Mailbox">
            <Suspense fallback={<PanelSuspense />}>
              <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
                <MailboxDetailView className="h-full min-h-0" />
              </div>
            </Suspense>
          </ErrorBoundary>
        )}

        {/* ── Design Studio gallery — live kit previews ── */}
        {currentView === 'design-gallery' && (
          <ErrorBoundary level="panel" name="Design Gallery">
            <Suspense fallback={<PanelSuspense />}>
              <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
                <DesignGalleryView className="h-full" />
              </div>
            </Suspense>
          </ErrorBoundary>
        )}

        {/* ── Skill detail — wide main area; list lives in the SidePanel ── */}
        {currentView === 'skill' && (
          <ErrorBoundary level="panel" name="Skill">
            <Suspense fallback={<PanelSuspense />}>
              <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
                <SkillDetailView className="h-full" />
              </div>
            </Suspense>
          </ErrorBoundary>
        )}

        {/* ── Office Map (Fleet HQ) — wide main area; settings in the SidePanel ── */}
        {currentView === 'officemap' && (
          <ErrorBoundary level="panel" name="Office Map">
            <Suspense fallback={<PanelSuspense label="Loading map…" />}>
              <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
                <OfficeMapPanel />
              </div>
            </Suspense>
          </ErrorBoundary>
        )}

        {/* ── Analytics Dashboard — event stats, session metrics, usage ── */}
        {currentView === 'analytics' && (
          <ErrorBoundary level="panel" name="Analytics">
            <Suspense fallback={<PanelSuspense />}>
              <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
                <AnalyticsDashboard />
              </div>
            </Suspense>
          </ErrorBoundary>
        )}

        {/* ── CodeMap — interactive dependency graph (package → file → symbol) ── */}
        {currentView === 'codemap' && (
          <ErrorBoundary level="panel" name="CodeMap">
            <Suspense fallback={<PanelSuspense label="Loading CodeMap…" />}>
              <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
                <CodeMap />
              </div>
            </Suspense>
          </ErrorBoundary>
        )}

        {/* ── TechStack — dependency inventory (workspaces, deps, coverage) ── */}
        {currentView === 'techstack' && (
          <ErrorBoundary level="panel" name="TechStack">
            <Suspense fallback={<PanelSuspense label="Loading TechStack…" />}>
              <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
                <TechStackView />
              </div>
            </Suspense>
          </ErrorBoundary>
        )}

        {/* Integrated terminal bottom dock. It lives inside main's flex column
            so every view above it gets a smaller, scrollable height instead of
            being covered by a fixed overlay. */}
        {terminalOpen && (
          <ErrorBoundary level="panel" name="Terminal">
            <Suspense fallback={<PanelSuspense label="Loading terminal…" />}>
              <TerminalPanel desktopShell={desktopShell} onClose={() => setTerminalOpen(false)} />
            </Suspense>
          </ErrorBoundary>
        )}
      </main>

      {/* Right-side inspectors overlay the work surface without shrinking it.
          Workspace dock content owns the foreground while a dock section is
          selected; the global Fleet/Agents/Audit inspector remains separate. */}
      {currentView !== 'setup' && (
        <>
          <ErrorBoundary level="panel" name="Inspector">
            <InspectorPanel />
          </ErrorBoundary>
          {sessionId && currentView === 'chat' && (
            <ErrorBoundary level="panel" name="Workspace Inspector">
              <WorkspaceDockInspector sessionId={sessionId} />
            </ErrorBoundary>
          )}
        </>
      )}

      {/* Process Monitor overlay — triggered by /kill */}
      {processMonitorOpen && (
        <ErrorBoundary level="panel" name="Process Monitor">
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
        <ErrorBoundary level="panel" name="Queue">
          <Suspense fallback={null}>
            <QueuePanel open={queuePanelOpen} onClose={() => setQueuePanelOpen(false)} />
          </Suspense>
        </ErrorBoundary>
      )}

      {/* Cron Jobs overlay — triggered by /cron */}
      {cronJobsOpen && (
        <ErrorBoundary level="panel" name="Cron Jobs">
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
      <ConfirmModalHost />
      <PromptModalHost />
      <CommandPalette />
      <ShortcutsOverlay />
      <QuickModelSwitcher />
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
