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
  useChatStore,
  useConfigStore,
  useFleetStore,
  useSessionStore,
  useSessionTabStore,
  useUIStore,
} from '../../src/stores/index.js';
import { useSystemPromptStore } from '../../src/stores/system-prompt-store.js';

function renderPanel() {
  return render(<SessionPanel />);
}

describe('SessionPanel quick actions', () => {
  beforeEach(() => {
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
      useSystemPromptStore.getState().closePicker();
    });
  });

  afterEach(() => cleanup());

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
});
