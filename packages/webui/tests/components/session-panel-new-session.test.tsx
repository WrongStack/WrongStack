import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updatePrefs = vi.hoisted(() => vi.fn());
const switchAutonomy = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({
    updatePrefs,
    switchAutonomy,
  }),
}));

vi.mock('@/components/CommandPalette', () => ({
  downloadChatAsMarkdown: vi.fn(),
}));

const send = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ws-client', () => ({
  getWSClient: () => ({
    send,
    withSession: (payload: Record<string, unknown>) => ({ ...payload, sessionId: 'sess-a' }),
    newSession: (payload?: Record<string, unknown>) =>
      send({ type: 'session.new', payload: { ...(payload ?? {}) } }),
  }),
}));

import { SessionPanel } from '../../src/components/SidePanel/SessionPanel.js';
import { chatLane, readLane, setActiveLane } from '../../src/stores/chat-lanes.js';
import {
  useBugHuntRunStore,
  useChatStore,
  useConfigStore,
  useFleetStore,
  useHistoryStore,
  useSessionStore,
  useSessionTabStore,
  useUIStore,
} from '../../src/stores/index.js';
import { useLocalPrefs } from '../../src/stores/local-prefs.js';
import { useSessionPanelLayout } from '../../src/stores/session-panel-layout.js';
import { useSystemPromptStore } from '../../src/stores/system-prompt-store.js';

function renderPanel() {
  return render(<SessionPanel />);
}

describe('SessionPanel quick actions', () => {
  beforeEach(() => {
    useSessionPanelLayout.setState({ order: [], collapsed: {} });
    useHistoryStore.setState({ entries: [] });
    send.mockClear();
    updatePrefs.mockClear();
    switchAutonomy.mockClear();

    act(() => {
      useChatStore.setState({ messages: [], isLoading: false } as never);
      useConfigStore.setState({
        wsConnected: true,
        wsUrl: 'ws://127.0.0.1:3457',
        provider: 'openai',
        model: 'gpt-5',
      });
      useFleetStore.setState({ agents: new Map() });
      useSessionStore.setState({
        session: { id: 'sess-a', startedAt: 1, provider: 'openai', model: 'gpt-5' },
        totalTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        cost: 0,
        iteration: null,
        todos: [],
        lastInputTokens: 0,
        maxContext: 0,
      });
      useUIStore.setState({
        currentView: 'chat',
        sidebarOpen: true,
        draftInput: '',
        draftImages: [],
        refinePanel: null,
        queuePanelOpen: false,
      });
      useSessionTabStore.setState({ openTabIds: [], lastSeenCounts: {}, attention: {} });
      useBugHuntRunStore.setState({ runs: {} });
      useSystemPromptStore.getState().closePicker();
      // The quick-action tests click the loose Clear / New session buttons of
      // full chrome; calm chrome's menu is covered by its own tests below.
      useLocalPrefs.setState({ chromeLevel: 'full' });
    });
  });

  afterEach(() => cleanup());

  it('shows the active bug-hunt round immediately above Quick settings', () => {
    useBugHuntRunStore.setState({
      runs: {
        'sess-a': {
          scope: 'packages/webui',
          totalRounds: 3,
          currentRound: 2,
          requestId: 'round-two',
        },
      },
    });

    renderPanel();

    expect(screen.getByText('Bug hunt in progress')).toBeTruthy();
    expect(screen.getByText('Round 2 of 3 · packages/webui')).toBeTruthy();
  });

  it('New session opens the identity-prompt picker that starts a NEW tab', () => {
    renderPanel();
    // Discard the mount-time sessions.list so the assertion below isolates
    // what the CLICK does.
    send.mockClear();

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    });

    // The picker owns the funnel: it applies the variant and only then sends
    // `session.new`. The click itself must not talk to the server.
    const picker = useSystemPromptStore.getState();
    expect(picker.pickerOpen).toBe(true);
    expect(picker.pickerStartsSession).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it('New session refuses to open a picker when all four tab slots are full', () => {
    useSessionTabStore.setState({
      openTabIds: ['sess-a', 'sess-b', 'sess-c', 'sess-d'],
    });
    renderPanel();

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    });

    expect(useSystemPromptStore.getState().pickerOpen).toBe(false);
  });

  it("Clear retires this tab's session: session.new with replaceSessionId, lanes untouched", async () => {
    act(() => {
      setActiveLane('sess-a');
      chatLane('sess-a').addMessage({ role: 'user', content: 'clear me' });
      chatLane('sess-a').enqueue('queued in a');
      chatLane('sess-b').addMessage({ role: 'user', content: 'keep me' });
      useUIStore.getState().setDraftInput('draft a');
      useUIStore.getState().setQueuePanelOpen(true);
    });
    renderPanel();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    });

    // The retire request names THIS tab's session — the server closes it and
    // answers with a reset session.start whose clearedSessionId rebinds the
    // tab (see session-tab-store swapTabSession).
    expect(send).toHaveBeenCalledWith({
      type: 'session.new',
      payload: { replaceSessionId: 'sess-a' },
    });
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'context.clear' }));
    // Drafts go now; the conversation itself is retired when the swap
    // answer lands, not by a local wipe that could orphan the tab.
    expect(useUIStore.getState()).toMatchObject({
      draftInput: '',
      draftImages: [],
      refinePanel: null,
      queuePanelOpen: false,
    });
    expect(readLane('sess-a').messages.map((m) => m.content)).toEqual(['clear me']);
    expect(readLane('sess-b').messages.map((m) => m.content)).toEqual(['keep me']);
  });

  it('Clear and New session are disabled while disconnected — no session record can be created offline', () => {
    useConfigStore.setState({ wsConnected: false });
    renderPanel();

    const clear = screen.getByRole('button', { name: 'Clear' });
    const newSession = screen.getByRole('button', { name: 'New session' });
    expect(clear.hasAttribute('disabled')).toBe(true);
    expect(newSession.hasAttribute('disabled')).toBe(true);

    fireEvent.click(clear);
    fireEvent.click(newSession);
    expect(send).not.toHaveBeenCalled();
  });

  it('calm chrome exposes Clear on the action row, not only inside the more menu', async () => {
    useLocalPrefs.setState({ chromeLevel: 'calm' });
    renderPanel();

    // Clear used to live in the "more" menu only, while New session sat on
    // the row — so the destructive action had a fraction of the exposure of
    // the harmless one, and neither a mouse nor a keyboard could reach it
    // without opening a menu first.
    const clear = screen.getByRole('button', { name: 'Clear' });
    expect(clear).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New session' })).toBeTruthy();

    // …and it is the same wired action, not a decorative duplicate.
    await act(async () => {
      fireEvent.click(clear);
    });
    expect(send).toHaveBeenCalledWith({
      type: 'session.new',
      payload: { replaceSessionId: 'sess-a' },
    });
  });

  it('calm chrome folds the session stats grid behind its heading', () => {
    useLocalPrefs.setState({ chromeLevel: 'calm', sessionStatsExpanded: false });
    renderPanel();

    const toggle = screen.getByRole('button', { name: 'Session' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('Messages').closest('[hidden]')).toBeTruthy();

    act(() => {
      fireEvent.click(toggle);
    });
    expect(useLocalPrefs.getState().sessionStatsExpanded).toBe(true);
    expect(screen.getByText('Messages').closest('[hidden]')).toBeNull();
    useLocalPrefs.setState({ sessionStatsExpanded: false });
  });

  it('full chrome starts with stats open and allows collapsing them', () => {
    useLocalPrefs.setState({ chromeLevel: 'full', sessionStatsExpanded: false });
    renderPanel();

    const toggle = screen.getByRole('button', { name: 'Session' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Messages').closest('[hidden]')).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText('Messages').closest('[hidden]')).toBeTruthy();
    useLocalPrefs.setState({ chromeLevel: 'calm' });
  });

  it('calm chrome keeps New session and Clear loose and moves Export / Compact into a menu', () => {
    useLocalPrefs.setState({ chromeLevel: 'calm' });
    renderPanel();

    expect(screen.getByRole('button', { name: 'New session' })).toBeTruthy();
    // Clear is a row action too: it retires the conversation, and hiding it
    // behind a menu left it with a fraction of the exposure New session had.
    expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy();
    expect(screen.getByTestId('session-actions-menu')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Export' })).toBeNull();
  });

  it('calm chrome lists session history before the folded session stats', () => {
    useLocalPrefs.setState({ chromeLevel: 'calm' });
    useHistoryStore.setState({
      entries: [
        {
          id: 'sess-old',
          title: 'Older session',
          provider: 'openai',
          model: 'gpt-5',
          tokenTotal: 10,
          isCurrent: false,
        },
      ],
    } as never);
    renderPanel();

    const history = screen.getByText('Older session');
    const stats = screen.getByRole('button', { name: 'Session' });
    // DOCUMENT_POSITION_FOLLOWING (4): the stats toggle comes after history.
    expect(history.compareDocumentPosition(stats) & 4).toBe(4);
  });

  describe('YOLO three-way switch', () => {
    const level = (name: string) => screen.getByRole('radio', { name });
    const sent = () => updatePrefs.mock.calls.map(([patch]) => patch);

    it('shows the current level as the checked segment', () => {
      useLocalPrefs.setState({ yolo: true, yoloPlus: true });
      renderPanel();
      expect(screen.getByRole('radiogroup', { name: 'YOLO mode' })).toBeTruthy();
      expect(level('YOLO+').getAttribute('aria-checked')).toBe('true');
      expect(level('On').getAttribute('aria-checked')).toBe('false');
    });

    it('off → YOLO+ turns YOLO on first, then YOLO+', () => {
      useLocalPrefs.setState({ yolo: false, yoloPlus: false });
      renderPanel();
      act(() => fireEvent.click(level('YOLO+')));
      expect(sent()).toEqual([{ yolo: true }, { yoloPlus: true }]);
      expect(useLocalPrefs.getState()).toMatchObject({ yolo: true, yoloPlus: true });
    });

    it('YOLO+ → off leaves YOLO+ before turning YOLO off', () => {
      useLocalPrefs.setState({ yolo: true, yoloPlus: true });
      renderPanel();
      act(() => fireEvent.click(level('Off')));
      expect(sent()).toEqual([{ yoloPlus: false }, { yolo: false }]);
    });

    it('YOLO+ → on only drops YOLO+', () => {
      useLocalPrefs.setState({ yolo: true, yoloPlus: true });
      renderPanel();
      act(() => fireEvent.click(level('On')));
      expect(sent()).toEqual([{ yoloPlus: false }]);
    });

    it('clicking the current level sends nothing; arrow keys move the choice', () => {
      useLocalPrefs.setState({ yolo: true, yoloPlus: false });
      renderPanel();
      act(() => fireEvent.click(level('On')));
      expect(sent()).toEqual([]);
      act(() => {
        fireEvent.keyDown(screen.getByRole('radiogroup', { name: 'YOLO mode' }), {
          key: 'ArrowRight',
        });
      });
      expect(sent()).toEqual([{ yoloPlus: true }]);
    });

    it('arrow keys move focus to the newly checked segment', () => {
      useLocalPrefs.setState({ yolo: true, yoloPlus: false });
      renderPanel();
      level('On').focus();
      expect(document.activeElement).toBe(level('On'));
      act(() => {
        fireEvent.keyDown(screen.getByRole('radiogroup', { name: 'YOLO mode' }), {
          key: 'ArrowRight',
        });
      });
      expect(level('YOLO+').getAttribute('aria-checked')).toBe('true');
      expect(document.activeElement).toBe(level('YOLO+'));
    });
  });
});
