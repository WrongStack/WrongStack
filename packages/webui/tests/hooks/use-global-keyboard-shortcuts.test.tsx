import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSystemPromptStore } from '../../src/stores/system-prompt-store.js';

// ── module stubs ────────────────────────────────────────────────────────────

const dropAll = vi.fn();
vi.mock('@/lib/stream-coalescer', () => ({ streamCoalescer: { dropAll } }));

const wsClient = {
  getPlan: vi.fn(),
  send: vi.fn(),
  listSessions: vi.fn(),
  clearContext: vi.fn(),
  newSession: vi.fn(),
  sendAbort: vi.fn(),
};
vi.mock('@/lib/ws-client', () => ({ getWSClient: () => wsClient }));

const nav = {
  ACTIVITY_SHORTCUT_BY_KEY: { '1': 'files', '2': 'sessions', '0': 'design' } as Record<
    string,
    string
  >,
  navigateToView: vi.fn(),
  openMainView: vi.fn(),
  openPanel: vi.fn(),
  showPanel: vi.fn(),
};
vi.mock('@/components/activity-bar/nav', () => nav);

const downloadChatAsMarkdown = vi.fn();
vi.mock('@/components/CommandPalette', () => ({ downloadChatAsMarkdown }));

const { useChatStore, useUIStore } = await import('../../src/stores');
const { useGlobalKeyboardShortcuts } = await import('../../src/hooks/useGlobalKeyboardShortcuts');

// ── harness ─────────────────────────────────────────────────────────────────

const opts = {
  toggleSidebar: vi.fn(),
  setSearchOpen: vi.fn(),
  toggleInspector: vi.fn(),
  setInspectorTab: vi.fn(),
};

function mount() {
  return renderHook(() => useGlobalKeyboardShortcuts(opts));
}

/** Dispatch a keydown on `target` (defaults to document.body). */
function press(key: string, init: KeyboardEventInit = {}, target?: HTMLElement): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  (target ?? document.body).dispatchEvent(e);
  return e;
}

function textarea(): HTMLTextAreaElement {
  const el = document.createElement('textarea');
  document.body.appendChild(el);
  return el;
}

/** Render N chat bubbles for the vim-navigation tests. */
function bubbles(n: number): HTMLElement[] {
  return Array.from({ length: n }, (_, i) => {
    const el = document.createElement('div');
    el.setAttribute('data-message-id', `m${i}`);
    el.scrollIntoView = vi.fn();
    document.body.appendChild(el);
    return el;
  });
}

const UI_DEFAULTS = {
  inspectorOpen: false,
  inspectorTab: 'fleet',
  searchOpen: false,
  paletteOpen: false,
  shortcutsOpen: false,
  modelSwitcherOpen: false,
  promptLibraryOpen: false,
  toggleTerminal: vi.fn(),
  setInspectorOpen: vi.fn(),
  setInspectorTab: vi.fn(),
  setDockCustomizeOpen: vi.fn(),
  setFleetMonitorOpen: vi.fn(),
  setAgentsMonitorOpen: vi.fn(),
  setDockSection: vi.fn(),
  setWorkDashboardTab: vi.fn(),
  setQueuePanelOpen: vi.fn(),
  setProcessMonitorOpen: vi.fn(),
  toggleCompactMode: vi.fn(),
};

describe('useGlobalKeyboardShortcuts', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    for (const fn of Object.values(opts)) fn.mockReset();
    for (const fn of Object.values(wsClient)) fn.mockReset();
    for (const fn of Object.values(nav)) if (typeof fn === 'function') fn.mockReset();
    dropAll.mockReset();
    downloadChatAsMarkdown.mockReset();
    const uiFns = Object.fromEntries(
      Object.entries(UI_DEFAULTS).map(([k, v]) =>
        typeof v === 'function' ? [k, vi.fn()] : [k, v],
      ),
    );
    useUIStore.setState(uiFns as never);
    useChatStore.setState({ isLoading: false, clearMessages: vi.fn() } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const ui = () => useUIStore.getState() as unknown as Record<string, ReturnType<typeof vi.fn>>;

  // ── sidebar / terminal ────────────────────────────────────────────────────

  it('Ctrl+\\ toggles the sidebar', () => {
    mount();
    const e = press('\\', { ctrlKey: true });
    expect(opts.toggleSidebar).toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });

  it('accepts Cmd as the modifier', () => {
    mount();
    press('\\', { metaKey: true });
    expect(opts.toggleSidebar).toHaveBeenCalled();
  });

  it('ignores a bare backslash', () => {
    mount();
    press('\\');
    expect(opts.toggleSidebar).not.toHaveBeenCalled();
  });

  it('Ctrl+` toggles the terminal dock', () => {
    mount();
    press('`', { ctrlKey: true });
    expect(ui().toggleTerminal).toHaveBeenCalled();
  });

  // ── activity panel jumps ──────────────────────────────────────────────────

  it('Ctrl+<digit> opens the mapped panel', () => {
    mount();
    press('1', { ctrlKey: true });
    expect(nav.openPanel).toHaveBeenCalledWith('files');
  });

  it('Ctrl+0 opens the design panel', () => {
    mount();
    press('0', { ctrlKey: true });
    expect(nav.openPanel).toHaveBeenCalledWith('design');
  });

  it('ignores the digit shortcut when Shift or Alt is held', () => {
    mount();
    press('1', { ctrlKey: true, shiftKey: true });
    press('1', { ctrlKey: true, altKey: true });
    expect(nav.openPanel).not.toHaveBeenCalled();
  });

  it('routes a mapped agents shortcut to the Agents sidebar panel', () => {
    nav.ACTIVITY_SHORTCUT_BY_KEY['3'] = 'agents';
    mount();
    press('3', { ctrlKey: true });
    expect(nav.openPanel).toHaveBeenCalledWith('agents');
    expect(ui().setInspectorTab).not.toHaveBeenCalled();
    expect(ui().setInspectorOpen).not.toHaveBeenCalled();
    delete nav.ACTIVITY_SHORTCUT_BY_KEY['3'];
  });

  it('does not mutate the inspector when a mapped agents shortcut repeats', () => {
    nav.ACTIVITY_SHORTCUT_BY_KEY['3'] = 'agents';
    useUIStore.setState({ inspectorOpen: true, inspectorTab: 'agents' } as never);
    mount();
    press('3', { ctrlKey: true });
    expect(nav.openPanel).toHaveBeenCalledWith('agents');
    expect(ui().setInspectorOpen).not.toHaveBeenCalled();
    delete nav.ACTIVITY_SHORTCUT_BY_KEY['3'];
  });

  it('Ctrl+9 opens Settings as a main view', () => {
    mount();
    press('9', { ctrlKey: true });
    expect(nav.openMainView).toHaveBeenCalledWith('settings');
  });

  it('Ctrl+Shift+W opens the worktrees panel', () => {
    mount();
    press('W', { ctrlKey: true, shiftKey: true });
    expect(nav.openPanel).toHaveBeenCalledWith('worktrees');
  });

  // ── function keys ─────────────────────────────────────────────────────────

  describe('function keys', () => {
    it('F1 opens chat and always closes the dock customizer first', () => {
      mount();
      press('F1');
      expect(ui().setDockCustomizeOpen).toHaveBeenCalledWith(false);
      expect(nav.openPanel).toHaveBeenCalledWith('chat');
    });

    it('F2 and F3 open the fleet and agents monitors', () => {
      mount();
      press('F2');
      expect(ui().setFleetMonitorOpen).toHaveBeenCalledWith(true);
      press('F3');
      expect(ui().setAgentsMonitorOpen).toHaveBeenCalledWith(true);
    });

    it('F4 shows worktrees in the dock', () => {
      mount();
      press('F4');
      expect(nav.showPanel).toHaveBeenCalledWith('worktrees');
      expect(ui().setDockSection).toHaveBeenCalledWith('worktrees');
    });

    it('F5 requests the plan and opens the plan tab', () => {
      mount();
      press('F5');
      expect(wsClient.getPlan).toHaveBeenCalled();
      expect(ui().setWorkDashboardTab).toHaveBeenCalledWith('plan');
    });

    it('F6 opens the todos tab without a server round-trip', () => {
      mount();
      press('F6');
      expect(ui().setWorkDashboardTab).toHaveBeenCalledWith('todos');
      expect(wsClient.getPlan).not.toHaveBeenCalled();
    });

    it('F7 and F8 open the queue and process panels', () => {
      mount();
      press('F7');
      expect(ui().setQueuePanelOpen).toHaveBeenCalledWith(true);
      press('F8');
      expect(ui().setProcessMonitorOpen).toHaveBeenCalledWith(true);
    });

    it('F9 requests the goal state', () => {
      mount();
      press('F9');
      expect(wsClient.send).toHaveBeenCalledWith({ type: 'goal-state.get' });
      expect(ui().setDockSection).toHaveBeenCalledWith('goal-state');
    });

    it('F10 lists sessions with the documented cap', () => {
      mount();
      press('F10');
      expect(wsClient.listSessions).toHaveBeenCalledWith(200);
    });

    it('F11 opens the office map', () => {
      mount();
      press('F11');
      expect(nav.showPanel).toHaveBeenCalledWith('officemap');
    });

    it('F12 opens the dock customizer', () => {
      mount();
      press('F12');
      expect(ui().setDockCustomizeOpen).toHaveBeenLastCalledWith(true);
    });

    it('is skipped while typing so editor conventions keep working', () => {
      mount();
      press('F1', {}, textarea());
      expect(nav.openPanel).not.toHaveBeenCalled();
    });

    it('is skipped when a modifier is held', () => {
      mount();
      press('F1', { ctrlKey: true });
      press('F1', { altKey: true });
      expect(nav.openPanel).not.toHaveBeenCalled();
    });
  });

  // ── search / focus ────────────────────────────────────────────────────────

  it('Ctrl+F opens search even while typing', () => {
    mount();
    press('f', { ctrlKey: true }, textarea());
    expect(opts.setSearchOpen).toHaveBeenCalledWith(true);
  });

  it('Ctrl+/ focuses the chat textarea', () => {
    mount();
    const ta = textarea();
    press('/', { ctrlKey: true });
    expect(document.activeElement).toBe(ta);
  });

  it('Ctrl+/ is safe with no textarea on the page', () => {
    mount();
    expect(() => press('/', { ctrlKey: true })).not.toThrow();
  });

  // ── Ctrl-letter actions ───────────────────────────────────────────────────

  describe('Ctrl-letter actions', () => {
    it('Ctrl+L clears the chat, the coalescer and the server context', () => {
      const clearMessages = vi.fn();
      useChatStore.setState({ clearMessages } as never);
      mount();
      press('l', { ctrlKey: true });
      expect(dropAll).toHaveBeenCalled();
      expect(clearMessages).toHaveBeenCalled();
      expect(wsClient.clearContext).toHaveBeenCalled();
    });

    it('Ctrl+N starts a new session and returns to chat', () => {
      mount();
      press('n', { ctrlKey: true });
      // Ctrl+N hands off to the system-prompt picker, which sends `session.new`
      // once a variant is confirmed — see SystemPromptDialog.
      expect(useSystemPromptStore.getState().pickerOpen).toBe(true);
      expect(useSystemPromptStore.getState().pickerStartsSession).toBe(true);
      expect(nav.showPanel).toHaveBeenCalledWith('chat');
    });

    it('Ctrl+E exports the transcript', () => {
      mount();
      press('e', { ctrlKey: true });
      expect(downloadChatAsMarkdown).toHaveBeenCalled();
    });

    it.each(['l', 'n', 'e'])('Ctrl+%s is suppressed while composing', (key) => {
      const clearMessages = vi.fn();
      useChatStore.setState({ clearMessages } as never);
      mount();
      press(key, { ctrlKey: true }, textarea());
      expect(clearMessages).not.toHaveBeenCalled();
      expect(wsClient.newSession).not.toHaveBeenCalled();
      expect(downloadChatAsMarkdown).not.toHaveBeenCalled();
    });

    it('is suppressed inside a contenteditable region', () => {
      const div = document.createElement('div');
      div.setAttribute('contenteditable', 'true');
      Object.defineProperty(div, 'isContentEditable', { value: true });
      document.body.appendChild(div);
      mount();
      press('l', { ctrlKey: true }, div);
      expect(dropAll).not.toHaveBeenCalled();
    });
  });

  // ── Ctrl+Shift chords ─────────────────────────────────────────────────────

  describe('Ctrl+Shift chords', () => {
    it('Ctrl+Shift+D toggles compact density', () => {
      mount();
      press('D', { ctrlKey: true, shiftKey: true });
      expect(ui().toggleCompactMode).toHaveBeenCalled();
    });

    it('Ctrl+Shift+M opens the inspector on the fleet tab', () => {
      mount();
      press('M', { ctrlKey: true, shiftKey: true });
      expect(opts.setInspectorTab).toHaveBeenCalledWith('fleet');
      expect(opts.toggleInspector).toHaveBeenCalled();
    });

    it('Ctrl+Shift+M closes the inspector when already on fleet', () => {
      useUIStore.setState({ inspectorOpen: true, inspectorTab: 'fleet' } as never);
      mount();
      press('M', { ctrlKey: true, shiftKey: true });
      expect(opts.toggleInspector).toHaveBeenCalled();
      expect(opts.setInspectorTab).not.toHaveBeenCalled();
    });

    it('Ctrl+Shift+M only switches tabs when the inspector is already open on another tab', () => {
      useUIStore.setState({ inspectorOpen: true, inspectorTab: 'agents' } as never);
      mount();
      press('M', { ctrlKey: true, shiftKey: true });
      expect(opts.setInspectorTab).toHaveBeenCalledWith('fleet');
      expect(opts.toggleInspector).not.toHaveBeenCalled();
    });

    it('Ctrl+Shift+A mirrors that behaviour for the agents tab', () => {
      mount();
      press('A', { ctrlKey: true, shiftKey: true });
      expect(opts.setInspectorTab).toHaveBeenCalledWith('agents');
      expect(opts.toggleInspector).toHaveBeenCalled();
    });

    it('Ctrl+Shift+A closes the inspector when already on agents', () => {
      useUIStore.setState({ inspectorOpen: true, inspectorTab: 'agents' } as never);
      mount();
      press('A', { ctrlKey: true, shiftKey: true });
      expect(opts.toggleInspector).toHaveBeenCalled();
    });

    it('Ctrl+Shift+G opens the debug dashboard', () => {
      mount();
      press('G', { ctrlKey: true, shiftKey: true });
      expect(nav.navigateToView).toHaveBeenCalledWith('debug');
    });

    it('Ctrl+Shift+K opens memory', () => {
      mount();
      press('K', { ctrlKey: true, shiftKey: true });
      expect(nav.openMainView).toHaveBeenCalledWith('memory');
    });
  });

  // ── Escape ────────────────────────────────────────────────────────────────

  describe('Escape', () => {
    it('collapses an open inspector', () => {
      useUIStore.setState({ inspectorOpen: true } as never);
      mount();
      press('Escape');
      expect(ui().setInspectorOpen).toHaveBeenCalledWith(false);
    });

    it('aborts an in-flight run when nothing else claims Escape', () => {
      useChatStore.setState({ isLoading: true } as never);
      mount();
      press('Escape');
      expect(wsClient.sendAbort).toHaveBeenCalled();
    });

    it('does not abort when no run is in flight', () => {
      mount();
      press('Escape');
      expect(wsClient.sendAbort).not.toHaveBeenCalled();
    });

    it.each([
      'inspectorOpen',
      'searchOpen',
      'paletteOpen',
      'shortcutsOpen',
      'modelSwitcherOpen',
      'promptLibraryOpen',
    ])('does not abort while %s is open — that overlay owns Escape', (flag) => {
      useChatStore.setState({ isLoading: true } as never);
      useUIStore.setState({ [flag]: true } as never);
      mount();
      press('Escape');
      expect(wsClient.sendAbort).not.toHaveBeenCalled();
    });

    it('does not abort while a bubble is focused', () => {
      useChatStore.setState({ isLoading: true } as never);
      const [b] = bubbles(1);
      b.setAttribute('data-focused', 'true');
      mount();
      press('Escape');
      expect(wsClient.sendAbort).not.toHaveBeenCalled();
    });

    it('does not abort while typing', () => {
      useChatStore.setState({ isLoading: true } as never);
      mount();
      press('Escape', {}, textarea());
      expect(wsClient.sendAbort).not.toHaveBeenCalled();
    });

    it('clears bubble focus', () => {
      const [b] = bubbles(1);
      b.setAttribute('data-focused', 'true');
      mount();
      press('Escape');
      expect(b.hasAttribute('data-focused')).toBe(false);
    });
  });

  // ── vim navigation ────────────────────────────────────────────────────────

  describe('vim-style bubble navigation', () => {
    it('is inert with no bubbles on screen', () => {
      mount();
      expect(() => press('j')).not.toThrow();
    });

    it.each(['j', 'ArrowDown'])('%s focuses the first bubble from nothing', (key) => {
      const [b0] = bubbles(3);
      mount();
      const e = press(key);
      expect(b0.getAttribute('data-focused')).toBe('true');
      expect(e.defaultPrevented).toBe(true);
    });

    it('j steps forward and stops at the last bubble', () => {
      const list = bubbles(3);
      mount();
      press('j');
      press('j');
      press('j');
      expect(list[2].getAttribute('data-focused')).toBe('true');
      press('j');
      expect(list[2].getAttribute('data-focused')).toBe('true');
    });

    it.each(['k', 'ArrowUp'])('%s steps back and stops at the first bubble', (key) => {
      const list = bubbles(3);
      list[2].setAttribute('data-focused', 'true');
      mount();
      press(key);
      expect(list[1].getAttribute('data-focused')).toBe('true');
      press(key);
      press(key);
      expect(list[0].getAttribute('data-focused')).toBe('true');
    });

    it('focus is exclusive — only one bubble is marked at a time', () => {
      const list = bubbles(3);
      mount();
      press('j');
      press('j');
      expect(list.filter((b) => b.hasAttribute('data-focused'))).toHaveLength(1);
    });

    it('scrolls the newly focused bubble into view', () => {
      const list = bubbles(2);
      mount();
      press('j');
      expect(list[0].scrollIntoView).toHaveBeenCalledWith({
        behavior: 'smooth',
        block: 'center',
      });
    });

    it('g jumps to the first bubble, G to the last', () => {
      const list = bubbles(4);
      mount();
      press('G', { shiftKey: true });
      expect(list[3].getAttribute('data-focused')).toBe('true');
      press('g');
      expect(list[0].getAttribute('data-focused')).toBe('true');
    });

    it('accepts a bare G as end-of-list', () => {
      const list = bubbles(3);
      mount();
      press('G');
      expect(list[2].getAttribute('data-focused')).toBe('true');
    });

    it('c copies the focused bubble text', () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      const [b] = bubbles(1);
      b.setAttribute('data-focused', 'true');
      Object.defineProperty(b, 'innerText', { value: 'hello world', configurable: true });
      mount();
      press('c');
      expect(writeText).toHaveBeenCalledWith('hello world');
    });

    it('c prefers the rendered markdown body over the whole bubble', () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      const [b] = bubbles(1);
      b.setAttribute('data-focused', 'true');
      const body = document.createElement('div');
      body.className = 'markdown-content';
      Object.defineProperty(body, 'innerText', { value: 'just the body', configurable: true });
      b.appendChild(body);
      Object.defineProperty(b, 'innerText', { value: 'chrome + just the body', configurable: true });
      mount();
      press('c');
      expect(writeText).toHaveBeenCalledWith('just the body');
    });

    it('c is inert with no focused bubble', () => {
      const writeText = vi.fn();
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      bubbles(1);
      mount();
      press('c');
      expect(writeText).not.toHaveBeenCalled();
    });

    it('is skipped while typing so j/k still insert letters', () => {
      const list = bubbles(2);
      mount();
      press('j', {}, textarea());
      expect(list[0].hasAttribute('data-focused')).toBe(false);
    });

    it('is skipped when a modifier is held', () => {
      const list = bubbles(2);
      mount();
      press('j', { ctrlKey: true });
      press('j', { altKey: true });
      expect(list[0].hasAttribute('data-focused')).toBe(false);
    });
  });

  // ── lifecycle ─────────────────────────────────────────────────────────────

  it('detaches the listener on unmount', () => {
    const { unmount } = mount();
    unmount();
    press('\\', { ctrlKey: true });
    expect(opts.toggleSidebar).not.toHaveBeenCalled();
  });
});
