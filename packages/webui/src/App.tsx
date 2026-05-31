import { useEffect } from 'react';
import { useWebSocketBootstrap } from '@/hooks/useWebSocket';
import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import { useChatStore, useConfigStore, useSessionStore, useUIStore } from '@/stores';
import { ChatView } from './components/ChatView';
import { CommandPalette, downloadChatAsMarkdown } from './components/CommandPalette';
import { ConfirmDialog } from './components/ConfirmDialog';
import { ConnectionBanner } from './components/ConnectionBanner';
import { ErrorBoundary } from './components/ErrorBoundary';
import { QuickModelSwitcher } from './components/QuickModelSwitcher';
import { SettingsPanel } from './components/SettingsPanel';
import { ShortcutsOverlay } from './components/ShortcutsOverlay';
import { Sidebar } from './components/Sidebar';
import { ThemeProvider, useTheme } from './components/ThemeProvider';
import { Toaster } from './components/Toaster';

function AppInner() {
  const { theme } = useTheme();
  const { currentView, sidebarOpen, toggleSidebar, setSearchOpen, setSidebarOpen } = useUIStore();
  const isLoading = useChatStore((s) => s.isLoading);
  const iteration = useSessionStore((s) => s.iteration);
  const projectName = useSessionStore((s) => s.projectName);
  const sessionTitle = useSessionStore((s) => s.session?.title);
  const sessionId = useSessionStore((s) => s.session?.id);
  const nickname = useUIStore((s) => (sessionId ? s.sessionNicknames[sessionId] : undefined));

  // Mobile-friendly: collapse the sidebar automatically below the md breakpoint
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

  // Install WS handlers exactly once for the whole app
  useWebSocketBootstrap();

  // Reflect the agent's run state + session identity in the browser tab title
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
    parts.push('WrongStack');
    const title = parts.filter(Boolean).join(' · ');
    document.title = title;
    return () => {
      document.title = 'WrongStack';
    };
  }, [isLoading, iteration, projectName, sessionTitle, nickname]);

  // Global keyboard shortcuts
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
      if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (mod && e.key === '/') {
        e.preventDefault();
        const ta = document.querySelector('.chat-input textarea');
        if (ta) {
          (ta as HTMLElement).focus();
        }
        return;
      }
      if (mod && !inField) {
        if (e.key.toLowerCase() === 'l') {
          e.preventDefault();
          useChatStore.getState().clearMessages();
          getWSClient(useConfigStore.getState().wsUrl)?.clearContext?.();
        } else if (e.key.toLowerCase() === 'n') {
          e.preventDefault();
          getWSClient(useConfigStore.getState().wsUrl)?.newSession?.();
        } else if (e.key.toLowerCase() === 'e') {
          e.preventDefault();
          downloadChatAsMarkdown();
        }
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        useUIStore.getState().toggleCompactMode();
      }
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
          focusBubble(bubbles[0]!);
          return;
        }
        if (e.key === 'G' || (e.key === 'g' && e.shiftKey)) {
          e.preventDefault();
          focusBubble(bubbles[bubbles.length - 1]!);
          return;
        }
        if (e.key === 'Escape' && current) {
          e.preventDefault();
          current.removeAttribute('data-focused');
          return;
        }
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
    <div className="flex h-screen">
      {sidebarOpen && <Sidebar />}
      <main className="flex-1 flex flex-col overflow-hidden">
        <ConnectionBanner />
        {currentView === 'chat' && <ChatView />}
        {currentView === 'settings' && <SettingsPanel />}
      </main>
      {/* Global overlays */}
      <ConfirmDialog />
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
