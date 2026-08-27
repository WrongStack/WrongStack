import { beforeEach, describe, expect, it, vi } from 'vitest';

// ws-handlers reaches for the live socket (files.tree refetch, mailbox
// re-query) — stub it so handlers run without a server.
vi.mock('@/lib/ws-client', () => ({
  // `consumeRequestedSwitch` is how the real client tells the handler that
  // THIS surface asked for the swap, so the session may take the foreground.
  // Without it a `session.start` only fills its own lane, which is what keeps
  // a background re-announce from yanking the user out of the tab they are in.
  getWSClient: () => ({ send: vi.fn(), consumeRequestedSwitch: () => true }),
}));

import { WS_HANDLERS } from '../../src/hooks/ws-handlers';
import { chatLane, useChatLanes } from '../../src/stores/chat-lanes';
import { useChatStore } from '../../src/stores/chat-store';
import { useConfigStore } from '../../src/stores/config-store';
import { useSessionLanes } from '../../src/stores/session-lanes';
import { useSessionStore } from '../../src/stores/session-store';
import { useUIStore } from '../../src/stores/ui-store';
import type { WSSessionStart } from '../../src/types';

function fireSessionStart(
  payload: Omit<WSSessionStart['payload'], 'model' | 'provider'> & {
    model: unknown;
    provider: unknown;
  },
) {
  WS_HANDLERS['session.start']?.({
    type: 'session.start',
    payload: {
      ...payload,
      model: payload.model as string,
      provider: payload.provider as string,
    },
  });
}

const BASE_PAYLOAD = {
  sessionId: 'sess_resumed',
  model: 'test-model',
  provider: 'test-provider',
  maxContext: 200_000,
  inputCost: 3,
  outputCost: 15,
  cacheReadCost: 0.3,
};

describe('session.start resume transition', () => {
  beforeEach(() => {
    history.pushState(null, '', '/');
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    delete (window as unknown as { wrongstackDesktopHost?: unknown }).wrongstackDesktopHost;
    // Each test resumes `sess_resumed` as if for the first time; a lane left
    // over from the previous test turns the next resume into a re-announce.
    useChatLanes.setState({ lanes: {}, activeSessionId: '__unbound__' });
    useSessionLanes.setState({ lanes: {}, activeSessionId: '__unbound__' });
    useChatStore.getState().clearMessages();
    useChatStore.getState().setLoading(false);
    useConfigStore.setState({ provider: '', model: '' });
    useSessionStore.setState({ session: null, todos: [] });
    useUIStore.setState({
      activeActivity: 'chat',
      currentView: 'chat',
      sidebarOpen: false,
      dockSection: null,
      fleetMonitorOpen: false,
      agentsMonitorOpen: false,
      processMonitorOpen: false,
      queuePanelOpen: false,
      inspectorOpen: false,
      terminalOpen: false,
      paletteOpen: false,
      searchOpen: false,
      searchQuery: '',
      searchActiveMessageId: null,
      modelSwitcherOpen: false,
      promptLibraryOpen: false,
    });
  });

  it('switches to the chat view when a resume replay arrives', () => {
    useUIStore.setState({ currentView: 'sessions', activeActivity: 'chat', sidebarOpen: true });
    fireSessionStart({
      ...BASE_PAYLOAD,
      reset: true,
      replayMessages: [{ role: 'user', content: 'hello', ts: '2026-06-11T10:00:00Z' }],
    });
    expect(useUIStore.getState()).toMatchObject({
      currentView: 'chat',
      activeActivity: 'chat',
      sidebarOpen: true,
    });
  });

  it('does not yank the view on a plain session.start (connect/new)', () => {
    useUIStore.getState().setCurrentView('sessions');
    fireSessionStart({ ...BASE_PAYLOAD, reset: true });
    expect(useUIStore.getState().currentView).toBe('sessions');
  });

  it('normalizes object-valued provider metadata before updating session and config stores', () => {
    const provider = {
      id: 'openai-codex',
      apiKey: 'must-not-persist',
      baseUrl: 'https://example.invalid',
      debugStream: false,
      reasoningEffort: 'high',
    };
    const model = { id: 'gpt-5.6-sol', capabilities: { reasoning: true } };

    fireSessionStart({
      ...BASE_PAYLOAD,
      provider,
      model,
      reset: true,
    });

    expect(useSessionStore.getState().session).toMatchObject({
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
    });
    expect(useConfigStore.getState()).toMatchObject({
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
    });
    expect(JSON.stringify(useConfigStore.getState())).not.toContain('must-not-persist');
  });

  it('returns desktop shell sessions to the chat home on a plain session.start', () => {
    history.pushState(null, '', '/?shell=desktop');
    useUIStore.setState({
      currentView: 'skill',
      activeActivity: 'skills',
      sidebarOpen: true,
      dockSection: 'work',
      terminalOpen: true,
      searchOpen: true,
      paletteOpen: true,
    });

    fireSessionStart({ ...BASE_PAYLOAD, reset: true });

    expect(useUIStore.getState()).toMatchObject({
      currentView: 'chat',
      activeActivity: 'chat',
      sidebarOpen: false,
      dockSection: null,
      terminalOpen: false,
      searchOpen: false,
      paletteOpen: false,
    });
  });

  it('hydrates replayed messages into the chat store', () => {
    fireSessionStart({
      ...BASE_PAYLOAD,
      reset: true,
      replayMessages: [
        { role: 'user', content: 'hello', ts: '2026-06-11T10:00:00Z' },
        { role: 'assistant', content: [{ type: 'text', text: 'world' }] },
      ],
    });
    const messages = useChatStore.getState().messages;
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toBe('hello');
    expect(messages[0]?.timestamp).toBe(Date.parse('2026-06-11T10:00:00Z'));
    expect(messages[1]?.content).toBe('world');
  });

  it('hydrates replayed thinking blocks as archived thinking logs', () => {
    fireSessionStart({
      ...BASE_PAYLOAD,
      reset: true,
      replayMessages: [
        { role: 'user', content: 'hello', ts: '2026-06-11T10:00:00Z' },
        {
          role: 'assistant',
          ts: '2026-06-11T10:00:05Z',
          content: [
            { type: 'thinking', thinking: 'first reasoning line' },
            { type: 'thinking', thinking: 'second reasoning line' },
            { type: 'text', text: 'world' },
          ],
        },
      ],
    });

    const messages = useChatStore.getState().messages;
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'system']);
    expect(messages[1]?.content).toBe('world');
    expect(messages[2]?.content).toBe('');
    expect(messages[2]?.timestamp).toBe(Date.parse('2026-06-11T10:00:05Z'));
    expect(messages[2]?.thinkingLog).toEqual({
      iteration: 1,
      text: 'first reasoning line\n\nsecond reasoning line',
      startedAt: Date.parse('2026-06-11T10:00:05Z'),
      durationMs: 0,
      replayed: true,
    });
  });

  it('attaches replayed tool_result blocks to tool_use messages by id', () => {
    fireSessionStart({
      ...BASE_PAYLOAD,
      reset: true,
      replayMessages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'checking' },
            { type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'a.ts' } },
            { type: 'tool_use', id: 'toolu_2', name: 'grep', input: { pattern: 'x' } },
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: 'file contents',
              is_error: false,
            },
            {
              type: 'tool_result',
              tool_use_id: 'toolu_2',
              content: [{ type: 'text', text: 'no matches' }],
              is_error: true,
            },
            { type: 'text', text: 'done' },
          ],
        },
      ],
    });

    const messages = useChatStore.getState().messages;
    expect(messages.map((m) => m.role)).toEqual(['assistant', 'tool', 'tool', 'assistant']);
    expect(messages[1]).toMatchObject({
      toolUseId: 'toolu_1',
      toolName: 'read',
      toolResult: 'file contents',
      isError: false,
    });
    expect(messages[2]).toMatchObject({
      toolUseId: 'toolu_2',
      toolName: 'grep',
      toolResult: JSON.stringify([{ type: 'text', text: 'no matches' }]),
      isError: true,
    });
  });

  it('hydrates replayed messages with one bulk chat-store update', () => {
    // Spy on the LANE the payload names: hydration is addressed at that
    // session, not at whichever tab happens to be in front.
    const lane = chatLane(BASE_PAYLOAD.sessionId);
    const addSpy = vi.spyOn(lane, 'addMessage');
    const setToolResultSpy = vi.spyOn(lane, 'setToolResult');
    const setMessagesSpy = vi.spyOn(lane, 'setMessages');

    fireSessionStart({
      ...BASE_PAYLOAD,
      reset: true,
      replayMessages: [
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'read' },
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' },
          ],
        },
      ],
    });

    expect(addSpy).not.toHaveBeenCalled();
    expect(setToolResultSpy).not.toHaveBeenCalled();
    expect(setMessagesSpy).toHaveBeenCalledTimes(1);
  });

  it('interleaves replayed audit markers into the conversation by timestamp', () => {
    fireSessionStart({
      ...BASE_PAYLOAD,
      reset: true,
      replayMessages: [
        { role: 'user', content: 'hello', ts: '2026-06-11T10:00:00Z' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'world' }],
          ts: '2026-06-11T10:00:30Z',
        },
      ],
      replayMarkers: [
        {
          ts: '2026-06-11T10:00:10Z',
          source: 'compaction',
          level: 'info',
          text: '⟲ context compacted: 8K → 2K tokens',
        },
      ],
    });

    const messages = useChatStore.getState().messages;
    expect(messages.map((m) => m.content)).toEqual([
      'hello',
      '⟲ context compacted: 8K → 2K tokens',
      'world',
    ]);
    expect(messages[1]?.role).toBe('system');
    expect(messages[1]?.timestamp).toBe(Date.parse('2026-06-11T10:00:10Z'));
  });

  it('flags error-level markers so they render as failures', () => {
    fireSessionStart({
      ...BASE_PAYLOAD,
      reset: true,
      replayMessages: [{ role: 'user', content: 'hello', ts: '2026-06-11T10:00:00Z' }],
      replayMarkers: [
        {
          ts: '2026-06-11T10:00:05Z',
          source: 'provider_error',
          level: 'error',
          text: 'provider error (HTTP 500, retryable): upstream',
        },
        {
          ts: '2026-06-11T10:00:06Z',
          source: 'provider_retry',
          level: 'warn',
          text: '⟳ retry 1 after 2.0s — upstream',
        },
      ],
    });

    const messages = useChatStore.getState().messages;
    expect(messages[1]?.isError).toBe(true);
    // warn is not an error — it must not be styled as a failure
    expect(messages[2]?.isError).toBeUndefined();
  });

  it('keeps a timestamp-less message ahead of later markers', () => {
    // `replayTimestamp` substitutes Date.now() for a message with no `ts`.
    // Merging on that synthesized value would sort the message behind every
    // marker; the walk must leave the marker cursor untouched instead.
    fireSessionStart({
      ...BASE_PAYLOAD,
      reset: true,
      replayMessages: [
        { role: 'user', content: 'no timestamp' },
        { role: 'assistant', content: 'later', ts: '2026-06-11T10:00:30Z' },
      ],
      replayMarkers: [
        {
          ts: '2026-06-11T10:00:20Z',
          source: 'mode_changed',
          level: 'info',
          text: 'mode: plan → build',
        },
      ],
    });

    expect(useChatStore.getState().messages.map((m) => m.content)).toEqual([
      'no timestamp',
      'mode: plan → build',
      'later',
    ]);
  });

  it('appends markers that outlived the last replayed message', () => {
    fireSessionStart({
      ...BASE_PAYLOAD,
      reset: true,
      replayMessages: [{ role: 'user', content: 'hello', ts: '2026-06-11T10:00:00Z' }],
      replayMarkers: [
        {
          ts: '2026-06-11T10:09:00Z',
          source: 'skill_activated',
          level: 'info',
          text: 'skill activated: commit',
        },
      ],
    });

    expect(useChatStore.getState().messages.map((m) => m.content)).toEqual([
      'hello',
      'skill activated: commit',
    ]);
  });

  it('replays the conversation unchanged when the server sends no markers', () => {
    fireSessionStart({
      ...BASE_PAYLOAD,
      reset: true,
      replayMessages: [{ role: 'user', content: 'hello', ts: '2026-06-11T10:00:00Z' }],
    });
    expect(useChatStore.getState().messages.map((m) => m.content)).toEqual(['hello']);
  });

  it('restores lifetime usage and recomputes cost from the payload rates', () => {
    fireSessionStart({
      ...BASE_PAYLOAD,
      reset: true,
      replayMessages: [],
      replayUsage: { input: 1_000_000, output: 100_000, cacheRead: 0, cacheWrite: 0 },
    });
    const s = useSessionStore.getState();
    expect(s.totalTokens.input).toBe(1_000_000);
    expect(s.totalTokens.output).toBe(100_000);
    // (1M × $3/M) + (100k × $15/M) = $4.50
    expect(s.cost).toBeCloseTo(4.5, 5);
  });

  it('clears the stale streaming flag and plan on reset', () => {
    useChatStore.getState().setLoading(true);
    useSessionStore.setState({
      todos: [{ id: 't1', content: 'old todo', status: 'pending' }],
    });
    fireSessionStart({ ...BASE_PAYLOAD, reset: true });
    expect(useChatStore.getState().isLoading).toBe(false);
    expect(useSessionStore.getState().todos).toHaveLength(0);
  });

  it('clears stale active search hit state on reset', () => {
    useUIStore.getState().setSearchActiveMessageId('old-thinking-log');

    fireSessionStart({ ...BASE_PAYLOAD, reset: true });

    expect(useUIStore.getState().searchActiveMessageId).toBeNull();
  });
});
