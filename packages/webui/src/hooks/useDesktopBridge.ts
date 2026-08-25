import { useEffect } from 'react';
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
import { getWSClient } from '@/lib/ws-client';
import {
  type DockSection,
  resetUiNavigationToHome,
  useChatStore,
  useConfigStore,
  useUIStore,
} from '@/stores';
import { useLocalPrefs } from '@/stores/local-prefs';
import {
  navigateToView,
  openMainView,
  showPanel,
} from '@/components/activity-bar/nav';
import { PANEL_ORDER } from '@/components/activity-bar';
import { downloadChatAsMarkdown } from '@/components/CommandPalette';
import { toast } from '@/components/Toaster';
import { useSystemPromptStore } from '@/stores/system-prompt-store';

export interface UseDesktopBridgeOptions {
  setPaletteOpen: (open: boolean) => void;
  setSearchOpen: (open: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
  setModelSwitcherOpen: (open: boolean) => void;
  setPromptLibraryOpen: (open: boolean) => void;
  setFleetMonitorOpen: (open: boolean) => void;
  setAgentsMonitorOpen: (open: boolean) => void;
  setProcessMonitorOpen: (open: boolean) => void;
  setQueuePanelOpen: (open: boolean) => void;
  setCronJobsOpen: (open: boolean) => void;
  setTerminalOpen: (open: boolean) => void;
}

/**
 * Desktop-shell bridge integration.
 *
 * Three responsibilities, all scoped to the Electron desktop shell (browser
 * users see no-ops):
 *
 * 1. **Nav reset** — collapse the sidebar on first mount when running inside
 *    the native shell (the native sidebar replaces ours).
 * 2. **Prefs snapshot** — mirror local preferences (yolo, context auto-compact,
 *    next-prediction) to the native host so its menus reflect the current state.
 * 3. **Command bridge** — subscribe to `wrongstackDesktopCommands` (native →
 *    WebUI) and `wrongstack:desktop-command` (legacy event) and dispatch
 *    view/nav/overlay/tool actions the native sidebar sends.
 */
export function useDesktopBridge(options: UseDesktopBridgeOptions): void {
  const {
    setPaletteOpen,
    setSearchOpen,
    setShortcutsOpen,
    setModelSwitcherOpen,
    setPromptLibraryOpen,
    setFleetMonitorOpen,
    setAgentsMonitorOpen,
    setProcessMonitorOpen,
    setQueuePanelOpen,
    setTerminalOpen,
  } = options;

  const desktopShell = isDesktopShell();

  // ── 1. Desktop shell nav reset ────────────────────────────────────────────
  useEffect(() => {
    if (!desktopShell) return;
    resetUiNavigationToHome({ sidebarOpen: false });
  }, [desktopShell]);

  // ── 2. Prefs snapshot ─────────────────────────────────────────────────────
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

  // ── 3. Desktop command bridge ─────────────────────────────────────────────
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
      }

      const view = detail['view'];
      if (typeof view === 'string' && DESKTOP_COMMAND_VIEWS.has(view)) {
        openDesktopView(view);
        handled = true;
      }

      const action = detail['action'];
      if (action === 'new-session') {
        useSystemPromptStore.getState().openPicker({ startsSession: true });
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
        if (dockSection === 'goal') {
          openMainView('goal');
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
}
