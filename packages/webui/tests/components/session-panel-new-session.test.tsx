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
  }),
}));

import { SessionPanel } from '../../src/components/SidePanel/SessionPanel.js';
import { chatLane, readLane, setActiveLane } from '../../src/stores/chat-lanes.js';
import {
  useChatStore,
  useConfigStore,
  useFleetStore,
  useSessionStore,
  useUIStore,
} from '../../src/stores/index.js';

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
    });
  });

  afterEach(() => cleanup());

  it('does not render a duplicate New session button', () => {
    renderPanel();

    expect(screen.queryByRole('button', { name: 'New session' })).toBeNull();
  });

  it('clears only the active session lane and sends a session-scoped clear', () => {
    act(() => {
      setActiveLane('sess-a');
      chatLane('sess-a').addMessage({ role: 'user', content: 'clear me' });
      chatLane('sess-a').enqueue('queued in a');
      chatLane('sess-b').addMessage({ role: 'user', content: 'keep me' });
      useUIStore.getState().setDraftInput('draft a');
      useUIStore.getState().setQueuePanelOpen(true);
    });
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(readLane('sess-a').messages).toEqual([]);
    expect(readLane('sess-a').queue).toEqual([]);
    expect(readLane('sess-b').messages.map((m) => m.content)).toEqual(['keep me']);
    expect(useUIStore.getState()).toMatchObject({
      draftInput: '',
      draftImages: [],
      refinePanel: null,
      queuePanelOpen: false,
    });
    expect(send).toHaveBeenCalledWith({ type: 'context.clear', payload: { sessionId: 'sess-a' } });
  });

  it('keeps local clear working while disconnected', () => {
    useConfigStore.setState({ wsConnected: false });
    act(() => {
      setActiveLane('sess-a');
      chatLane('sess-a').addMessage({ role: 'user', content: 'offline clear' });
    });
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(readLane('sess-a').messages).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
});
