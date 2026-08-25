import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSystemPromptStore } from '../../src/stores/system-prompt-store.js';

// ── module stubs ────────────────────────────────────────────────────────────

const publishDesktopCommandAck = vi.fn();
const publishDesktopPrefsSnapshot = vi.fn();
const publishDesktopReady = vi.fn();
vi.mock('@/lib/desktop-host', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/desktop-host');
  return {
    ...actual,
    publishDesktopCommandAck,
    publishDesktopPrefsSnapshot,
    publishDesktopReady,
  };
});

let desktopShell = false;
vi.mock('@/lib/desktop-shell', () => ({ isDesktopShell: () => desktopShell }));

const dropAll = vi.fn();
vi.mock('@/lib/stream-coalescer', () => ({ streamCoalescer: { dropAll } }));

const wsClient = {
  listSessions: vi.fn(),
  newSession: vi.fn(),
  clearContext: vi.fn(),
  compactContext: vi.fn(),
  repairContext: vi.fn(),
  getPlan: vi.fn(),
  send: vi.fn(),
  updatePrefs: vi.fn(),
};
vi.mock('@/lib/ws-client', () => ({ getWSClient: () => wsClient }));

const nav = { navigateToView: vi.fn(), openMainView: vi.fn(), showPanel: vi.fn() };
vi.mock('@/components/activity-bar/nav', () => nav);

const downloadChatAsMarkdown = vi.fn();
vi.mock('@/components/CommandPalette', () => ({ downloadChatAsMarkdown }));

const toast = { success: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() };
vi.mock('@/components/Toaster', () => ({ toast }));

const resetUiNavigationToHome = vi.fn();
vi.mock('@/stores', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/stores');
  return { ...actual, resetUiNavigationToHome };
});

const { useChatStore, useUIStore } = await import('../../src/stores');
const { useLocalPrefs } = await import('../../src/stores/local-prefs');
const { useDesktopBridge } = await import('../../src/hooks/useDesktopBridge');

// ── harness ─────────────────────────────────────────────────────────────────

const opts = {
  setPaletteOpen: vi.fn(),
  setSearchOpen: vi.fn(),
  setShortcutsOpen: vi.fn(),
  setModelSwitcherOpen: vi.fn(),
  setPromptLibraryOpen: vi.fn(),
  setFleetMonitorOpen: vi.fn(),
  setAgentsMonitorOpen: vi.fn(),
  setProcessMonitorOpen: vi.fn(),
  setQueuePanelOpen: vi.fn(),
  setCronJobsOpen: vi.fn(),
  setTerminalOpen: vi.fn(),
};

function mount() {
  return renderHook(() => useDesktopBridge(opts));
}

/** Send a command through the legacy CustomEvent channel. */
function command(detail: unknown) {
  window.dispatchEvent(new CustomEvent('wrongstack:desktop-command', { detail }));
}

const UI_FNS = [
  'showDockChip',
  'setDockCustomizeOpen',
  'setDockSection',
  'setWorkDashboardTab',
  'toggleTerminal',
  'requestTerminalCreate',
] as const;

const ui = () => useUIStore.getState() as unknown as Record<string, ReturnType<typeof vi.fn>>;

describe('useDesktopBridge', () => {
  beforeEach(() => {
    desktopShell = false;
    for (const fn of Object.values(opts)) fn.mockReset();
    for (const fn of Object.values(wsClient)) fn.mockReset();
    for (const fn of Object.values(nav)) fn.mockReset();
    for (const fn of Object.values(toast)) fn.mockReset();
    publishDesktopCommandAck.mockReset();
    publishDesktopPrefsSnapshot.mockReset();
    publishDesktopReady.mockReset();
    resetUiNavigationToHome.mockReset();
    dropAll.mockReset();
    downloadChatAsMarkdown.mockReset();

    useUIStore.setState({
      terminalOpen: false,
      ...Object.fromEntries(UI_FNS.map((k) => [k, vi.fn()])),
    } as never);
    useChatStore.setState({ messages: [], clearMessages: vi.fn() } as never);
    useLocalPrefs.setState({
      yolo: false,
      nextPrediction: false,
      contextAutoCompact: false,
      set: vi.fn(),
    } as never);
    delete (window as unknown as Record<string, unknown>).wrongstackDesktopCommands;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── shell detection ───────────────────────────────────────────────────────

  describe('nav reset', () => {
    it('collapses the sidebar inside the native shell', () => {
      desktopShell = true;
      mount();
      expect(resetUiNavigationToHome).toHaveBeenCalledWith({ sidebarOpen: false });
    });

    it('is a no-op in a plain browser', () => {
      mount();
      expect(resetUiNavigationToHome).not.toHaveBeenCalled();
    });
  });

  // ── prefs snapshot ────────────────────────────────────────────────────────

  describe('prefs snapshot', () => {
    it('publishes once on mount', () => {
      mount();
      expect(publishDesktopPrefsSnapshot).toHaveBeenCalledTimes(1);
    });

    it('republishes when a mirrored pref changes', () => {
      mount();
      publishDesktopPrefsSnapshot.mockReset();
      useLocalPrefs.setState({ yolo: true } as never);
      expect(publishDesktopPrefsSnapshot).toHaveBeenCalledTimes(1);
    });

    it.each(['nextPrediction', 'contextAutoCompact'])('republishes on a %s change', (key) => {
      mount();
      publishDesktopPrefsSnapshot.mockReset();
      useLocalPrefs.setState({ [key]: true } as never);
      expect(publishDesktopPrefsSnapshot).toHaveBeenCalledTimes(1);
    });

    it('stays quiet for an unrelated pref change', () => {
      mount();
      publishDesktopPrefsSnapshot.mockReset();
      useLocalPrefs.setState({ maxIterations: 99 } as never);
      expect(publishDesktopPrefsSnapshot).not.toHaveBeenCalled();
    });

    it('unsubscribes on unmount', () => {
      const { unmount } = mount();
      unmount();
      publishDesktopPrefsSnapshot.mockReset();
      useLocalPrefs.setState({ yolo: true } as never);
      expect(publishDesktopPrefsSnapshot).not.toHaveBeenCalled();
    });
  });

  // ── readiness handshake ───────────────────────────────────────────────────

  describe('readiness handshake', () => {
    it('flags the window ready on mount and un-flags on unmount', () => {
      const { unmount } = mount();
      expect(publishDesktopReady).toHaveBeenLastCalledWith(true);
      expect((window as unknown as Record<string, unknown>).__wrongstackDesktopReady).toBe(true);

      unmount();
      expect(publishDesktopReady).toHaveBeenLastCalledWith(false);
      expect((window as unknown as Record<string, unknown>).__wrongstackDesktopReady).toBe(false);
    });

    it('subscribes to the native bridge when present', () => {
      const unsubscribe = vi.fn();
      const subscribe = vi.fn(() => unsubscribe);
      (window as unknown as Record<string, unknown>).wrongstackDesktopCommands = { subscribe };

      const { unmount } = mount();
      expect(subscribe).toHaveBeenCalled();

      // Commands delivered through the native channel are handled too.
      const cb = (subscribe.mock.calls as Array<Array<unknown>>)[0]?.[0] as unknown as (c: Record<string, unknown>) => void;
      cb({ action: 'open-command-palette' });
      expect(opts.setPaletteOpen).toHaveBeenCalledWith(true);

      unmount();
      expect(unsubscribe).toHaveBeenCalled();
    });

    it('works without a native bridge', () => {
      expect(() => mount()).not.toThrow();
    });

    it('stops handling commands after unmount', () => {
      const { unmount } = mount();
      unmount();
      command({ action: 'open-command-palette' });
      expect(opts.setPaletteOpen).not.toHaveBeenCalled();
    });
  });

  // ── acknowledgement ───────────────────────────────────────────────────────

  describe('acknowledgement', () => {
    it('acks a handled command', () => {
      mount();
      command({ requestId: 'r1', action: 'open-shortcuts' });
      expect(publishDesktopCommandAck).toHaveBeenCalledWith('r1', true);
    });

    it('acks an unrecognised command as unhandled', () => {
      mount();
      command({ requestId: 'r1', nonsense: true });
      expect(publishDesktopCommandAck).toHaveBeenCalledWith('r1', false);
    });

    it('acks a replayed requestId without re-running the command', () => {
      mount();
      command({ requestId: 'r1', action: 'open-shortcuts' });
      expect(opts.setShortcutsOpen).toHaveBeenCalledTimes(1);

      command({ requestId: 'r1', action: 'open-shortcuts' });
      expect(opts.setShortcutsOpen).toHaveBeenCalledTimes(1);
      expect(publishDesktopCommandAck).toHaveBeenLastCalledWith('r1', true);
    });

    it('does not dedupe an unhandled command — it was never remembered', () => {
      mount();
      command({ requestId: 'r1', nonsense: true });
      command({ requestId: 'r1', action: 'open-shortcuts' });
      expect(opts.setShortcutsOpen).toHaveBeenCalledTimes(1);
    });

    it('acks a failure with the error message instead of throwing', () => {
      mount();
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      nav.showPanel.mockImplementation(() => {
        throw new Error('nav exploded');
      });
      expect(() => command({ requestId: 'r1', action: 'new-session' })).not.toThrow();
      expect(publishDesktopCommandAck).toHaveBeenCalledWith('r1', false, 'nav exploded');
    });

    it('handles a command with no requestId', () => {
      mount();
      command({ action: 'open-shortcuts' });
      expect(opts.setShortcutsOpen).toHaveBeenCalledWith(true);
      expect(publishDesktopCommandAck).toHaveBeenCalledWith(undefined, true);
    });

    it('treats a non-object detail as an empty command', () => {
      mount();
      command('not an object');
      command(null);
      command(['a']);
      expect(publishDesktopCommandAck).toHaveBeenCalledWith(undefined, false);
    });

    it('evicts the oldest ids past the 120-entry dedupe window', () => {
      mount();
      for (let i = 0; i < 121; i++) command({ requestId: `r${i}`, action: 'open-shortcuts' });
      expect(opts.setShortcutsOpen).toHaveBeenCalledTimes(121);

      // r0 was evicted, so it runs again rather than being deduped.
      command({ requestId: 'r0', action: 'open-shortcuts' });
      expect(opts.setShortcutsOpen).toHaveBeenCalledTimes(122);

      // r120 is still remembered.
      const before = opts.setShortcutsOpen.mock.calls.length;
      command({ requestId: 'r120', action: 'open-shortcuts' });
      expect(opts.setShortcutsOpen).toHaveBeenCalledTimes(before);
    });
  });

  // ── activity / view ───────────────────────────────────────────────────────

  describe('navigation', () => {
    it('shows a known activity panel', () => {
      mount();
      command({ activity: 'files' });
      expect(nav.showPanel).toHaveBeenCalledWith('files');
    });

    it('ignores an unknown activity', () => {
      mount();
      command({ requestId: 'r1', activity: 'nope' });
      expect(nav.showPanel).not.toHaveBeenCalled();
      expect(publishDesktopCommandAck).toHaveBeenCalledWith('r1', false);
    });

    it('navigates to a known view', () => {
      mount();
      command({ view: 'kanban' });
      expect(nav.navigateToView).toHaveBeenCalledWith('kanban');
    });

    it('requests the session list when opening the sessions view', () => {
      mount();
      command({ view: 'sessions' });
      expect(wsClient.listSessions).toHaveBeenCalledWith(50);
    });

    it('does not request sessions for other views', () => {
      mount();
      command({ view: 'kanban' });
      expect(wsClient.listSessions).not.toHaveBeenCalled();
    });

    it('ignores an unknown view', () => {
      mount();
      command({ requestId: 'r1', view: 'atlantis' });
      expect(nav.navigateToView).not.toHaveBeenCalled();
      expect(publishDesktopCommandAck).toHaveBeenCalledWith('r1', false);
    });
  });

  // ── actions ───────────────────────────────────────────────────────────────

  describe('actions', () => {
    it('new-session starts a session and returns to chat', () => {
      mount();
      command({ action: 'new-session' });
      // Routed through the system-prompt picker, same as the in-app button.
      expect(useSystemPromptStore.getState().pickerOpen).toBe(true);
      expect(useSystemPromptStore.getState().pickerStartsSession).toBe(true);
      expect(nav.showPanel).toHaveBeenCalledWith('chat');
    });

    it('clear-context clears the coalescer, transcript and server context', () => {
      const clearMessages = vi.fn();
      useChatStore.setState({ clearMessages } as never);
      mount();
      command({ action: 'clear-context' });
      expect(dropAll).toHaveBeenCalled();
      expect(clearMessages).toHaveBeenCalled();
      expect(wsClient.clearContext).toHaveBeenCalled();
    });

    it.each([
      ['compact-context', 'compactContext'],
      ['repair-context', 'repairContext'],
    ] as Array<[string, keyof typeof wsClient]>)('%s calls %s', (action, method) => {
      mount();
      command({ action });
      expect(wsClient[method]).toHaveBeenCalled();
      expect(nav.showPanel).toHaveBeenCalledWith('chat');
    });

    it('download-chat exports the transcript', () => {
      mount();
      command({ action: 'download-chat' });
      expect(downloadChatAsMarkdown).toHaveBeenCalled();
    });

    it('focus-chat opens chat and focuses the textarea on the next frame', () => {
      const ta = document.createElement('textarea');
      document.body.appendChild(ta);
      const raf = vi
        .spyOn(window, 'requestAnimationFrame')
        .mockImplementation((cb: FrameRequestCallback) => {
          cb(0);
          return 1;
        });
      mount();
      command({ action: 'focus-chat' });
      expect(nav.showPanel).toHaveBeenCalledWith('chat');
      expect(document.activeElement).toBe(ta);
      raf.mockRestore();
      ta.remove();
    });

    it.each([
      ['open-command-palette', 'setPaletteOpen'],
      ['open-shortcuts', 'setShortcutsOpen'],
      ['search-chat', 'setSearchOpen'],
      ['open-model-switcher', 'setModelSwitcherOpen'],
      ['open-prompt-library', 'setPromptLibraryOpen'],
    ] as Array<[string, keyof typeof opts]>)('%s opens the matching overlay', (action, setter) => {
      mount();
      command({ action });
      expect(opts[setter]).toHaveBeenCalledWith(true);
    });

    it('ignores an unknown action', () => {
      mount();
      command({ requestId: 'r1', action: 'self-destruct' });
      expect(publishDesktopCommandAck).toHaveBeenCalledWith('r1', false);
    });
  });

  // ── dock sections ─────────────────────────────────────────────────────────

  describe('dock sections', () => {
    it('reveals a dock section inside chat', () => {
      mount();
      command({ dockSection: 'fleet' });
      expect(ui().showDockChip).toHaveBeenCalledWith('fleet');
      expect(ui().setDockCustomizeOpen).toHaveBeenCalledWith(false);
      expect(nav.showPanel).toHaveBeenCalledWith('chat');
      expect(ui().setDockSection).toHaveBeenCalledWith('fleet');
    });

    it('routes the goal dock to the standalone goal view and clears the section', () => {
      mount();
      command({ dockSection: 'goal' });
      expect(nav.openMainView).toHaveBeenCalledWith('goal');
      expect(ui().setDockSection).toHaveBeenCalledWith(null);
      // It returns before the chat-panel path.
      expect(nav.showPanel).not.toHaveBeenCalled();
    });

    it('ignores an unknown dock section', () => {
      mount();
      command({ requestId: 'r1', dockSection: 'nope' });
      expect(ui().showDockChip).not.toHaveBeenCalled();
      expect(publishDesktopCommandAck).toHaveBeenCalledWith('r1', false);
    });
  });

  // ── work tabs ─────────────────────────────────────────────────────────────

  describe('work tabs', () => {
    it.each(['todos', 'tasks'])('focuses the %s tab', (workTab) => {
      mount();
      command({ workTab });
      expect(ui().setDockSection).toHaveBeenCalledWith('work');
      expect(ui().setWorkDashboardTab).toHaveBeenCalledWith(workTab);
      expect(wsClient.getPlan).not.toHaveBeenCalled();
    });

    it('requests the plan when focusing the plan tab', () => {
      mount();
      command({ workTab: 'plan' });
      expect(wsClient.getPlan).toHaveBeenCalled();
    });

    it('ignores an unknown work tab', () => {
      mount();
      command({ requestId: 'r1', workTab: 'nope' });
      expect(ui().setWorkDashboardTab).not.toHaveBeenCalled();
      expect(publishDesktopCommandAck).toHaveBeenCalledWith('r1', false);
    });
  });

  // ── overlays ──────────────────────────────────────────────────────────────

  describe('overlays', () => {
    it.each([
      ['fleet', 'setFleetMonitorOpen'],
      ['agents-monitor', 'setAgentsMonitorOpen'],
      ['processes', 'setProcessMonitorOpen'],
      ['queue', 'setQueuePanelOpen'],
    ] as Array<[string, keyof typeof opts]>)('%s opens the matching monitor', (overlay, setter) => {
      mount();
      command({ overlay });
      expect(opts[setter]).toHaveBeenCalledWith(true);
    });

    it('ignores an unknown overlay', () => {
      mount();
      command({ requestId: 'r1', overlay: 'nope' });
      expect(publishDesktopCommandAck).toHaveBeenCalledWith('r1', false);
    });
  });

  // ── terminal ──────────────────────────────────────────────────────────────

  describe('terminal', () => {
    it('toggles the dock', () => {
      mount();
      command({ terminal: 'toggle' });
      expect(ui().toggleTerminal).toHaveBeenCalled();
    });

    it('opens the dock when asked for a new tab while closed', () => {
      mount();
      command({ terminal: 'new' });
      expect(opts.setTerminalOpen).toHaveBeenCalledWith(true);
      expect(ui().requestTerminalCreate).not.toHaveBeenCalled();
    });

    it('creates a tab when the dock is already open', () => {
      useUIStore.setState({ terminalOpen: true } as never);
      mount();
      command({ terminal: 'new' });
      expect(ui().requestTerminalCreate).toHaveBeenCalled();
      expect(opts.setTerminalOpen).not.toHaveBeenCalled();
    });

    it('accepts explicit true/false', () => {
      mount();
      command({ terminal: true });
      expect(opts.setTerminalOpen).toHaveBeenCalledWith(true);
      command({ terminal: false });
      expect(opts.setTerminalOpen).toHaveBeenCalledWith(false);
    });

    it('ignores an unknown terminal command', () => {
      mount();
      command({ requestId: 'r1', terminal: 'sideways' });
      expect(opts.setTerminalOpen).not.toHaveBeenCalled();
      expect(publishDesktopCommandAck).toHaveBeenCalledWith('r1', false);
    });
  });

  // ── prefs ─────────────────────────────────────────────────────────────────

  describe('pref commands', () => {
    it('sets a boolean pref and mirrors it to the server', () => {
      const set = vi.fn();
      useLocalPrefs.setState({ set } as never);
      mount();
      command({ pref: { key: 'nextPrediction', value: true } });
      expect(set).toHaveBeenCalledWith({ nextPrediction: true });
      expect(wsClient.updatePrefs).toHaveBeenCalledWith({ nextPrediction: true });
    });

    it('toggles a pref against its current value', () => {
      const set = vi.fn();
      useLocalPrefs.setState({ set, yolo: false } as never);
      mount();
      command({ pref: { key: 'yolo', toggle: true } });
      expect(set).toHaveBeenCalledWith({ yolo: true });
    });

    it('toggles back off', () => {
      const set = vi.fn();
      useLocalPrefs.setState({ set, yolo: true } as never);
      mount();
      command({ pref: { key: 'yolo', toggle: true } });
      expect(set).toHaveBeenCalledWith({ yolo: false });
    });

    it('announces a YOLO change but stays quiet for other prefs', () => {
      useLocalPrefs.setState({ set: vi.fn() } as never);
      mount();
      command({ pref: { key: 'yolo', value: true } });
      expect(toast.info).toHaveBeenCalledWith('YOLO enabled');

      toast.info.mockReset();
      command({ pref: { key: 'yolo', value: false } });
      expect(toast.info).toHaveBeenCalledWith('YOLO disabled');

      toast.info.mockReset();
      command({ pref: { key: 'contextAutoCompact', value: true } });
      expect(toast.info).not.toHaveBeenCalled();
    });

    it('ignores a pref outside the mirrored allow-list', () => {
      const set = vi.fn();
      useLocalPrefs.setState({ set } as never);
      mount();
      command({ requestId: 'r1', pref: { key: 'maxIterations', value: true } });
      expect(set).not.toHaveBeenCalled();
      expect(publishDesktopCommandAck).toHaveBeenCalledWith('r1', false);
    });

    it('ignores a non-boolean value', () => {
      const set = vi.fn();
      useLocalPrefs.setState({ set } as never);
      mount();
      command({ requestId: 'r1', pref: { key: 'yolo', value: 'yes' } });
      expect(set).not.toHaveBeenCalled();
      expect(publishDesktopCommandAck).toHaveBeenCalledWith('r1', false);
    });

    it('ignores a non-object pref payload', () => {
      mount();
      command({ requestId: 'r1', pref: 'yolo' });
      command({ requestId: 'r2', pref: ['yolo'] });
      expect(publishDesktopCommandAck).toHaveBeenCalledWith('r1', false);
      expect(publishDesktopCommandAck).toHaveBeenCalledWith('r2', false);
    });
  });

  // ── composition ───────────────────────────────────────────────────────────

  it('applies every field of a compound command', () => {
    mount();
    command({ requestId: 'r1', view: 'kanban', overlay: 'fleet', terminal: 'toggle' });
    expect(nav.navigateToView).toHaveBeenCalledWith('kanban');
    expect(opts.setFleetMonitorOpen).toHaveBeenCalledWith(true);
    expect(ui().toggleTerminal).toHaveBeenCalled();
    expect(publishDesktopCommandAck).toHaveBeenCalledWith('r1', true);
  });
});
