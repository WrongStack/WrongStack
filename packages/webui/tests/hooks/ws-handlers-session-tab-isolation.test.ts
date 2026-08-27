import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tab isolation for the four-tab WebUI.
 *
 * The contract these tests pin, stated as the user stated it: four tabs side by
 * side, one session per tab and one tab per session, and not one point of any
 * tab crossing into another — background included. Nothing about a tab is
 * "parked": each lane holds its own transcript, queue, accounting and roster at
 * all times, and switching tabs moves a pointer.
 *
 * Everything below is a way for that to fail. If any of these go red, some
 * writer stopped naming the session it writes to.
 */

const send = vi.fn();
/**
 * A stable stand-in for the real client. `consumeRequestedSwitch` claims the
 * "this surface asked to switch HERE" grant for ONE session and is one-shot,
 * exactly as the real client behaves — without a matching grant a
 * `session.start` fills its own lane and leaves the foreground alone. The
 * grant is keyed by session id: an announce for a session nobody clicked can
 * never spend the grant issued for the one they did.
 */
const wsClient = {
  send,
  listSavedProviders: vi.fn(),
  requestedSwitch: null as string | null,
  consumeRequestedSwitch(sessionId: string): boolean {
    if (!sessionId || wsClient.requestedSwitch !== sessionId) return false;
    wsClient.requestedSwitch = null;
    return true;
  },
};
vi.mock('@/lib/ws-client', () => ({ getWSClient: () => wsClient }));

const toast = { success: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() };
vi.mock('@/components/Toaster', () => ({ toast }));

vi.mock('@/lib/view-navigation', () => ({
  navigateToView: vi.fn(),
  showPanel: vi.fn(),
  isRoutePinnedView: () => false,
  resetUiNavigationToHome: vi.fn(),
}));
vi.mock('@/lib/desktop-shell', () => ({ isDesktopShell: () => false }));

const { useChatStore, useConfigStore, useFleetStore, useSessionStore, useSessionTabStore } =
  await import('../../src/stores');
const { handleModelSwitchResult } = await import(
  '../../src/hooks/ws-handlers/session-context-handlers'
);
const { chatLane, readLane, useChatLanes } = await import('../../src/stores/chat-lanes');
const { readSessionLane, sessionLane, useSessionLanes } = await import(
  '../../src/stores/session-lanes'
);
const { handleError, handleSessionStart } = await import(
  '../../src/hooks/ws-handlers/session-handlers'
);
const { handleIterationStarted, handleTextDelta, handleThinkingDelta } = await import(
  '../../src/hooks/ws-handlers/chat-handlers'
);
const { handleProviderFallback, handleProviderResponse } = await import(
  '../../src/hooks/ws-handlers/session-execution-handlers'
);
const { streamCoalescer } = await import('../../src/lib/stream-coalescer');

/** A `session.start` the user asked for: the session takes the foreground. */
function start(sessionId: string, extra: Record<string, unknown> = {}) {
  wsClient.requestedSwitch = sessionId;
  handleSessionStart({
    type: 'session.start',
    payload: { sessionId, model: 'm', provider: 'p', reset: true, ...extra },
  } as never);
}

/** A server-side re-announce nobody asked for. Must not move the foreground. */
function reannounce(sessionId: string, extra: Record<string, unknown> = {}) {
  wsClient.requestedSwitch = null;
  handleSessionStart({
    type: 'session.start',
    payload: { sessionId, model: 'm', provider: 'p', ...extra },
  } as never);
}

function fire(type: string, sessionId: string, payload: Record<string, unknown> = {}) {
  const handlers: Record<string, (msg: never) => void> = {
    'iteration.started': handleIterationStarted,
    'provider.text_delta': handleTextDelta,
    'provider.thinking_delta': handleThinkingDelta,
    'provider.response': handleProviderResponse,
  };
  handlers[type]?.({ type, payload: { sessionId, ...payload } } as never);
}

beforeEach(() => {
  // jsdom ships no matchMedia; the replay branch consults it for the mobile
  // sidebar collapse.
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      onchange: null,
      dispatchEvent: vi.fn(),
    })) as never;
  }
  streamCoalescer.flushAll();
  useChatLanes.setState({ lanes: {}, activeSessionId: '__unbound__' });
  useSessionLanes.setState({ lanes: {}, activeSessionId: '__unbound__' });
  useSessionTabStore.setState({ openTabIds: [], lastSeenCounts: {}, attention: {} });
  useFleetStore.setState({ agents: new Map() });
  send.mockClear();
});

describe('session.start — tab isolation', () => {
  it('keeps each tab transcript, and finds it unchanged on the way back', () => {
    start('sess_a');
    useChatStore.getState().addMessage({ role: 'user', content: 'question in tab A' });
    useChatStore.getState().addMessage({ role: 'assistant', content: 'answer in tab A' });

    // Opening a second tab must not touch tab A's conversation.
    start('sess_b');
    expect(useChatStore.getState().messages).toHaveLength(0);
    expect(useChatStore.getState().boundSessionId).toBe('sess_b');
    expect(readLane('sess_a').messages).toHaveLength(2);

    // Clicking back into tab A brings its history back verbatim.
    start('sess_a');
    expect(useChatStore.getState().messages.map((m) => m.content)).toEqual([
      'question in tab A',
      'answer in tab A',
    ]);
  });

  it('keeps a composer queue with the tab it was typed in', () => {
    start('sess_a');
    useChatStore.getState().enqueue('draft for tab A');

    start('sess_b');
    expect(useChatStore.getState().queue).toHaveLength(0);

    start('sess_a');
    expect(useChatStore.getState().queue.map((q) => q.text)).toEqual(['draft for tab A']);
  });

  it('does not zero a tab token and cost accounting when returning to it', () => {
    start('sess_a');
    useSessionStore.setState({
      totalTokens: { input: 1200, output: 340, cacheRead: 0, cacheWrite: 0 },
      cost: 0.42,
    });

    start('sess_b');
    expect(useSessionStore.getState().totalTokens.input).toBe(0);

    start('sess_a');
    expect(useSessionStore.getState().totalTokens).toMatchObject({ input: 1200, output: 340 });
    expect(useSessionStore.getState().cost).toBeCloseTo(0.42);
  });

  it('keeps a running tab live transcript instead of replacing it with a stale replay', () => {
    start('sess_a');
    useChatStore.getState().addMessage({ role: 'assistant', content: 'streaming right now' });

    start('sess_b');
    // Server replays the journal, which is behind the live run.
    start('sess_a', {
      isRunning: true,
      replayMessages: [{ role: 'assistant', content: 'stale persisted copy' }],
    });

    const contents = useChatStore.getState().messages.map((m) => m.content);
    expect(contents).toContain('streaming right now');
    expect(contents).not.toContain('stale persisted copy');
    expect(useChatStore.getState().isLoading).toBe(true);
  });

  it('applies a background tab model switch to that tab, not the one in front', () => {
    start('sess_a');
    start('sess_b');
    useConfigStore.getState().setConfig({ provider: 'prov-b', model: 'model-b' });

    // A successful switch is broadcast to every surface. Applying it to
    // whatever session is in front re-labelled the wrong tab.
    handleModelSwitchResult({
      type: 'model.switch_result',
      payload: {
        success: true,
        provider: 'prov-a',
        model: 'model-a',
        runActive: false,
        sessionId: 'sess_a',
      },
    } as never);

    // The foreground's pickers and label are untouched...
    expect(useConfigStore.getState().model).toBe('model-b');
    expect(useSessionStore.getState().session?.model).not.toBe('model-a');
    // ...and tab A now reports the model it is actually running.
    expect(readSessionLane('sess_a').session).toMatchObject({
      model: 'model-a',
      provider: 'prov-a',
    });
  });

  it('keeps a background tab’s provider fallback off the foreground’s model chip', () => {
    start('sess_a');
    start('sess_b');
    useConfigStore.getState().setConfig({ provider: 'prov-b', model: 'model-b' });

    // A fallback is a route change that happens to the tab whose request hit
    // the error. Writing the global pair unconditionally relabelled whatever
    // tab was on screen — and told the model switcher that tab was running a
    // model it had never been given.
    handleProviderFallback({
      type: 'provider.fallback',
      payload: {
        sessionId: 'sess_a',
        from: { providerId: 'prov-a', model: 'model-a' },
        to: { providerId: 'prov-f', model: 'model-f' },
        status: 429,
        providerSwitched: true,
      },
    } as never);

    expect(useConfigStore.getState().model).toBe('model-b');
    expect(readSessionLane('sess_a').session).toMatchObject({
      provider: 'prov-f',
      model: 'model-f',
    });
  });

  it('does move the chip when the fallback belongs to the tab in front', () => {
    start('sess_a');

    handleProviderFallback({
      type: 'provider.fallback',
      payload: {
        sessionId: 'sess_a',
        from: { providerId: 'prov-a', model: 'model-a' },
        to: { providerId: 'prov-f', model: 'model-f' },
        status: 429,
        providerSwitched: true,
      },
    } as never);

    expect(useConfigStore.getState().model).toBe('model-f');
  });

  it('applies a foreground tab model switch normally', () => {
    start('sess_a');

    handleModelSwitchResult({
      type: 'model.switch_result',
      payload: {
        success: true,
        provider: 'prov-x',
        model: 'model-x',
        runActive: false,
        sessionId: 'sess_a',
      },
    } as never);

    expect(useConfigStore.getState().model).toBe('model-x');
    expect(useSessionStore.getState().session?.model).toBe('model-x');
  });

  it('keeps other tabs subagents when one session is retired', () => {
    useFleetStore.setState({
      agents: new Map([
        ['ag_a', { id: 'ag_a', sessionId: 'sess_a', status: 'running' }],
        ['ag_b', { id: 'ag_b', sessionId: 'sess_b', status: 'running' }],
      ] as never),
    });

    start('sess_new', { clearedSessionId: 'sess_a' });

    expect([...useFleetStore.getState().agents.keys()]).toEqual(['ag_b']);
  });

  it('leaves every tab roster intact when no session is retired', () => {
    useFleetStore.setState({
      agents: new Map([
        ['ag_a', { id: 'ag_a', sessionId: 'sess_a', status: 'running' }],
        ['ag_b', { id: 'ag_b', sessionId: 'sess_b', status: 'running' }],
      ] as never),
    });

    // Opening a fresh tab: nothing is being retired, so nothing is evicted.
    start('sess_new');

    expect([...useFleetStore.getState().agents.keys()].sort()).toEqual(['ag_a', 'ag_b']);
  });
});

describe('a background run reaches its own tab and no other', () => {
  beforeEach(() => {
    start('sess_a');
    start('sess_b'); // tab B is the one on screen
  });

  it('streams tokens into the background tab, not the transcript in front', () => {
    fire('provider.text_delta', 'sess_a', { text: 'tokens for A', messageId: 'm1' });
    streamCoalescer.flushAll();

    expect(useChatStore.getState().messages).toHaveLength(0);
    expect(readLane('sess_a').messages.map((m) => m.content)).toEqual(['tokens for A']);
  });

  it('keeps reasoning buffers separate', () => {
    fire('provider.thinking_delta', 'sess_a', { text: 'A is thinking' });
    fire('provider.thinking_delta', 'sess_b', { text: 'B is thinking' });
    streamCoalescer.flushAll();

    expect(readLane('sess_a').thinkingBuffer).toBe('A is thinking');
    expect(readLane('sess_b').thinkingBuffer).toBe('B is thinking');
  });

  it('runs the loading flag per tab', () => {
    fire('iteration.started', 'sess_a', { index: 1, maxIterations: 10 });

    expect(readLane('sess_a').isLoading).toBe(true);
    expect(useChatStore.getState().isLoading).toBe(false);
  });

  it('credits usage and cost to the tab that earned them', () => {
    sessionLane('sess_a').setEnvRates({ inputCost: 3, outputCost: 15, cacheReadCost: 0.3 });
    fire('provider.response', 'sess_a', {
      usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
      stopReason: 'end_turn',
      messageId: 'm1',
    });

    expect(readSessionLane('sess_a').totalTokens.input).toBe(1_000_000);
    expect(readSessionLane('sess_a').cost).toBeCloseTo(3);
    // The tab in front earned nothing.
    expect(useSessionStore.getState().totalTokens.input).toBe(0);
    expect(useSessionStore.getState().cost).toBe(0);
  });

  it('runs the iteration counter per tab', () => {
    fire('iteration.started', 'sess_a', { index: 7, maxIterations: 10 });

    expect(readSessionLane('sess_a').iteration).toEqual({ index: 7, max: 10 });
    expect(useSessionStore.getState().iteration).toBeNull();
  });

  it('does not let an untagged chat event guess a tab', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    handleTextDelta({
      type: 'provider.text_delta',
      payload: { text: 'whose is this?', messageId: 'x' },
    } as never);
    streamCoalescer.flushAll();

    expect(readLane('sess_a').messages).toHaveLength(0);
    expect(readLane('sess_b').messages).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does not re-point the foreground when a background tab re-announces', () => {
    // A model switch or a server-side re-broadcast answers with `session.start`
    // for a tab that is NOT in front. Following it would yank the user out of
    // the tab they are typing in.
    reannounce('sess_a');
    expect(useChatStore.getState().boundSessionId).toBe('sess_b');
  });

  /**
   * The grant that decides "does this session take the foreground" is keyed by
   * session id. It used to be a bare boolean, and `session.start` arrives for
   * sessions nobody clicked all the time — a background tab's answer landing
   * late, a server re-announce. The first such arrival spent the grant meant
   * for the tab the user actually clicked, took the foreground, and left the
   * real answer looking unrequested. That is the whole of "I click tab 2 and
   * get tab 1's transcript".
   */
  it('spends a focus grant only on the session it was issued for', () => {
    // The user clicks tab A. The grant is issued for sess_a.
    wsClient.requestedSwitch = 'sess_a';

    // sess_b's answer arrives first. It must not take the grant, or the front.
    handleSessionStart({
      type: 'session.start',
      payload: { sessionId: 'sess_b', model: 'm', provider: 'p', reset: true },
    } as never);
    expect(useChatStore.getState().boundSessionId).toBe('sess_b');
    expect(wsClient.requestedSwitch).toBe('sess_a');

    // sess_a's own answer still claims it.
    handleSessionStart({
      type: 'session.start',
      payload: { sessionId: 'sess_a', model: 'm', provider: 'p', reset: true },
    } as never);
    expect(useChatStore.getState().boundSessionId).toBe('sess_a');
    expect(wsClient.requestedSwitch).toBe(null);
  });

  /**
   * `error` carries the failure that ENDED a run, and clearing the run flag is
   * part of delivering it. Gating this handler on "is this the tab in front"
   * dropped a background tab's failure entirely: its lane stayed `isLoading`
   * with nothing on screen to explain it, so an idle tab reported itself busy
   * and refused to close.
   */
  it('delivers a background tab error to its own lane and clears its run flag', () => {
    fire('iteration.started', 'sess_a', { index: 1, maxIterations: 10 });
    expect(readLane('sess_a').isLoading).toBe(true);

    handleError({
      type: 'error',
      payload: {
        sessionId: 'sess_a',
        phase: 'user_message',
        message: 'Agent is already processing a request.',
      },
    } as never);

    expect(readLane('sess_a').isLoading).toBe(false);
    expect(readLane('sess_a').messages.at(-1)?.content).toContain('already processing');
    // The tab in front neither shows the error nor changes state.
    expect(useChatStore.getState().messages).toHaveLength(0);
    expect(useChatStore.getState().isLoading).toBe(false);
  });

  /**
   * A tab switch can race the server's session pointer: the client asks to
   * resume session X while the runtime still fronts session Y, and the
   * session-swap guard answers with an error frame tagged `requestedSessionId`.
   * That frame is routing noise — the request never ran, no run ended — and
   * the server tags it with the session in FRONT. Delivering it dropped a
   * "[session.resume] Request targeted session …" bubble into whatever chat
   * was visible (mid-stream, on every switch) and cleared that lane's run
   * flag. It must vanish without a trace.
   */
  it('drops a session-swap guard rejection without touching any lane', () => {
    start('sess_a');
    fire('iteration.started', 'sess_a', { index: 1, maxIterations: 10 });
    expect(readLane('sess_a').isLoading).toBe(true);

    handleError({
      type: 'error',
      payload: {
        sessionId: 'sess_a',
        phase: 'session.resume',
        message:
          'Request targeted session 2026-08-26/sess_old, but this WebUI runtime is currently on 2026-08-26/sess_a.',
        requestedSessionId: '2026-08-26/sess_old',
      },
    } as never);

    // No bubble anywhere, and the live run is left exactly as it was.
    expect(readLane('sess_a').messages).toHaveLength(0);
    expect(readLane('sess_a').isLoading).toBe(true);
    expect(useChatStore.getState().messages).toHaveLength(0);
  });
});

describe('the four slots', () => {
  it('holds one session per slot and one slot per session', () => {
    for (const id of ['s1', 's2', 's3', 's4']) start(id);
    const tabs = useSessionTabStore.getState().openTabIds;
    expect(tabs).toEqual(['s1', 's2', 's3', 's4']);
    expect(new Set(tabs).size).toBe(tabs.length);

    // Re-opening an already-open session switches to its slot rather than
    // taking a second one.
    useSessionTabStore.getState().openTab('s2');
    expect(useSessionTabStore.getState().openTabIds).toEqual(['s1', 's2', 's3', 's4']);
    expect(useChatStore.getState().boundSessionId).toBe('s2');
  });

  it('recycles an idle empty slot rather than growing past four', () => {
    for (const id of ['s1', 's2', 's3', 's4']) start(id);
    chatLane('s1').addMessage({ role: 'user', content: 'busy' });
    chatLane('s2').addMessage({ role: 'user', content: 'busy' });
    chatLane('s3').addMessage({ role: 'user', content: 'busy' });
    // s4 is idle and empty, so it is the one recycled.

    useSessionTabStore.getState().openTab('s5');
    const tabs = useSessionTabStore.getState().openTabIds;
    expect(tabs).toHaveLength(4);
    expect(tabs).toContain('s5');
    expect(tabs).not.toContain('s4');
  });

  it('refuses a fifth session when every slot has work in it', () => {
    for (const id of ['s1', 's2', 's3', 's4']) {
      start(id);
      chatLane(id).addMessage({ role: 'user', content: 'busy' });
    }

    const result = useSessionTabStore.getState().openTab('s5');
    expect(result).toMatchObject({ success: false, reason: 'tabs_full' });
    expect(useSessionTabStore.getState().openTabIds).toHaveLength(4);
    expect(toast.error).toHaveBeenCalled();
  });

  it('never evicts an open slot to make room for an unrequested announce', () => {
    for (const id of ['s1', 's2', 's3', 's4']) {
      start(id);
      chatLane(id).addMessage({ role: 'user', content: 'work in progress' });
    }

    // A fifth session announces itself with nobody asking — a re-broadcast,
    // another surface opening a session, a stale client. This used to append
    // and `slice(-4)`, which silently dropped s1 (running or not) and took its
    // lane with it.
    reannounce('s5');

    expect(useSessionTabStore.getState().openTabIds).toEqual(['s1', 's2', 's3', 's4']);
    expect(readLane('s1').messages).toHaveLength(1);
  });

  it('gives an unrequested announce a slot while one is free', () => {
    start('s1');

    reannounce('s2');

    expect(useSessionTabStore.getState().openTabIds).toEqual(['s1', 's2']);
    // …and without stealing the foreground from the tab the user is typing in.
    expect(useChatStore.getState().boundSessionId).toBe('s1');
  });

  it('frees the lane when a slot closes, so nothing keeps accruing off-screen', () => {
    start('s1');
    chatLane('s1').addMessage({ role: 'user', content: 'goodbye' });
    start('s2');

    useSessionTabStore.getState().closeTab('s1');

    expect(useSessionTabStore.getState().openTabIds).not.toContain('s1');
    expect(readLane('s1').messages).toHaveLength(0);
    expect(readSessionLane('s1').session).toBeNull();
  });
});
