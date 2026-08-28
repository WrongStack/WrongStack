import { expectDefined } from '@wrongstack/core/utils/expect-defined';
import { useEffect } from 'react';
import {
  ACTIVITY_SHORTCUT_BY_KEY,
  navigateToView,
  openMainView,
  openPanel,
  showPanel,
} from '@/components/activity-bar/nav';
import { downloadChatAsMarkdown } from '@/components/CommandPalette';
import { streamCoalescer } from '@/lib/stream-coalescer';
import { getWSClient } from '@/lib/ws-client';
import {
  useChatStore,
  useConfigStore,
  useHistoryStore,
  useSessionTabStore,
  useUIStore,
} from '@/stores';
import { useSystemPromptStore } from '@/stores/system-prompt-store';

export interface UseGlobalKeyboardShortcutsOptions {
  toggleSidebar: () => void;
  setSearchOpen: (open: boolean) => void;
  toggleInspector: () => void;
  setInspectorTab: (tab: 'fleet' | 'agents' | 'sideEffects') => void;
}

/**
 * Global keyboard shortcuts.
 *
 * One shared `keydown` listener on `window` that covers:
 * - Ctrl+\ / Ctrl+` — sidebar / terminal toggles
 * - Ctrl+1..0 / Ctrl+Shift+W — activity-panel jump shortcuts
 * - F1..F12 — TUI parity function keys
 * - Ctrl+F / Ctrl+/ — search / textarea focus
 * - Ctrl+L / Ctrl+N / Ctrl+E — clear chat / new session / export markdown
 * - Ctrl+Shift+{D,M,A,G} — compact mode, inspector, debug
 * - Esc — inspector collapse, run abort
 * - j/k / g/G — vim-style bubble navigation
 *
 * Bound in App.tsx's root so they fire anywhere, but skip while the user
 * is typing in a text input/textarea/content-editable (except Ctrl+F which
 * searches the chat and Ctrl+/ which focuses the textarea).
 */
export function useGlobalKeyboardShortcuts(options: UseGlobalKeyboardShortcutsOptions): void {
  const { toggleSidebar, setSearchOpen, toggleInspector, setInspectorTab } = options;

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
      // non-sequential shortcuts (Design is Ctrl+0).
      if (mod && !e.shiftKey && !e.altKey && Object.hasOwn(ACTIVITY_SHORTCUT_BY_KEY, e.key)) {
        const activity = ACTIVITY_SHORTCUT_BY_KEY[e.key];
        if (activity) {
          e.preventDefault();
          openPanel(activity);
          return;
        }
      }
      // Ctrl+9 — jump to Settings (standalone main view, not a side panel)
      if (mod && e.key === '9' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        openMainView('settings');
        return;
      }
      // Ctrl+Shift+W — Worktrees tab of the Changes panel (moved off the
      // ActivityBar; the chord keeps its familiar meaning).
      if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'w') {
        e.preventDefault();
        useUIStore.getState().setChangesPanelTab('worktrees');
        openPanel('changes');
        return;
      }
      // Ctrl+Shift+E — toggle / focus File Explorer (VS Code parity)
      if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        openPanel('chat');
        return;
      }
      // Ctrl+Shift+F — open global search dialog
      if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      // Alt+1..9 — jump directly to open session tab (browser / multiplexer parity)
      if (e.altKey && !mod && !e.shiftKey && /^[1-9]$/.test(e.key)) {
        const idx = Number(e.key) - 1;
        const entries = useHistoryStore.getState().entries;
        const target = entries[idx];
        if (target) {
          e.preventDefault();
          const client = getWSClient(useConfigStore.getState().wsUrl);
          useSessionTabStore.getState().openTab(target.id, {
            resumeSession: (id) => client?.resumeSession?.(id),
          });
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
            openPanel('chat');
            return;
          case 2:
            ui.setFleetMonitorOpen(true);
            return;
          case 3:
            ui.setAgentsMonitorOpen(true);
            return;
          case 4:
            ui.setChangesPanelTab('worktrees');
            showPanel('changes');
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
            ws?.send?.({ type: 'goal-state.get' });
            showPanel('chat');
            ui.setDockSection('goal-state');
            return;
          case 10:
            ws?.listSessions?.(200);
            showPanel('chat');
            return;
          case 11:
            ui.setAgentRosterActiveTab('officemap');
            openMainView('roster');
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
          useSystemPromptStore.getState().openPicker({ startsSession: true });
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
      // Ctrl+Shift+K — open Memory (K for Knowledge)
      if (mod && e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openMainView('memory');
        return;
      }
      // Escape — collapse the inspector panel when it's open (DevTools
      // habit). Runs only when the inspector is visible so it doesn't steal
      // Esc from search / palette / bubble-focus dismissal.
      if (e.key === 'Escape' && !mod && useUIStore.getState().inspectorOpen) {
        useUIStore.getState().setInspectorOpen(false);
      }
      // Escape — abort the in-flight run (advertised in ShortcutsOverlay;
      // TUI parity). Deliberately lowest priority: overlays consume Esc in
      // their own handlers, the inspector collapse above wins, a focused
      // bubble is dismissed by the vim-nav block below, and while typing in
      // a field Esc keeps its local meaning (e.g. closing slash suggestions).
      if (e.key === 'Escape' && !mod && !inField) {
        const ui = useUIStore.getState();
        const overlayOpen =
          ui.inspectorOpen ||
          ui.searchOpen ||
          ui.paletteOpen ||
          ui.shortcutsOpen ||
          ui.modelSwitcherOpen ||
          ui.promptLibraryOpen;
        const focusedBubble = document.querySelector('[data-message-id][data-focused="true"]');
        if (!overlayOpen && !focusedBubble && useChatStore.getState().isLoading) {
          getWSClient(useConfigStore.getState().wsUrl).sendAbort();
        }
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
}
