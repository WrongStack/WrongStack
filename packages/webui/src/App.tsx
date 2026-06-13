import { expectDefined } from '@wrongstack/core';
import { useWebSocketBootstrap } from '@/hooks/useWebSocket';
import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import { useChatStore, useConfigStore, useFileStore, useSessionStore, useUIStore } from '@/stores';
import { useEffect } from 'react';
import { ActivityBar, openPanel, PANEL_ORDER } from './components/ActivityBar';
import { AgentsPage } from './components/AgentsPage';
import { AutoPhaseView } from './components/AutoPhaseView';
import { ChatView } from './components/ChatView';
import { CodeEditor } from './components/CodeEditor';
import { CommandPalette, downloadChatAsMarkdown } from './components/CommandPalette';
import { ConfirmDialog } from './components/ConfirmDialog';
import { ConfirmModalHost } from './components/ConfirmModal';
import { ConnectionBanner } from './components/ConnectionBanner';
import { ErrorBoundary } from './components/ErrorBoundary';
import { QuickModelSwitcher } from './components/QuickModelSwitcher';
import { SettingsPanel } from './components/SettingsPanel';
import { SetupScreen } from './components/SetupScreen';
import { SessionsDashboard } from './components/SessionsDashboard';
import { ShortcutsOverlay } from './components/ShortcutsOverlay';
import { ThemeProvider, useTheme } from './components/ThemeProvider';
import { Toaster } from './components/Toaster';
import { AgentFlowGraph } from './components/AgentFlowGraph';
import { SidePanel } from './components/SidePanel';
import { WorkspaceDock } from './components/WorkspaceDock';
import { AgentsMonitor } from './components/AgentsMonitor';
import { FleetMonitor } from './components/FleetMonitor';
function AppInner() {
  const { theme } = useTheme();
  const { currentView, sidebarOpen, toggleSidebar, setSearchOpen, setSidebarOpen, setCurrentView, fleetMonitorOpen, agentsMonitorOpen, setFleetMonitorOpen, setAgentsMonitorOpen } = useUIStore();
  const isLoading = useChatStore((s) => s.isLoading);
  const iteration = useSessionStore((s) => s.iteration);
  const projectName = useSessionStore((s) => s.projectName);
  const sessionTitle = useSessionStore((s) => s.session?.title);
  const sessionId = useSessionStore((s) => s.session?.id);
  const nickname = useUIStore((s) => (sessionId ? s.sessionNicknames[sessionId] : undefined));

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
      // Ctrl+1..6 — jump straight to a side panel (same logic as clicking
      // its ActivityBar icon, including close-on-repeat).
      if (mod && !e.shiftKey && !e.altKey && e.key >= '1' && e.key <= String(PANEL_ORDER.length)) {
        const activity = PANEL_ORDER[Number(e.key) - 1];
        if (activity) {
          e.preventDefault();
          openPanel(activity);
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
      // Ctrl+Shift+M — Fleet Monitor overlay  (Ctrl+Shift+F is browser Find)
      if (mod && e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        useUIStore.getState().setFleetMonitorOpen(!useUIStore.getState().fleetMonitorOpen);
      }
      // Ctrl+Shift+A — Agents Monitor overlay  (Ctrl+Shift+G is browser Find Next)
      if (mod && e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        useUIStore.getState().setAgentsMonitorOpen(!useUIStore.getState().agentsMonitorOpen);
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
            {sessionId && (
              <div className="px-4 pt-2">
                <WorkspaceDock sessionId={sessionId} />
              </div>
            )}
            <ChatView />
          </>
        )}
        {currentView === 'settings' && <SettingsPanel />}
        {currentView === 'setup' && <SetupScreen />}
        {currentView === 'autophase' && (
          <AutoPhaseView onClose={() => setCurrentView('chat')} />
        )}
        {currentView === 'agents' && (
          <div className="flex-1 flex flex-col overflow-hidden">
            <AgentsPage />
          </div>
        )}
        {currentView === 'agentflow' && (
          <div className="flex-1 flex flex-col overflow-hidden">
            <AgentFlowGraph />
          </div>
        )}
        {currentView === 'fleet' && (
          <div className="flex-1 flex flex-col overflow-hidden">
            <FleetMonitor isOverlay={false} />
          </div>
        )}
        {currentView === 'sessions' && (
          <div className="flex-1 overflow-y-auto">
            <SessionsDashboard />
          </div>
        )}
        {/* ── IDE Code Editor (only in Files view) ── */}
        {currentView === 'files' && <CodeEditor />}
      </main>

      {/* Fleet Monitor overlay — only when not already on fleet page */}
      {fleetMonitorOpen && currentView !== 'fleet' && (
        <FleetMonitor
          isOverlay={true}
          onClose={() => setFleetMonitorOpen(false)}
          onSelectAgent={(agent) => {
            // Open agent detail — close fleet monitor and open the agent
            setFleetMonitorOpen(false);
            setAgentsMonitorOpen(true);
          }}
        />
      )}

      {/* Agents Monitor overlay */}
      {agentsMonitorOpen && (
        <AgentsMonitor onClose={() => setAgentsMonitorOpen(false)} />
      )}

      {/* Global overlays */}
      <ConfirmDialog />
      <ConfirmModalHost />
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
