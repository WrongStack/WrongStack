import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── stubs ───────────────────────────────────────────────────────────────────

const installFaviconVisibilityReset = vi.fn();
vi.mock('@/lib/favicon', () => ({ installFaviconVisibilityReset, setFaviconStatus: vi.fn() }));

type Handler = (msg: unknown) => void;

/** Records every action call so the delegation tests can assert on it. */
function makeClient() {
  const handlers = new Map<string, Set<Handler>>();
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const statusListeners = new Set<(s: string) => void>();
  let connectImpl: () => Promise<void> = async () => {};
  let suppressed = new Set<string>();

  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return null;
    };

  const client = {
    calls,
    isConnected: true,
    setConnect(fn: () => Promise<void>) {
      connectImpl = fn;
    },
    suppress(type: string) {
      suppressed.add(type);
    },
    resetSuppressed() {
      suppressed = new Set();
    },
    connect: () => connectImpl(),
    onStatus(cb: (s: string) => void) {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },
    emitStatus(s: string) {
      for (const cb of [...statusListeners]) cb(s);
    },
    statusListenerCount: () => statusListeners.size,
    on(type: string, handler: Handler) {
      const set = handlers.get(type) ?? new Set<Handler>();
      set.add(handler);
      handlers.set(type, set);
      return () => {
        set.delete(handler);
      };
    },
    emit(type: string, msg: unknown) {
      for (const h of [...(handlers.get(type) ?? [])]) h(msg);
    },
    handlerCount: () => [...handlers.values()].reduce((n, s) => n + s.size, 0),
    consumeSuppressedChatEcho: (type: string) => suppressed.delete(type),
    getPrefs: record('getPrefs'),
    send: record('send'),
    sendMessage: record('sendMessage'),
    adviseTopic: record('adviseTopic'),
    sendAbort: record('sendAbort'),
    sendConfirm: record('sendConfirm'),
    switchModel: record('switchModel'),
    listSessions: record('listSessions'),
    renameSession: record('renameSession'),
    resumeSessionById: record('resumeSessionById'),
    deleteSession: record('deleteSession'),
    saveSession: record('saveSession'),
    listTools: record('listTools'),
    getSage: record('getSage'),
    refineModel: record('refineModel'),
    switchAutonomy: record('switchAutonomy'),
    updatePrefs: record('updatePrefs'),
  };
  return client;
}

let client: ReturnType<typeof makeClient>;
const seenUrls: Array<string | undefined> = [];

vi.mock('@/lib/ws-client', () => ({
  getWSClient: (url?: string) => {
    seenUrls.push(url);
    return client;
  },
}));

const WS_HANDLERS: Record<string, ((msg: unknown) => void) | undefined> = {
  'session.start': vi.fn(),
  'provider.text_delta': vi.fn(),
  'never.registered': undefined,
};
vi.mock('../../src/hooks/ws-handlers.js', () => ({ WS_HANDLERS }));

const { useConfigStore, useHistoryStore, useUIStore } = await import('../../src/stores');
const { useWebSocket, useWebSocketBootstrap } = await import('../../src/hooks/useWebSocket');

describe('useWebSocketBootstrap', () => {
  beforeEach(() => {
    client = makeClient();
    seenUrls.length = 0;
    installFaviconVisibilityReset.mockReset();
    for (const fn of Object.values(WS_HANDLERS)) (fn as ReturnType<typeof vi.fn>)?.mockReset?.();
    useConfigStore.setState({
      autoConnect: true,
      wsUrl: 'ws://localhost:3456',
      setWsStatus: vi.fn(),
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does nothing when autoConnect is off', () => {
    act(() => {
      useConfigStore.setState({ autoConnect: false } as never);
    });
    renderHook(() => useWebSocketBootstrap());
    expect(installFaviconVisibilityReset).not.toHaveBeenCalled();
    expect(client.handlerCount()).toBe(0);
  });

  it('installs the favicon visibility reset once connected', () => {
    renderHook(() => useWebSocketBootstrap());
    expect(installFaviconVisibilityReset).toHaveBeenCalled();
  });

  it('registers exactly one handler per defined WS_HANDLERS entry', () => {
    renderHook(() => useWebSocketBootstrap());
    // The `undefined` entry is skipped.
    expect(client.handlerCount()).toBe(2);
  });

  it('dispatches an incoming frame to its handler', () => {
    renderHook(() => useWebSocketBootstrap());
    const msg = { type: 'session.start', payload: {} };
    client.emit('session.start', msg);
    expect(WS_HANDLERS['session.start']).toHaveBeenCalledWith(msg);
  });

  it('swallows a frame the client marked as a suppressed chat echo', () => {
    renderHook(() => useWebSocketBootstrap());
    client.suppress('provider.text_delta');
    client.emit('provider.text_delta', { type: 'provider.text_delta' });
    expect(WS_HANDLERS['provider.text_delta']).not.toHaveBeenCalled();

    // The suppression is one-shot — the next frame gets through.
    client.emit('provider.text_delta', { type: 'provider.text_delta' });
    expect(WS_HANDLERS['provider.text_delta']).toHaveBeenCalledTimes(1);
  });

  it('pulls the server preference snapshot after connecting', async () => {
    renderHook(() => useWebSocketBootstrap());
    await vi.waitFor(() => {
      expect(client.calls.some((c) => c.method === 'getPrefs')).toBe(true);
    });
  });

  it('mirrors socket status into the config store', () => {
    const setWsStatus = vi.fn();
    act(() => {
      useConfigStore.setState({ setWsStatus } as never);
    });
    renderHook(() => useWebSocketBootstrap());
    client.emitStatus('open');
    expect(setWsStatus).toHaveBeenCalledWith('open');
  });

  it('logs a structured warning when the connection fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    client.setConnect(async () => {
      throw new Error('ECONNREFUSED');
    });
    renderHook(() => useWebSocketBootstrap());
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    const payload = JSON.parse(warn.mock.calls[0]?.[0] as string);
    expect(payload).toMatchObject({
      level: 'warn',
      event: 'webui.ws_connection_failed',
      message: 'ECONNREFUSED',
    });
  });

  it('stringifies a non-Error rejection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    client.setConnect(async () => {
      throw 'plain failure';
    });
    renderHook(() => useWebSocketBootstrap());
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(JSON.parse(warn.mock.calls[0]?.[0] as string).message).toBe('plain failure');
  });

  it('does not touch state after unmount when connect resolves late', async () => {
    let release!: () => void;
    client.setConnect(() => new Promise<void>((r) => (release = r)));
    const { unmount } = renderHook(() => useWebSocketBootstrap());
    unmount();
    release();
    await Promise.resolve();
    expect(client.calls.some((c) => c.method === 'getPrefs')).toBe(false);
  });

  it('does not warn after unmount when connect rejects late', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let fail!: (e: unknown) => void;
    client.setConnect(() => new Promise<void>((_r, rej) => (fail = rej)));
    const { unmount } = renderHook(() => useWebSocketBootstrap());
    unmount();
    fail(new Error('late'));
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).not.toHaveBeenCalled();
  });

  it('detaches every handler and the status listener on unmount', () => {
    const { unmount } = renderHook(() => useWebSocketBootstrap());
    expect(client.handlerCount()).toBe(2);
    expect(client.statusListenerCount()).toBe(1);
    unmount();
    expect(client.handlerCount()).toBe(0);
    expect(client.statusListenerCount()).toBe(0);
  });

  it('re-installs handlers when wsUrl changes — a stale install silently drops every frame', () => {
    const { rerender } = renderHook(() => useWebSocketBootstrap());
    expect(client.handlerCount()).toBe(2);

    act(() => {
      useConfigStore.setState({ wsUrl: 'ws://localhost:9999' } as never);
    });
    rerender();

    // Old handlers torn down, new ones installed — still exactly one set.
    expect(client.handlerCount()).toBe(2);
    expect(seenUrls).toContain('ws://localhost:9999');
  });
});

describe('useWebSocket', () => {
  beforeEach(() => {
    client = makeClient();
    seenUrls.length = 0;
    useConfigStore.setState({ wsUrl: 'ws://localhost:3456' } as never);
    useUIStore.setState({ hideConfirm: vi.fn() } as never);
    useHistoryStore.setState({ entries: [], loading: false, error: null } as never);
  });

  function setup() {
    return renderHook(() => useWebSocket()).result;
  }

  it('returns the singleton client for the configured url', () => {
    const r = setup();
    expect(r.current.client).toBe(client);
    expect(seenUrls).toContain('ws://localhost:3456');
  });

  it("registers no handlers — that is the bootstrap hook's job", () => {
    setup();
    expect(client.handlerCount()).toBe(0);
  });

  // ── sendMessage gating ────────────────────────────────────────────────────

  it('sends a message when connected', () => {
    const r = setup();
    r.current.sendMessage('hello');
    expect(client.calls).toContainEqual({ method: 'sendMessage', args: ['hello', undefined] });
  });

  it('forwards image attachments', () => {
    const r = setup();
    const images = [{ data: 'AA', mediaType: 'image/png' }] as never;
    r.current.sendMessage('hi', images);
    expect(client.calls).toContainEqual({ method: 'sendMessage', args: ['hi', images] });
  });

  it('forwards a fresh-context decision without changing ordinary sends', () => {
    const r = setup();
    r.current.sendMessage('new topic', undefined, true);
    expect(client.calls).toContainEqual({
      method: 'sendMessage',
      args: ['new topic', undefined, true],
    });
  });

  it('delegates bounded topic advice to the websocket client', () => {
    const r = setup();
    r.current.adviseTopic('new topic');
    expect(client.calls).toContainEqual({ method: 'adviseTopic', args: ['new topic'] });
  });

  it('drops the message and returns null while disconnected', () => {
    client.isConnected = false;
    const r = setup();
    expect(r.current.sendMessage('hello')).toBeNull();
    expect(client.calls.some((c) => c.method === 'sendMessage')).toBe(false);
  });

  // ── confirm ───────────────────────────────────────────────────────────────

  it('sendConfirm answers the server and closes the dialog', () => {
    const hideConfirm = vi.fn();
    useUIStore.setState({ hideConfirm } as never);
    const r = setup();
    r.current.sendConfirm('c1', 'always');
    expect(client.calls).toContainEqual({ method: 'sendConfirm', args: ['c1', 'always'] });
    expect(hideConfirm).toHaveBeenCalled();
  });

  // ── history-store side effects ────────────────────────────────────────────

  it('listSessions flips the history store into its loading state first', () => {
    const r = setup();
    r.current.listSessions(25);
    expect(useHistoryStore.getState().loading).toBe(true);
    expect(client.calls).toContainEqual({ method: 'listSessions', args: [25] });
  });

  it('renameSession patches the local entry optimistically', () => {
    useHistoryStore.setState({ entries: [{ id: 's1' }] } as never);
    const r = setup();
    r.current.renameSession('s1', 'Refactor pass');
    expect(useHistoryStore.getState().entries[0]).toMatchObject({ name: 'Refactor pass' });
    expect(client.calls).toContainEqual({ method: 'renameSession', args: ['s1', 'Refactor pass'] });
  });

  // ── plain delegation ──────────────────────────────────────────────────────

  it.each([
    ['sendAbort', 'sendAbort', [] as unknown[]],
    ['switchModel', 'switchModel', ['anthropic', 'opus']],
    ['deleteSession', 'deleteSession', ['s9']],
    ['resumeSession', 'resumeSessionById', ['s9']],
    ['saveSession', 'saveSession', []],
    ['getSage', 'getSage', ['m1', undefined]],
    ['switchAutonomy', 'switchAutonomy', ['auto']],
    ['updatePrefs', 'updatePrefs', [{ yolo: true }]],
  ] as Array<[string, string, unknown[]]>)('%s delegates to client.%s', (hookFn, method, args) => {
    const r = setup();
    (r.current as unknown as Record<string, (...a: unknown[]) => void>)[hookFn](...args);
    expect(client.calls.some((c) => c.method === method)).toBe(true);
  });

  it('refineModel forwards its options object', () => {
    const r = setup();
    r.current.refineModel('text', { timeoutMs: 5 });
    expect(client.calls).toContainEqual({
      method: 'refineModel',
      args: ['text', { timeoutMs: 5 }],
    });
  });

  // ── goal actions go through raw send ──────────────────────────────────────

  it.each([
    ['pauseGoal', 'goal.pause'],
    ['resumeGoal', 'goal.resume'],
    ['stopGoal', 'goal.stop'],
  ] as Array<[string, string]>)('%s sends %s with an empty payload', (hookFn, type) => {
    const r = setup();
    (r.current as unknown as Record<string, () => void>)[hookFn]();
    expect(client.calls).toContainEqual({ method: 'send', args: [{ type, payload: {} }] });
  });

  it('startGoal defaults autonomous to true', () => {
    const r = setup();
    r.current.startGoal('Ship it');
    expect(client.calls).toContainEqual({
      method: 'send',
      args: [
        { type: 'goal.start', payload: { title: 'Ship it', phases: undefined, autonomous: true } },
      ],
    });
  });

  it('startGoal honours an explicit autonomous flag and phase list', () => {
    const r = setup();
    r.current.startGoal('Ship it', [{ id: 'p1' }], false);
    expect(client.calls).toContainEqual({
      method: 'send',
      args: [
        {
          type: 'goal.start',
          payload: { title: 'Ship it', phases: [{ id: 'p1' }], autonomous: false },
        },
      ],
    });
  });

  it('toggleGoalAutonomous carries the flag', () => {
    const r = setup();
    r.current.toggleGoalAutonomous(false);
    expect(client.calls).toContainEqual({
      method: 'send',
      args: [{ type: 'goal.toggleAutonomous', payload: { autonomous: false } }],
    });
  });

  it('selectGoal carries the phase id', () => {
    const r = setup();
    r.current.selectGoal('p2');
    expect(client.calls).toContainEqual({
      method: 'send',
      args: [{ type: 'goal.selectPhase', payload: { phaseId: 'p2' } }],
    });
  });

  // ── identity stability ────────────────────────────────────────────────────

  it('keeps callback identities stable while the client is unchanged', () => {
    const { result, rerender } = renderHook(() => useWebSocket());
    const first = result.current;
    rerender();
    expect(result.current.sendAbort).toBe(first.sendAbort);
    expect(result.current.getPlan).toBe(first.getPlan);
    expect(result.current.startGoal).toBe(first.startGoal);
  });
});
