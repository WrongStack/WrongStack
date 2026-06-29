import { expectDefined } from '@wrongstack/core';
import { useEffect } from 'react';
import { useWebSocketBootstrap } from '@/hooks/useWebSocket';
import { streamCoalescer } from '@/lib/stream-coalescer';
import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import { useChatStore, useConfigStore, useFileStore, useSessionStore, useUIStore } from '@/stores';
import { ActivityBar, openPanel, PANEL_ORDER } from './components/ActivityBar';
import { AgentsMonitor } from './components/AgentsMonitor';
import { AnalyticsDashboard } from './components/AnalyticsDashboard';
import { AutoPhaseView } from './components/AutoPhaseView';
import { ChangesView } from './components/ChangesView';
import { ChatView } from './components/ChatView';
import { CodeEditor } from './components/CodeEditor';
import { CommandPalette, downloadChatAsMarkdown } from './components/CommandPalette';
import { ConfirmDialog } from './components/ConfirmDialog';
import { ConfirmModalHost, PromptModalHost } from './components/ConfirmModal';
import { ConnectionBanner } from './components/ConnectionBanner';
import { DebugDashboard } from './components/DebugDashboard';
import { DesignGalleryView } from './components/DesignGalleryView';
import { ErrorBoundary } from './components/ErrorBoundary';
import { FleetMonitor } from './components/FleetMonitor';
import { InspectorPanel } from './components/InspectorPanel';
import { MailboxDetailView } from './components/MailboxDetailView';
import { OfficeMapPanel } from './components/OfficeMapPanel';
import { ProcessMonitor } from './components/ProcessMonitor';
import { QueuePanel } from './components/QueuePanel';
import { QuickModelSwitcher } from './components/QuickModelSwitcher';
import { RefreshDebugView } from './components/RefreshDebugView';
import { SddBoardView } from './components/SddBoardView';
import { SddWizard } from './components/SddWizard';
import { SessionsDashboard } from './components/SessionsDashboard';
import { SettingsPanel } from './components/SettingsPanel';
import { SetupScreen } from './components/SetupScreen';
import { ShortcutsOverlay } from './components/ShortcutsOverlay';
import { SidePanel } from './components/SidePanel';
import { SkillDetailView } from './components/SkillDetailView';
import { SpecsView } from './components/SpecsView';
import { TerminalPanel } from './components/TerminalPanel';
import { ThemeProvider, useTheme } from './components/ThemeProvider';
import { Toaster } from './components/Toaster';
import { WorkspaceDock } from './components/WorkspaceDock';

function AppInner() {
  const { theme } = useTheme();
  const {
    currentView,
    sidebarOpen,
    toggleSidebar,
    setSearchOpen,
    setSidebarOpen,
    setCurrentView,
    setInspectorTab,
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

  // Detect /debug, /analytics, /refresh-debug URL paths and switch views.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.location.pathname === '/debug') {
      setCurrentView('debug');
    } else if (window.location.pathname === '/analytics') {
      setCurrentView('analytics');
    } else if (window.location.pathname === '/refresh-debug') {
      setCurrentView('refresh-debug');
    }
  }, [setCurrentView]);

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
    if (window.location.pathname === '/refresh-debug') return;
    const persistedView = useUIStore.getState().currentView;
    if (
      persistedView === 'debug' ||
      persistedView === 'analytics' ||
      persistedView === 'design-gallery' ||
      persistedView === 'setup'
    ) {
      useUIStore.getState().setCurrentView('chat');
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
      // Ctrl+1..9 — jump straight to a side panel (same logic as clicking
      // its ActivityBar icon, including close-on-repeat).
      if (mod && !e.shiftKey && !e.altKey && e.key >= '1' && e.key <= String(PANEL_ORDER.length)) {
        const activity = PANEL_ORDER[Number(e.key) - 1];
        if (activity) {
          e.preventDefault();
          openPanel(activity);
          return;
        }
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
            openPanel('projects');
            return;
          case 2:
            ui.setFleetMonitorOpen(true);
            return;
          case 3:
            ui.setAgentsMonitorOpen(true);
            return;
          case 4:
            ui.setCurrentView('chat');
            ui.setDockSection('worktrees');
            return;
          case 5:
            ws?.getPlan?.();
            ui.setCurrentView('chat');
            ui.setDockSection('work');
            ui.setWorkDashboardTab('plan');
            return;
          case 6:
            ui.setCurrentView('chat');
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
            ui.setCurrentView('chat');
            ui.setDockSection('goal');
            return;
          case 10:
            ws?.listSessions?.(50);
            ui.setCurrentView('sessions');
            return;
          case 11:
            ui.setSidebarOpen(true);
            ui.selectActivity('officemap');
            ui.setCurrentView('officemap');
            return;
          case 12:
            ui.setCurrentView('chat');
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
          useUIStore.getState().setCurrentView('chat');
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
        setCurrentView('debug');
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
    <div className={cn('flex h-screen', theme)}>
      {/* ── Activity Bar — hidden during setup ── */}
      {currentView !== 'setup' && <ActivityBar />}

      {/* ── Secondary Panel — collapsible, context-sensitive ── */}
      {sidebarOpen && currentView !== 'setup' && <SidePanel />}

      {/* ── Main area ── */}
      <main className="flex-1 flex flex-col overflow-hidden">
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
              <div className="px-4 pt-2 shrink-0 max-h-[45vh] overflow-y-auto">
                <WorkspaceDock sessionId={sessionId} />
              </div>
            )}
            <ChatView />
            {/* Bottom inspector panel — DevTools-style dock that slides
                up/down. Replaces the fixed BottomDock (which blocked the
                chat input) and the modal Fleet/Agents drawers. Lives in
                the chat view so it doesn't clutter settings/sessions. */}
            <InspectorPanel />
          </>
        )}
        {currentView === 'settings' && <SettingsPanel />}
        {currentView === 'setup' && <SetupScreen />}
        {currentView === 'autophase' && <AutoPhaseView onClose={() => setCurrentView('chat')} />}
        {currentView === 'specs' && <SpecsView onClose={() => setCurrentView('chat')} />}
        {currentView === 'sddboard' && <SddBoardView onClose={() => setCurrentView('chat')} />}
        {currentView === 'sddwizard' && <SddWizard onClose={() => setCurrentView('chat')} />}
        {currentView === 'sessions' && (
          <div className="flex-1 overflow-y-auto">
            <SessionsDashboard />
          </div>
        )}
        {/* ── Debug Dashboard — accessed via /debug URL ── */}
        {currentView === 'debug' && <DebugDashboard />}

        {/* ── Refresh-resilience verifier — accessed via /refresh-debug URL. ──
         *  Lets the user confirm in-app that the latest active session
         *  pointer, transcript, and UI state survived an F5. Without a
         *  visible surface there's no way for the user to verify the
         *  contract from the WebUI itself, which was a stated requirement. */}
        {currentView === 'refresh-debug' && <RefreshDebugView />}

        {/* ── IDE Code Editor (only in Files view) ── */}
        {currentView === 'files' && <CodeEditor />}

        {/* ── Source-control diff — file list lives in the SidePanel ── */}
        {currentView === 'changes' && <ChangesView className="h-full" />}

        {/* ── Mailbox detail — wide main area; list lives in the SidePanel ── */}
        {currentView === 'mailbox' && <MailboxDetailView className="h-full" />}

        {/* ── Design Studio gallery — live kit previews ── */}
        {currentView === 'design-gallery' && (
          <div className="flex-1 overflow-hidden">
            <DesignGalleryView className="h-full" />
          </div>
        )}

        {/* ── Skill detail — wide main area; list lives in the SidePanel ── */}
        {currentView === 'skill' && (
          <div className="flex-1 overflow-hidden">
            <SkillDetailView className="h-full" />
          </div>
        )}

        {/* ── Office Map (Fleet HQ) — wide main area; settings in the SidePanel ── */}
        {currentView === 'officemap' && (
          <div className="flex-1 overflow-hidden">
            <OfficeMapPanel />
          </div>
        )}

        {/* ── Analytics Dashboard — event stats, session metrics, usage ── */}
        {currentView === 'analytics' && (
          <div className="flex-1 overflow-hidden">
            <AnalyticsDashboard />
          </div>
        )}
      </main>

      {/* Fleet Monitor sidebar overlay */}
      {fleetMonitorOpen && <FleetMonitor onClose={() => setFleetMonitorOpen(false)} />}

      {/* Agents Monitor sidebar overlay */}
      {agentsMonitorOpen && <AgentsMonitor onClose={() => setAgentsMonitorOpen(false)} />}

      {/* Process Monitor overlay — triggered by /kill */}
      {processMonitorOpen && (
        <ProcessMonitor open={processMonitorOpen} onClose={() => setProcessMonitorOpen(false)} />
      )}

      {/* Queue Panel overlay — triggered by /queue */}
      {queuePanelOpen && (
        <QueuePanel open={queuePanelOpen} onClose={() => setQueuePanelOpen(false)} />
      )}

      {/* Integrated terminal bottom-dock — toggled by Ctrl+` or /terminal */}
      {terminalOpen && <TerminalPanel onClose={() => setTerminalOpen(false)} />}

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
