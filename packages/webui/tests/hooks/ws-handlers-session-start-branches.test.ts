import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The branches of `handleSessionStart` that the resume suite doesn't reach —
 * provider-status hydration, the setup redirect, the non-reset `setSession`
 * path, selective fleet eviction on `clearedSessionId` — plus the smaller
 * session handlers whose bodies were never entered (`context.debug`,
 * `key.operation.result`, `context.compacted`, `compaction.failed`).
 */

const send = vi.fn();
const listSavedProviders = vi.fn();
vi.mock('@/lib/ws-client', () => ({
  // `consumeRequestedSwitch` is how the real client tells the handler that
  // THIS surface asked for the swap, so the session may take the foreground.
  // Without it a `session.start` only fills its own lane, which is what keeps
  // a background re-announce from yanking the user out of the tab they are in.
  getWSClient: () => ({ send, listSavedProviders, consumeRequestedSwitch: () => true }),
}));

const toast = { success: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() };
vi.mock('@/components/Toaster', () => ({ toast }));

const navigateToView = vi.fn();
const showPanel = vi.fn();
vi.mock('@/lib/view-navigation', () => ({ navigateToView, showPanel }));

const isDesktopShell = vi.fn(() => false);
vi.mock('@/lib/desktop-shell', () => ({ isDesktopShell }));

const { useChatStore, useConfigStore, useFleetStore, useSessionStore, useUIStore } = await import(
  '../../src/stores'
);
const { useProviderStatusStore } = await import('../../src/stores/provider-status-store');
const { useChatLanes } = await import('../../src/stores/chat-lanes');
const { useSessionLanes } = await import('../../src/stores/session-lanes');
const {
  handleCompactionFailed,
  handleContextCompacted,
  handleContextDebug,
  handleKeyOperationResult,
  handleSessionStart,
} = await import('../../src/hooks/ws-handlers/session-handlers');

const SESSION = 'sess_branch';

function start(payload: Record<string, unknown>) {
  handleSessionStart({
    type: 'session.start',
    payload: { sessionId: SESSION, model: 'm', provider: 'p', ...payload },
  } as never);
}

/** The store keeps the active session id — handlers gate on it. */
function activate(id = SESSION) {
  useSessionStore.setState({ session: { id, startedAt: Date.now(), model: 'm', provider: 'p' } });
}

function chat(): string {
  const msgs = useChatStore.getState().messages as Array<{ content: string }>;
  return msgs[msgs.length - 1]?.content ?? '';
}

/** Same API the handler formats with, so the assertion is locale-independent. */
function n(value: number): string {
  return value.toLocaleString();
}

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom ships no matchMedia; the handler calls it optionally.
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (() => ({ matches: false })) as unknown as typeof window.matchMedia,
  });
  isDesktopShell.mockReturnValue(false);
  history.pushState(null, '', '/');
  // Every test opens `sess_branch` as if for the first time; a lane left over
  // from the previous test would make the second `start()` look like a
  // re-announce of an already-open tab.
  useChatLanes.setState({ lanes: {}, activeSessionId: '__unbound__' });
  useSessionLanes.setState({ lanes: {}, activeSessionId: '__unbound__' });
  useChatStore.getState().clearMessages();
  useChatStore.getState().setLoading(false);
  useConfigStore.setState({ provider: '', model: '' });
  useSessionStore.setState({ session: null, todos: [], lastInputTokens: 0 });
  useFleetStore.setState({ agents: new Map() });
  useProviderStatusStore.setState({ entries: {} });
});

describe('session.start — provider status hydration', () => {
  it('hydrates the status store from the snapshot on the payload', () => {
    start({
      providerStatuses: [
        {
          providerId: 'openai',
          model: 'gpt-5',
          state: 'degraded',
          lastErrorKind: 'rate_limit',
          stateExpiresAt: 5_000,
          lastFailureAt: 4_000,
        },
      ],
    });

    // `entries` is a record keyed by `${providerId}\0${model}`, not an array.
    const entries = Object.values(useProviderStatusStore.getState().entries);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      providerId: 'openai',
      model: 'gpt-5',
      state: 'degraded',
      reason: 'rate_limit',
      updatedAt: 4_000,
      stateExpiresAt: 5_000,
    });
  });

  it('falls back to the state as the reason when no error kind is given', () => {
    start({
      providerStatuses: [
        { providerId: 'openai', model: 'gpt-5', state: 'blocked', lastErrorKind: null },
      ],
    });
    expect(Object.values(useProviderStatusStore.getState().entries)[0]).toMatchObject({
      reason: 'blocked',
      stateExpiresAt: undefined,
    });
  });

  it('drops healthy entries — the store only tracks degraded and blocked routes', () => {
    start({
      providerStatuses: [
        { providerId: 'openai', model: 'a', state: 'healthy' },
        { providerId: 'openai', model: 'b', state: 'blocked' },
      ],
    });
    const entries = Object.values(useProviderStatusStore.getState().entries);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ model: 'b' });
  });

  it('leaves the status store alone when the field is absent', () => {
    useProviderStatusStore.setState({
      entries: {
        'x\u0000y': {
          providerId: 'x',
          model: 'y',
          state: 'blocked',
          reason: 'ok',
          updatedAt: 1,
        },
      },
    });
    start({});
    expect(Object.keys(useProviderStatusStore.getState().entries)).toHaveLength(1);
  });

  it('ignores a non-array providerStatuses field', () => {
    start({ providerStatuses: { providerId: 'openai' } });
    expect(Object.keys(useProviderStatusStore.getState().entries)).toHaveLength(0);
  });
});

describe('session.start — setup redirect', () => {
  it('navigates to setup when the server says the workspace is unconfigured', () => {
    start({ needsSetup: true });
    expect(navigateToView).toHaveBeenCalledWith('setup');
  });

  it('does not navigate when setup is complete', () => {
    start({});
    expect(navigateToView).not.toHaveBeenCalled();
  });

  it('skips the desktop home reset while setup is pending', () => {
    isDesktopShell.mockReturnValue(true);
    useUIStore.setState({ currentView: 'settings' } as never);
    start({ needsSetup: true });
    // resetUiNavigationToHome would send the shell to chat, clearing the setup
    // view out from under itself.
    expect(useUIStore.getState().currentView).toBe('settings');
    expect(navigateToView).toHaveBeenCalledWith('setup');
  });

  it('does reset the desktop shell to home once setup is complete', () => {
    isDesktopShell.mockReturnValue(true);
    useUIStore.setState({ currentView: 'settings' } as never);
    start({});
    expect(useUIStore.getState().currentView).toBe('chat');
  });
});

describe('session.start — reset vs. continuation', () => {
  it('starts a fresh session when the id changes', () => {
    activate('sess_old');
    start({});
    expect(useSessionStore.getState().session?.id).toBe(SESSION);
    expect(useChatStore.getState().boundSessionId).toBe(SESSION);
  });

  it('keeps the original startedAt when the same session re-announces', () => {
    useSessionStore.setState({
      session: { id: SESSION, startedAt: 111, model: 'old', provider: 'old' },
    });
    start({ model: 'new-model' });

    const session = useSessionStore.getState().session;
    expect(session?.startedAt).toBe(111);
    expect(session?.model).toBe('new-model');
  });

  it('does not clear the transcript on a same-session re-announce', () => {
    useSessionStore.setState({
      session: { id: SESSION, startedAt: 111, model: 'm', provider: 'p' },
    });
    useChatStore.getState().addMessage({ role: 'user', content: 'keep me' });
    start({});
    expect(chat()).toBe('keep me');
  });

  it('re-announcing with reset:true does clear it', () => {
    useSessionStore.setState({
      session: { id: SESSION, startedAt: 111, model: 'm', provider: 'p' },
    });
    useChatStore.getState().addMessage({ role: 'user', content: 'drop me' });
    start({ reset: true });
    expect(useChatStore.getState().messages).toHaveLength(0);
  });

  it('requests the file tree for the new cwd on a reset', () => {
    start({ cwd: '/repo' });
    expect(send).toHaveBeenCalledWith({ type: 'files.tree', payload: { path: '/repo' } });
  });
});

describe('session.start — fleet eviction', () => {
  const agent = (id: string, sessionId: string) =>
    [id, { id, sessionId, name: id, status: 'idle' }] as const;

  it('keeps agents belonging to other sessions when one session is cleared', () => {
    useFleetStore.setState({
      agents: new Map([agent('a', 'sess_gone'), agent('b', 'sess_other')] as never),
    });
    start({ clearedSessionId: 'sess_gone' });

    const agents = useFleetStore.getState().agents;
    expect(agents.has('a')).toBe(false);
    expect(agents.has('b')).toBe(true);
  });

  it('keeps every roster when no session is being retired', () => {
    // Opening a tab is not a fleet reset. Wiping the whole roster here deleted
    // the running subagents of the three tabs the user did not touch; only a
    // named `clearedSessionId` evicts anything.
    useFleetStore.setState({
      agents: new Map([agent('a', 'sess_gone'), agent('b', 'sess_other')] as never),
    });
    start({});
    expect([...useFleetStore.getState().agents.keys()].sort()).toEqual(['a', 'b']);
  });
});

describe('session.start — post-replay navigation', () => {
  const replay = [{ role: 'user', content: 'hi', ts: '2026-01-01T00:00:00.000Z' }];

  it('returns a browser client to chat after a reset replay', () => {
    useUIStore.setState({ currentView: 'settings' } as never);
    start({ replayMessages: replay });
    expect(showPanel).toHaveBeenCalledWith('chat');
  });

  it('leaves the view alone when it is already chat', () => {
    useUIStore.setState({ currentView: 'chat' } as never);
    start({ replayMessages: replay });
    expect(showPanel).not.toHaveBeenCalled();
  });

  it('resets to home instead of showPanel on the desktop shell', () => {
    isDesktopShell.mockReturnValue(true);
    useUIStore.setState({ currentView: 'settings' } as never);
    start({ replayMessages: replay });
    expect(showPanel).not.toHaveBeenCalled();
  });

  it('stays put on a route-pinned view', () => {
    history.pushState(null, '', '/analytics');
    useUIStore.setState({ currentView: 'settings' } as never);
    start({ replayMessages: replay });
    expect(showPanel).not.toHaveBeenCalled();
  });

  it('does not redirect while setup is pending', () => {
    useUIStore.setState({ currentView: 'settings' } as never);
    start({ replayMessages: replay, needsSetup: true });
    expect(showPanel).not.toHaveBeenCalled();
  });

  it('collapses the sidebar on a narrow viewport', () => {
    useUIStore.getState().setSidebarOpen(true);
    window.matchMedia = (() => ({ matches: true })) as never;
    start({ replayMessages: replay });
    expect(useUIStore.getState().sidebarOpen).toBe(false);
  });

  it('leaves the sidebar open on a wide viewport', () => {
    useUIStore.getState().setSidebarOpen(true);
    window.matchMedia = (() => ({ matches: false })) as never;
    start({ replayMessages: replay });
    expect(useUIStore.getState().sidebarOpen).toBe(true);
  });

  it('restores the server-side context estimate', () => {
    start({ replayMessages: replay, lastInputTokens: 4_200 });
    expect(useSessionStore.getState().lastInputTokens).toBe(4_200);
  });

  it('ignores a zero context estimate rather than overwriting a live one', () => {
    // Same session id and no reset flag, so `startSession` (which zeroes the
    // counters) doesn't run and the live value is the one under test.
    useSessionStore.setState({
      session: { id: SESSION, startedAt: 1, model: 'm', provider: 'p' },
      lastInputTokens: 900,
    });
    start({ replayMessages: replay, lastInputTokens: 0 });
    expect(useSessionStore.getState().lastInputTokens).toBe(900);
  });
});

describe('context.debug', () => {
  const payload = {
    total: 123_456,
    systemPrompt: 2_000,
    tools: {
      total: 9_000,
      count: 2,
      breakdown: [
        { name: 'small', tokens: 100 },
        { name: 'big', tokens: 8_900 },
      ],
    },
    messages: {
      total: 112_456,
      count: 2,
      breakdown: [
        { index: 0, role: 'user', tokens: 12, preview: 'hi' },
        { index: 1, role: 'assistant', tokens: 112_444, preview: '' },
      ],
    },
  };

  it('renders the breakdown with the largest entries first', () => {
    activate();
    // Session-stamped, as the server sends it: these handlers write the chat
    // transcript, so an untagged payload is dropped rather than risking one
    // tab's context report landing in another tab's conversation.
    handleContextDebug({
      type: 'context.debug',
      payload: { ...payload, sessionId: SESSION },
    } as never);

    const out = chat();
    expect(out).toContain(`**Total estimate:** ${n(123_456)} tokens`);
    expect(out).toContain(`• System prompt: ${n(2_000)}`);
    expect(out).toContain('• Tool schemas: 9.000 (2 tools)'.replace('9.000', n(9_000)));
    // Sorted descending: `big` precedes `small`.
    expect(out.indexOf('· big')).toBeLessThan(out.indexOf('· small'));
    expect(out.indexOf('#1 assistant')).toBeLessThan(out.indexOf('#0 user'));
  });

  it('substitutes a placeholder for an empty message preview', () => {
    activate();
    handleContextDebug({
      type: 'context.debug',
      payload: { ...payload, sessionId: SESSION },
    } as never);
    expect(chat()).toContain('(empty)');
  });

  it('ignores a message for another session', () => {
    activate('sess_other');
    handleContextDebug({
      type: 'context.debug',
      payload: { ...payload, sessionId: SESSION },
    } as never);
    expect(useChatStore.getState().messages).toHaveLength(0);
  });
});

describe('key.operation.result', () => {
  it('toasts success and refreshes the saved provider list', () => {
    handleKeyOperationResult({
      type: 'key.operation.result',
      payload: { success: true, message: 'saved' },
    } as never);

    expect(toast.success).toHaveBeenCalledWith('saved');
    expect(toast.error).not.toHaveBeenCalled();
    expect(listSavedProviders).toHaveBeenCalled();
  });

  it('toasts the failure message', () => {
    handleKeyOperationResult({
      type: 'key.operation.result',
      payload: { success: false, message: 'bad key' },
    } as never);

    expect(toast.error).toHaveBeenCalledWith('bad key');
  });
});

describe('context.compacted', () => {
  function compact(payload: Record<string, unknown>) {
    activate();
    handleContextCompacted({
      type: 'context.compacted',
      payload: {
        sessionId: SESSION,
        before: 100,
        after: 40,
        saved: 60,
        reductions: [],
        ...payload,
      },
    } as never);
  }

  it('summarises each reduction phase', () => {
    compact({
      reductions: [
        { phase: 'dedupe', saved: 40 },
        { phase: 'trim', saved: 20 },
      ],
    });
    expect(chat()).toContain('dedupe: 40, trim: 20');
  });

  it('says no-op when nothing was reduced', () => {
    compact({});
    expect(chat()).toContain('no-op');
  });

  it('appends the repair counts when the transcript was also repaired', () => {
    compact({
      repaired: { removedToolUses: ['a', 'b'], removedToolResults: ['c'], removedMessages: 3 },
    });
    expect(chat()).toContain('repaired 2 tool_use, 1 tool_result, 3 empty messages');
  });

  it('treats an absent removedToolUses list as zero', () => {
    compact({
      repaired: { removedToolUses: undefined, removedToolResults: [], removedMessages: 0 },
    });
    expect(chat()).toContain('repaired 0 tool_use, 0 tool_result, 0 empty messages');
  });

  it('rebases the context estimate onto the post-compaction total', () => {
    useSessionStore.setState({ lastInputTokens: 100 });
    compact({});
    expect(useSessionStore.getState().lastInputTokens).toBe(40);
  });

  it('ignores a message for another session', () => {
    activate('sess_other');
    handleContextCompacted({
      type: 'context.compacted',
      payload: { before: 1, after: 1, saved: 0, reductions: [], sessionId: SESSION },
    } as never);
    expect(useChatStore.getState().messages).toHaveLength(0);
  });
});

describe('compaction.failed', () => {
  function fail(payload: Record<string, unknown>) {
    handleCompactionFailed({
      type: 'compaction.failed',
      payload: {
        sessionId: SESSION,
        message: 'provider refused',
        level: 'aggressive',
        tokens: 50,
        maxContext: 200,
        fatal: false,
        ...payload,
      },
    } as never);
  }

  it('derives the load from tokens against the context window', () => {
    activate();
    fail({});
    expect(chat()).toBe('Compaction failed at aggressive (25% context): provider refused');
    expect(toast.error).toHaveBeenCalledWith('Compaction failed: provider refused');
  });

  it('prefers the server-supplied input budget when present', () => {
    activate();
    fail({ budget: { inputTokens: 10, availableInputTokens: 100, load: 0.42 } });
    expect(chat()).toContain('(42% input budget)');
  });

  it('falls back to the context ratio when the budget has no headroom figure', () => {
    activate();
    fail({ budget: { inputTokens: 10, availableInputTokens: 0, load: 0.42 } });
    expect(chat()).toContain('(25% context)');
  });

  it('reports 0% rather than dividing by a zero context window', () => {
    activate();
    fail({ maxContext: 0 });
    expect(chat()).toContain('(0% context)');
  });

  it('clamps a load above the window to 100%', () => {
    activate();
    fail({ tokens: 500, maxContext: 200 });
    expect(chat()).toContain('(100% context)');
  });

  it('marks a fatal failure as an error bubble', () => {
    activate();
    fail({ fatal: true });
    const last = useChatStore.getState().messages.at(-1) as { isError?: boolean };
    expect(last.isError).toBe(true);
  });

  it('ignores a message for another session', () => {
    activate('sess_other');
    fail({ sessionId: SESSION });
    expect(useChatStore.getState().messages).toHaveLength(0);
  });
});
