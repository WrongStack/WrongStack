import { expectDefined } from '@wrongstack/core';
import { Bot, Command, Cpu, Search, Settings, Sparkles, Zap } from 'lucide-react';
import { lazy, Suspense, useEffect } from 'react';
import { useWebSocketBootstrap } from '@/hooks/useWebSocket';
import {
  DESKTOP_COMMAND_DOCKS,
  DESKTOP_COMMAND_VIEWS,
  DESKTOP_COMMAND_WORK_TABS,
  publishDesktopCommandAck,
  publishDesktopPrefsSnapshot,
  publishDesktopReady,
} from '@/lib/desktop-host';
import { isDesktopShell } from '@/lib/desktop-shell';
import { streamCoalescer } from '@/lib/stream-coalescer';
import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import {
  type DockSection,
  resetUiNavigationToHome,
  useChatStore,
  useConfigStore,
  useFileStore,
  useSessionStore,
  useUIStore,
} from '@/stores';
import { useLocalPrefs } from '@/stores/local-prefs';
import { AgentsMonitor } from './components/AgentsMonitor';
import { ActivityBar, PANEL_ORDER } from './components/activity-bar';
import {
  ACTIVITY_SHORTCUT_BY_KEY,
  navigateToView,
  openMainView,
  openPanel,
  pairedViewForActivity,
  showPanel,
} from './components/activity-bar/nav';
import { ChangesView } from './components/ChangesView';
import { ChatView } from './components/ChatView';
import { CommandPalette, downloadChatAsMarkdown } from './components/CommandPalette';
import { ConfirmDialog } from './components/ConfirmDialog';
import { ConfirmModalHost, PromptModalHost } from './components/ConfirmModal';
import { ConnectionBanner } from './components/ConnectionBanner';
import { ErrorBoundary } from './components/ErrorBoundary';
import { FleetMonitor } from './components/FleetMonitor';
import { InspectorPanel } from './components/InspectorPanel';
import { QuickModelSwitcher } from './components/QuickModelSwitcher';
import { SettingsPanel } from './components/SettingsPanel';
import { SetupScreen } from './components/SetupScreen';
import { ShortcutsOverlay } from './components/ShortcutsOverlay';
import { SidePanel } from './components/SidePanel';
import { ThemeProvider, useTheme } from './components/ThemeProvider';
import { Toaster, toast } from './components/Toaster';
import { WorkspaceDock } from './components/WorkspaceDock';

// ── Lazy-loaded views ──────────────────────────────────────────────────────
// These pull heavy libraries (Monaco ~4MB, @xyflow, xterm) or are themselves
// large, and are gated behind specific `currentView` values. Code-splitting
// them keeps the initial bundle small; the chunk is fetched on first open.
const AnalyticsDashboard = lazy(() =>
  import('./components/AnalyticsDashboard').then((m) => ({ default: m.AnalyticsDashboard })),
);
const AutoPhaseView = lazy(() =>
  import('./components/AutoPhaseView').then((m) => ({ default: m.AutoPhaseView })),
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
const SddBoardView = lazy(() =>
  import('./components/SddBoardView').then((m) => ({ default: m.SddBoardView })),
);
const SddWizard = lazy(() =>
  import('./components/SddWizard').then((m) => ({ default: m.SddWizard })),
);
const SessionsDashboard = lazy(() =>
  import('./components/SessionsDashboard').then((m) => ({ default: m.SessionsDashboard })),
);
const SkillDetailView = lazy(() =>
  import('./components/SkillDetailView').then((m) => ({ default: m.SkillDetailView })),
);
const SpecsView = lazy(() =>
  import('./components/SpecsView').then((m) => ({ default: m.SpecsView })),
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
  return (
    <div className="hidden shrink-0 border-b border-border/70 bg-card/85 px-3 py-2 shadow-sm backdrop-blur-xl md:block">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm shadow-primary/20">
            <Zap className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-semibold">
                {projectName || 'WrongStack'}
              </span>
              <span className="rounded-md border border-border/70 bg-muted/50 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {viewLabel(currentView)}
              </span>
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium',
                  isLoading
                    ? 'bg-primary/10 text-primary'
                    : 'bg-muted text-muted-foreground',
                )}
              >
                {isLoading ? <Bot className="h-3 w-3 animate-pulse" /> : <Sparkles className="h-3 w-3" />}
                {isLoading ? 'Running' : 'Ready'}
                {iteration ? (
                  <span className="tabular">
                    {iteration.index}
                    {iteration.max > 0 ? `/${iteration.max}` : ''}
                  </span>
                ) : null}
              </span>
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
    fleetMonitorOpen,
    agentsMonitorOpen,
    setFleetMonitorOpen,
    setAgentsMonitorOpen,
    processMonitorOpen,
    setProcessMonitorOpen,
    queuePanelOpen,
    setQueuePanelOpen,
    terminalOpen,
    setTerminalOpen,
  } = useUIStore();
  const isLoading = useChatStore((s) => s.isLoading);
  const iteration = useSessionStore((s) => s.iteration);
  const projectName = useSessionStore((s) => s.projectName);
  const sessionTitle = useSessionStore((s) => s.session?.title);
  const sessionId = useSessionStore((s) => s.session?.id);
  const nickname = useUIStore((s) => (sessionId ? s.sessionNicknames[sessionId] : undefined));

  useEffect(() => {
    if (!desktopShell) return;
    resetUiNavigationToHome({ sidebarOpen: false });
  }, [desktopShell]);

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
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 768px)');
    const apply = () => {
      if (mq.matches && useUIStore.getState().sidebarOpen) {
        setSidebarOpen(false);
      }
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [setSidebarOpen]);
  // Install WS handlers exactly once for the whole app. Every other consumer
  // (ChatInput, ConfirmDialog, SettingsPanel) uses the cheap `useWebSocket()`
  // hook which returns action methods only — see hooks/useWebSocket.ts for
  // the duplicate-handler trap this avoids.
  useWebSocketBootstrap();

  useEffect(() => {
    publishDesktopPrefsSnapshot();
    return useLocalPrefs.subscribe((next, prev) => {
      if (
        next.yolo === prev.yolo &&
        next.nextPrediction === prev.nextPrediction &&
        next.contextAutoCompact === prev.contextAutoCompact
      ) {
        return;
      }
      publishDesktopPrefsSnapshot();
    });
  }, []);

  // Desktop shell integration. Electron hosts the real WebUI in a
  // WebContentsView and sends this event when the native sidebar asks to open a
  // WebUI surface. Browser users never see this path.
  useEffect(() => {
    const applyDesktopCommand = (rawDetail: unknown): boolean => {
      const detail =
        rawDetail && typeof rawDetail === 'object' && !Array.isArray(rawDetail)
          ? (rawDetail as Record<string, unknown>)
          : {};
      const ui = useUIStore.getState();
      const ws = getWSClient(useConfigStore.getState().wsUrl);
      let handled = false;

      const openDesktopView = (view: string): void => {
        navigateToView(view as never);
        if (view === 'sessions') {
          ws?.listSessions?.(50);
        }
      };

      const activity = detail['activity'];
      if (typeof activity === 'string' && (PANEL_ORDER as readonly string[]).includes(activity)) {
        const nextActivity = activity as (typeof PANEL_ORDER)[number];
        showPanel(nextActivity);
        handled = true;
        if (detail['view'] === undefined) {
          const fallbackView = pairedViewForActivity(nextActivity);
          if (fallbackView === 'sessions') {
            ws?.listSessions?.(50);
          }
        }
      }

      const view = detail['view'];
      if (typeof view === 'string' && DESKTOP_COMMAND_VIEWS.has(view)) {
        openDesktopView(view);
        handled = true;
      }

      const action = detail['action'];
      if (action === 'new-session') {
        ws?.newSession?.();
        showPanel('chat');
        handled = true;
      } else if (action === 'clear-context') {
        streamCoalescer.dropAll();
        useChatStore.getState().clearMessages();
        ws?.clearContext?.();
        showPanel('chat');
        handled = true;
      } else if (action === 'compact-context') {
        ws?.compactContext?.();
        showPanel('chat');
        handled = true;
      } else if (action === 'repair-context') {
        ws?.repairContext?.();
        showPanel('chat');
        handled = true;
      } else if (action === 'download-chat') {
        downloadChatAsMarkdown();
        handled = true;
      } else if (action === 'focus-chat') {
        showPanel('chat');
        window.requestAnimationFrame(() => document.querySelector('textarea')?.focus());
        handled = true;
      } else if (action === 'open-command-palette') {
        setPaletteOpen(true);
        handled = true;
      } else if (action === 'open-shortcuts') {
        setShortcutsOpen(true);
        handled = true;
      } else if (action === 'search-chat') {
        setSearchOpen(true);
        handled = true;
      } else if (action === 'open-model-switcher') {
        setModelSwitcherOpen(true);
        handled = true;
      } else if (action === 'open-prompt-library') {
        setPromptLibraryOpen(true);
        handled = true;
      }

      const dockSection = detail['dockSection'];
      if (typeof dockSection === 'string' && DESKTOP_COMMAND_DOCKS.has(dockSection)) {
        const section = dockSection as DockSection;
        ui.showDockChip(section);
        ui.setDockCustomizeOpen(false);
        handled = true;
        if (dockSection === 'autophase') {
          openMainView('autophase');
          ui.setDockSection(null);
          return handled;
        }
        showPanel('chat');
        ui.setDockSection(section);
        if (dockSection === 'goal') {
          ws?.send?.({ type: 'goal.get' });
        }
      }

      const workTab = detail['workTab'];
      if (typeof workTab === 'string' && DESKTOP_COMMAND_WORK_TABS.has(workTab)) {
        ui.showDockChip('work');
        ui.setDockCustomizeOpen(false);
        showPanel('chat');
        ui.setDockSection('work');
        ui.setWorkDashboardTab(workTab as never);
        handled = true;
        if (workTab === 'plan') {
          ws?.getPlan?.();
        }
      }

      const overlay = detail['overlay'];
      if (overlay === 'fleet') {
        setFleetMonitorOpen(true);
        handled = true;
      } else if (overlay === 'agents-monitor') {
        setAgentsMonitorOpen(true);
        handled = true;
      } else if (overlay === 'processes') {
        setProcessMonitorOpen(true);
        handled = true;
      } else if (overlay === 'queue') {
        setQueuePanelOpen(true);
        handled = true;
      }

      if (detail['terminal'] === 'toggle') {
        ui.toggleTerminal();
        handled = true;
      } else if (detail['terminal'] === 'new') {
        if (ui.terminalOpen) {
          ui.requestTerminalCreate();
        } else {
          setTerminalOpen(true);
        }
        handled = true;
      } else if (detail['terminal'] === true) {
        setTerminalOpen(true);
        handled = true;
      } else if (detail['terminal'] === false) {
        setTerminalOpen(false);
        handled = true;
      }

      const pref = detail['pref'];
      if (pref && typeof pref === 'object' && !Array.isArray(pref)) {
        const command = pref as Record<string, unknown>;
        const key = command['key'];
        if (key === 'yolo' || key === 'nextPrediction' || key === 'contextAutoCompact') {
          const prefs = useLocalPrefs.getState();
          const value = command['toggle'] === true ? !prefs[key] : command['value'];
          if (typeof value === 'boolean') {
            const patch = { [key]: value };
            prefs.set(patch);
            ws?.updatePrefs?.(patch);
            if (key === 'yolo') {
              toast.info(`YOLO ${value ? 'enabled' : 'disabled'}`);
            }
            handled = true;
          }
        }
      }

      return handled;
    };

    const handledDesktopCommandIds = new Set<string>();
    const handledDesktopCommandOrder: string[] = [];
    const rememberHandledDesktopCommand = (requestId: string): void => {
      handledDesktopCommandIds.add(requestId);
      handledDesktopCommandOrder.push(requestId);
      while (handledDesktopCommandOrder.length > 120) {
        const stale = handledDesktopCommandOrder.shift();
        if (stale) handledDesktopCommandIds.delete(stale);
      }
    };

    const handleDesktopCommand = (rawDetail: unknown): void => {
      const detail =
        rawDetail && typeof rawDetail === 'object' && !Array.isArray(rawDetail)
          ? (rawDetail as Record<string, unknown>)
          : {};
      const requestId = detail['requestId'];
      if (typeof requestId === 'string' && handledDesktopCommandIds.has(requestId)) {
        publishDesktopCommandAck(requestId, true);
        return;
      }
      try {
        const handled = applyDesktopCommand(rawDetail);
        if (handled && typeof requestId === 'string') {
          rememberHandledDesktopCommand(requestId);
        }
        publishDesktopCommandAck(requestId, handled);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        publishDesktopCommandAck(requestId, false, message);
        console.error(err);
      }
    };

    const bridge = (
      window as unknown as {
        wrongstackDesktopCommands?: {
          subscribe?: (cb: (command: Record<string, unknown>) => void) => () => void;
        };
      }
    ).wrongstackDesktopCommands;
    const unsubscribe =
      bridge?.subscribe?.((command) => {
        handleDesktopCommand(command);
      }) ?? null;
    const onDesktopCommand = (event: Event): void => {
      handleDesktopCommand((event as CustomEvent<Record<string, unknown>>).detail);
    };
    window.addEventListener('wrongstack:desktop-command', onDesktopCommand);
    (window as unknown as { __wrongstackDesktopReady?: boolean }).__wrongstackDesktopReady = true;
    publishDesktopReady(true);
    return () => {
      (window as unknown as { __wrongstackDesktopReady?: boolean }).__wrongstackDesktopReady =
        false;
      publishDesktopReady(false);
      if (unsubscribe) unsubscribe();
      window.removeEventListener('wrongstack:desktop-command', onDesktopCommand);
    };
  }, [
    setAgentsMonitorOpen,
    setFleetMonitorOpen,
    setModelSwitcherOpen,
    setPaletteOpen,
    setPromptLibraryOpen,
    setProcessMonitorOpen,
    setQueuePanelOpen,
    setSearchOpen,
    setShortcutsOpen,
    setTerminalOpen,
  ]);

  // F5-resilience: the zustand persist middleware writes asynchronously
  // after every mutation. When the page tears down via F5 / tab close /
  // navigation, in-flight writes can be lost. We hook `pagehide` (the
  // recommended event for bfcache + unload coverage) to force a flush so
  // the next visit finds the latest state. The flush is silent — we
  // don't want a user-visible error if localStorage is full.
  useEffect(() => {
    const flush = (): void => {
      try {
        const stores = [useSessionStore, useChatStore, useUIStore, useConfigStore];
        for (const s of stores) {
          const persistApi = (
            s as unknown as {
              persist?: { flush?: () => void; getOptions?: () => { storage?: unknown } };
            }
          ).persist;
          if (persistApi && typeof persistApi.flush === 'function') {
            persistApi.flush();
          }
        }
      } catch {
        // ignore — best-effort flush.
      }
    };
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
    };
  }, []);

  // F5-resilience: if the persisted view was something exotic (a debug
  // overlay, an inspector-only tab), fall back to chat on first mount.
  // The persisted view is intended for "user landed back on the chat
  // surface during normal work" — debug overlays should not auto-restore.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (
      window.location.pathname === '/debug' ||
      window.location.pathname === '/analytics' ||
      window.location.pathname === '/refresh-debug'
    ) {
      return;
    }
    const persistedView = useUIStore.getState().currentView;
    if (
      persistedView === 'debug' ||
      persistedView === 'analytics' ||
      persistedView === 'design-gallery' ||
      persistedView === 'setup'
    ) {
      showPanel('chat');
    }
  }, []);

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

  // Global keyboard shortcuts for the actions that don't have a dedicated
  // owner (palette/shortcuts handle their own). Bound here so they fire
  // anywhere except inside text inputs (where Ctrl+F should still search
  // the chat, but Ctrl+L would otherwise be a browser address-bar focus).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName?.toLowerCase();
      const inField = tag === 'input' || tag === 'textarea' || t?.isContentEditable;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === '\\') {
        e.preventDefault();
        toggleSidebar();
        return;
      }
      // Ctrl+` — toggle the integrated terminal bottom-dock (VS Code parity).
      if (mod && e.key === '`') {
        e.preventDefault();
        useUIStore.getState().toggleTerminal();
        return;
      }
      // Ctrl+1..9/0 — jump straight to a side panel (same logic as clicking
      // its ActivityBar icon, including close-on-repeat). Use an explicit
      // map instead of numeric PANEL_ORDER indexing because some panels use
      // non-sequential shortcuts (Design is Ctrl+0; Worktrees is Ctrl+Shift+W).
      if (mod && !e.shiftKey && !e.altKey && Object.hasOwn(ACTIVITY_SHORTCUT_BY_KEY, e.key)) {
        const activity = ACTIVITY_SHORTCUT_BY_KEY[e.key];
        if (activity) {
          e.preventDefault();
          openPanel(activity);
          return;
        }
      }
      if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'w') {
        e.preventDefault();
        openPanel('worktrees');
        return;
      }
      // F1..F12 — browser equivalents of the TUI function-key panels.
      // These are skipped while typing so editor/text-input conventions keep
      // working inside the chat box and code editor.
      if (!inField && !mod && !e.altKey && /^F([1-9]|1[0-2])$/.test(e.key)) {
        e.preventDefault();
        const ui = useUIStore.getState();
        const ws = getWSClient(useConfigStore.getState().wsUrl);
        const n = Number(e.key.slice(1));
        ui.setDockCustomizeOpen(false);
        switch (n) {
          case 1:
            openPanel('chat');
            return;
          case 2:
            ui.setFleetMonitorOpen(true);
            return;
          case 3:
            ui.setAgentsMonitorOpen(true);
            return;
          case 4:
            showPanel('worktrees');
            ui.setDockSection('worktrees');
            return;
          case 5:
            ws?.getPlan?.();
            showPanel('chat');
            ui.setDockSection('work');
            ui.setWorkDashboardTab('plan');
            return;
          case 6:
            showPanel('chat');
            ui.setDockSection('work');
            ui.setWorkDashboardTab('todos');
            return;
          case 7:
            ui.setQueuePanelOpen(true);
            return;
          case 8:
            ui.setProcessMonitorOpen(true);
            return;
          case 9:
            ws?.send?.({ type: 'goal.get' });
            showPanel('chat');
            ui.setDockSection('goal');
            return;
          case 10:
            ws?.listSessions?.(50);
            showPanel('history');
            return;
          case 11:
            showPanel('officemap');
            return;
          case 12:
            showPanel('chat');
            ui.setDockSection('work');
            ui.setDockCustomizeOpen(true);
            return;
        }
      }
      if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (mod && e.key.toLowerCase() === '/') {
        // Focus the chat textarea so the user can start typing without
        // hunting for it. Useful after closing palette/settings.
        e.preventDefault();
        const ta = document.querySelector('textarea');
        ta?.focus();
        return;
      }
      // The Ctrl-letter shortcuts skip when the user is typing in any
      // input — otherwise Ctrl+L wipes the chat while they're composing.
      // Access the WS client via the Zustand store instead of the `ws`
      // hook return value so we don't re-register this effect on every
      // render (useWebSocket() returns a fresh object each time).
      if (mod && !inField) {
        if (e.key.toLowerCase() === 'l') {
          e.preventDefault();
          streamCoalescer.dropAll();
          useChatStore.getState().clearMessages();
          getWSClient(useConfigStore.getState().wsUrl)?.clearContext?.();
        } else if (e.key.toLowerCase() === 'n') {
          e.preventDefault();
          getWSClient(useConfigStore.getState().wsUrl)?.newSession?.();
          showPanel('chat');
        } else if (e.key.toLowerCase() === 'e') {
          e.preventDefault();
          downloadChatAsMarkdown();
        }
      }
      // Ctrl+Shift+D toggles compact UI density. Distinct from Ctrl+D
      // (which is reserved as the browser bookmark accelerator).
      if (mod && e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        useUIStore.getState().toggleCompactMode();
      }
      // Ctrl+Shift+M — open inspector on Fleet tab (or toggle if already open)
      if (mod && e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        const s = useUIStore.getState();
        if (s.inspectorOpen && s.inspectorTab === 'fleet') {
          toggleInspector();
        } else {
          setInspectorTab('fleet');
          if (!s.inspectorOpen) toggleInspector();
        }
      }
      // Ctrl+Shift+A — open inspector on Agents tab (or toggle if already open)
      if (mod && e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        const s = useUIStore.getState();
        if (s.inspectorOpen && s.inspectorTab === 'agents') {
          toggleInspector();
        } else {
          setInspectorTab('agents');
          if (!s.inspectorOpen) toggleInspector();
        }
      }
      // Ctrl+Shift+G — open Debug Dashboard
      if (mod && e.shiftKey && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        navigateToView('debug');
      }
      // Escape — collapse the inspector panel when it's open (DevTools
      // habit). Runs only when the inspector is visible so it doesn't steal
      // Esc from search / palette / bubble-focus dismissal.
      if (e.key === 'Escape' && !mod && useUIStore.getState().inspectorOpen) {
        useUIStore.getState().setInspectorOpen(false);
      }
      // Vim-style chat navigation: j/k step between bubbles, g goes to the
      // first message and G to the last. Skipped while typing so j/k inside
      // the textarea still inserts those letters. No modifier required —
      // this is the chat surface's primary input mode for keyboard users.
      if (!inField && !mod && !e.altKey) {
        const bubbles = Array.from(document.querySelectorAll<HTMLElement>('[data-message-id]'));
        if (bubbles.length === 0) return;
        const current = document.querySelector<HTMLElement>(
          '[data-message-id][data-focused="true"]',
        );
        const idx = current ? bubbles.indexOf(current) : -1;
        const focusBubble = (target: HTMLElement) => {
          for (const b of bubbles) b.removeAttribute('data-focused');
          target.setAttribute('data-focused', 'true');
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        };
        if (e.key === 'j' || e.key === 'ArrowDown') {
          // ArrowDown only intercepts when nothing else has focus AND the
          // user is not in a scrollable list context — the textarea check
          // above covers the only place arrows have meaningful default
          // behaviour for this app.
          const next = bubbles[Math.min(bubbles.length - 1, Math.max(0, idx + 1))];
          if (next) {
            e.preventDefault();
            focusBubble(next);
          }
          return;
        }
        if (e.key === 'k' || e.key === 'ArrowUp') {
          const prev = bubbles[Math.max(0, idx <= 0 ? 0 : idx - 1)];
          if (prev) {
            e.preventDefault();
            focusBubble(prev);
          }
          return;
        }
        if (e.key === 'g' && !e.shiftKey) {
          e.preventDefault();
          focusBubble(expectDefined(bubbles[0]));
          return;
        }
        if (e.key === 'G' || (e.key === 'g' && e.shiftKey)) {
          e.preventDefault();
          focusBubble(expectDefined(bubbles[bubbles.length - 1]));
          return;
        }
        if (e.key === 'Escape' && current) {
          e.preventDefault();
          current.removeAttribute('data-focused');
          return;
        }
        // `c` while a bubble is focused: copy its visible text. Useful
        // pairing with the j/k flow so power users can step + copy without
        // hunting for the in-bubble copy button.
        if (e.key === 'c' && current) {
          const text =
            current.querySelector<HTMLElement>('.markdown-content')?.innerText ?? current.innerText;
          if (text) {
            void navigator.clipboard?.writeText(text).catch(() => {});
            e.preventDefault();
          }
          return;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleSidebar, setSearchOpen]);

  return (
    <div
      data-shell={desktopShell ? 'desktop' : 'browser'}
      className={cn(
        'ws-app-root flex min-h-0 min-w-0 overflow-hidden',
        desktopShell && 'ws-desktop-shell',
        theme,
      )}
    >
      {/* ── Activity Bar — hidden during setup ── */}
      {currentView !== 'setup' && <ActivityBar desktopShell={desktopShell} />}

      {/* ── Secondary Panel — collapsible, context-sensitive ── */}
      {sidebarOpen && currentView !== 'setup' && <SidePanel desktopShell={desktopShell} />}

      {/* ── Main area ── */}
      <main className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden bg-background/70">
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
            {/* WorkspaceDock — one slim chip strip (AutoPhase, Goal, Fleet,
                Work, Worktrees, Collab); at most one panel expands below it
                instead of the old always-on vertical pile. */}
            {/* shrink-0 + capped height + own scroll: an expanded dock section
                (Work tasks, Fleet, AutoPhase board, …) must never grow tall
                enough to push the chat transcript off-screen and kill its
                scroll. The dock scrolls internally past the cap; ChatView keeps
                the remaining height as its own scroll region. */}
            {sessionId && (
              <div
                className={cn(
                  'ws-workspace-dock-wrap px-3 sm:px-4 pt-2 shrink-0 overflow-y-auto overscroll-contain',
                  terminalOpen ? 'max-h-[28dvh]' : 'max-h-[45dvh]',
                )}
              >
                <WorkspaceDock sessionId={sessionId} />
              </div>
            )}
            <ErrorBoundary level="panel" name="Chat">
              <ChatView />
            </ErrorBoundary>
            {/* Bottom inspector panel — DevTools-style dock that slides
                up/down. Replaces the fixed BottomDock (which blocked the
                chat input) and the modal Fleet/Agents drawers. Lives in the
                chat view so it doesn't clutter settings/sessions. */}
            <ErrorBoundary level="panel" name="Inspector">
              <InspectorPanel />
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
        {currentView === 'setup' && (
          <ErrorBoundary level="panel" name="Setup">
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
              <SetupScreen />
            </div>
          </ErrorBoundary>
        )}
        {currentView === 'autophase' && (
          <ErrorBoundary level="panel" name="AutoPhase">
            <Suspense fallback={<PanelSuspense />}>
              <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
                <AutoPhaseView onClose={() => showPanel('chat')} />
              </div>
            </Suspense>
          </ErrorBoundary>
        )}
        {currentView === 'specs' && (
          <ErrorBoundary level="panel" name="Specs">
            <Suspense fallback={<PanelSuspense />}>
              <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
                <SpecsView onClose={() => showPanel('chat')} />
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
        {currentView === 'sddboard' && (
          <ErrorBoundary level="panel" name="SDD Board">
            <Suspense fallback={<PanelSuspense />}>
              <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
                <SddBoardView onClose={() => showPanel('chat')} />
              </div>
            </Suspense>
          </ErrorBoundary>
        )}
        {currentView === 'sddwizard' && (
          <ErrorBoundary level="panel" name="SDD Wizard">
            <Suspense fallback={<PanelSuspense />}>
              <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
                <SddWizard onClose={() => showPanel('chat')} />
              </div>
            </Suspense>
          </ErrorBoundary>
        )}
        {currentView === 'sessions' && (
          <ErrorBoundary level="panel" name="Sessions">
            <Suspense fallback={<PanelSuspense />}>
              <div className="flex-1 min-h-0 min-w-0 overflow-y-auto">
                <SessionsDashboard />
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
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
              <ChangesView className="h-full min-h-0" />
            </div>
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

      {/* Fleet Monitor sidebar overlay */}
      {fleetMonitorOpen && (
        <ErrorBoundary level="panel" name="Fleet Monitor">
          <FleetMonitor onClose={() => setFleetMonitorOpen(false)} />
        </ErrorBoundary>
      )}

      {/* Agents Monitor sidebar overlay */}
      {agentsMonitorOpen && (
        <ErrorBoundary level="panel" name="Agents Monitor">
          <Suspense fallback={null}>
            <AgentsMonitor onClose={() => setAgentsMonitorOpen(false)} />
          </Suspense>
        </ErrorBoundary>
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
