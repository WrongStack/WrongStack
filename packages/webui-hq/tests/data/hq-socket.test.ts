import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Minimal WebSocket polyfill for Node
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = FakeWebSocket.CONNECTING;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  url: string;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
  }

  _open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({});
  }
  _close(code?: number, reason?: string): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean: true });
  }
  _error(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onerror?.({});
    // Browser fires onclose after onerror
    this.onclose?.({ code: 1006, reason: 'error', wasClean: false });
  }
  _message(data: string): void {
    this.onmessage?.({ data });
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    if (this.readyState === FakeWebSocket.OPEN) this._close(code, reason);
  }
}

let currentWs: FakeWebSocket | null = null;

// Stub WebSocket with the mock so HqSocket.createWebSocket uses it
const OrigWebSocket = FakeWebSocket as unknown as typeof WebSocket;
const wsProxy = new Proxy(OrigWebSocket, {
  construct(_target, args: [string]) {
    const ws = new FakeWebSocket(args[0]);
    currentWs = ws;
    return ws;
  },
});

const { HqSocket, getHqSocket, closeHqSocket } = await import(
  '../../src/data/transport/hq-socket.js'
);
const { HQ_BROWSER_PEER_RESUME_CLIENT_ID } = await import('@wrongstack/core/hq/protocol');

import type { HqSocketState } from '../../src/data/transport/hq-socket.js';

describe('HqSocket', () => {
  let client: InstanceType<typeof HqSocket>;

  beforeEach(() => {
    vi.useFakeTimers();
    currentWs = null;
    vi.stubGlobal('WebSocket', wsProxy);
    client = new HqSocket({ url: 'ws://test/ws' });
  });

  afterEach(() => {
    vi.useRealTimers();
    client.close();
    // Drop the module-level singleton so the next test starts from a
    // known-empty cache; otherwise URL/heartbeat opts from a previous test
    // leak via `getHqSocket` and trip the conflict-detection warning.
    closeHqSocket();
    // Restore every `vi.spyOn` from this test. The
    // "ignores delayed close events from sockets replaced by reconnect"
    // test spies on `Math.random` and on a per-instance `FakeWebSocket.close`;
    // without this, both shadows persist into later tests and the
    // heartbeat-timeout suite (which also spies on Math.random) inherits
    // a frozen return value, hiding backoff jitter regressions.
    vi.restoreAllMocks();
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────

  it('starts disconnected', () => {
    expect(client.state).toBe('disconnected');
  });

  it('transitions to connecting on connect()', () => {
    client.connect();
    expect(client.state).toBe('connecting');
    expect(currentWs).not.toBeNull();
  });

  it('transitions to connected on WebSocket open', () => {
    client.connect();
    currentWs!._open();
    expect(client.state).toBe('connected');
    expect(client.isConnected).toBe(true);
  });

  it('isConnected returns false before connect', () => {
    expect(client.isConnected).toBe(false);
  });

  it('transitions to disconnected on close()', () => {
    client.connect();
    currentWs!._open();
    client.close();
    expect(client.state).toBe('disconnected');
  });

  it('does not reconnect after close()', () => {
    client.connect();
    currentWs!._open();
    client.close();
    // Simulate a delayed onclose from the old socket
    expect(client.state).toBe('disconnected');
  });

  // ── Double-close guard ────────────────────────────────────────────────

  it('does not double-schedule reconnect on error+close', () => {
    client.connect();
    currentWs!._open();

    // Both error and close fire — scheduleReconnect should only run once
    currentWs!._error();

    // Since scheduleReconnect uses setTimeout, we need to advance timers
    // to verify only one reconnect was attempted
    const prevAttempts = (client as unknown as { reconnectAttempt: number }).reconnectAttempt;
    expect(prevAttempts).toBe(1);
  });

  // ── Heartbeat ─────────────────────────────────────────────────────────

  it('isHeartbeatTimedOut is false when messages arrive', () => {
    client.connect();
    currentWs!._open();
    // Simulate a recent message
    currentWs!._message(JSON.stringify({ type: 'hq.snapshot', snapshot: {} }));
    expect(client.isHeartbeatTimedOut).toBe(false);
  });

  it('heartbeat stays silent when a message arrives within the window', () => {
    // Regression: a heartbeat that only reads connectionState.lastActivityAt
    // must be refreshed by every incoming frame. Without the
    // `markConnectionActivity` call in `onmessage`, the activity clock stays
    // pinned to `onopen` and any healthy connection trips the heartbeat
    // ~interval+timeout ms after onopen even under continuous traffic.
    client.connect();
    currentWs!._open();
    // Advance past the half-window, then deliver a message — the activity
    // clock must reset so the remaining window starts over from the message.
    vi.advanceTimersByTime(client.heartbeatIntervalMs);
    currentWs!._message(JSON.stringify({ type: 'hq.snapshot', snapshot: {} }));
    // Advance well past the timeout since the message: with the activity
    // refresh in place, only ~timeout has elapsed since the message so the
    // heartbeat is still false. Without the refresh, interval + timeout
    // would have elapsed since onopen and the heartbeat would be true.
    vi.advanceTimersByTime(client.heartbeatTimeoutMs + 1000);
    expect(client.isHeartbeatTimedOut).toBe(false);
  });

  it('detects silent dropout via heartbeat', () => {
    client.connect();
    currentWs!._open();
    // No messages received — advance past heartbeatInterval + timeout
    vi.advanceTimersByTime(client.heartbeatIntervalMs + client.heartbeatTimeoutMs + 100);
    expect(client.isHeartbeatTimedOut).toBe(true);
  });

  // ── Reconnection ──────────────────────────────────────────────────────

  it('reconnects on close', () => {
    client.connect();
    currentWs!._open();
    currentWs!._close(1006, 'network loss');
    expect(client.state).toBe('reconnecting');
  });

  it('ignores delayed close events from sockets replaced by reconnect', () => {
    client = new HqSocket({ url: 'ws://test/ws', heartbeatIntervalMs: 1, heartbeatTimeoutMs: 1 });
    client.connect();
    const staleWs = currentWs!;
    staleWs._open();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.spyOn(staleWs, 'close').mockImplementation((code?: number, reason?: string) => {
      staleWs.readyState = FakeWebSocket.CLOSED;
      void code;
      void reason;
    });

    vi.advanceTimersByTime(3);
    expect(client.state).toBe('reconnecting');
    vi.advanceTimersByTime(1000);
    const replacementWs = currentWs!;
    expect(replacementWs).not.toBe(staleWs);
    replacementWs._open();
    expect(client.state).toBe('connected');

    staleWs.onclose?.({ code: 4000, reason: 'heartbeat timeout', wasClean: false });

    expect(client.state).toBe('connected');
    expect(client.isConnected).toBe(true);
    expect(currentWs).toBe(replacementWs);
  });

  it('sends no client.resume frame on open when the default cursor is empty', () => {
    client.connect();
    currentWs!._open();

    expect(currentWs!.sent).toEqual([]);
  });

  it('sends no client.resume frame on open when there is no stored cursor', () => {
    client = new HqSocket({ url: 'ws://test/ws', resumeCursor: () => ({}) });
    client.connect();
    currentWs!._open();

    expect(currentWs!.sent).toEqual([]);
  });

  it('does not send client.resume frames without publisher clientIds', () => {
    client = new HqSocket({
      url: 'ws://test/ws',
      resumeCursor: () => 42 as unknown as Record<string, number>,
    });
    client.connect();
    currentWs!._open();

    expect(currentWs!.sent).toEqual([]);
  });

  it('sends one client.resume frame per stored publisher cursor on open', () => {
    client = new HqSocket({
      url: 'ws://test/ws',
      resumeCursor: () => ({ 'client-a': 42, 'client-b': 7 }),
    });
    client.connect();
    currentWs!._open();

    expect(currentWs!.sent.map((frame) => JSON.parse(frame))).toEqual([
      { type: 'client.resume', clientId: 'client-a', lastSeqSeen: 42 },
      { type: 'client.resume', clientId: 'client-b', lastSeqSeen: 7 },
    ]);
  });

  it('accepts map-like resume cursor providers without relying on instanceof Map', () => {
    client = new HqSocket({
      url: 'ws://test/ws',
      resumeCursor: () =>
        ({
          entries: function* () {
            yield ['client-a', 42];
          },
        }) as unknown as Record<string, number>,
    });
    client.connect();
    currentWs!._open();

    expect(currentWs!.sent.map((frame) => JSON.parse(frame))).toEqual([
      { type: 'client.resume', clientId: 'client-a', lastSeqSeen: 42 },
    ]);
  });

  it('caps client.resume frames to the most-recent publishers and skips empty clientIds', () => {
    const cursor: Record<string, number> = {};
    for (let i = 0; i < 40; i++) cursor[`publisher-${String(i).padStart(3, '0')}`] = i + 1;
    cursor[''] = 9999; // empty clientId should be dropped
    cursor['not-a-number'] = Number.NaN; // sanitized to 0
    client = new HqSocket({
      url: 'ws://test/ws',
      resumeCursor: () => cursor,
    });
    client.connect();
    currentWs!._open();

    const frames = currentWs!.sent.map((frame) => JSON.parse(frame));
    expect(frames).toHaveLength(32);
    expect(frames.every((f) => f.clientId.startsWith('publisher-'))).toBe(true);
    // Most-recent seq first; cursor seqs are 1..40 so first frame is seq 40.
    expect(frames[0]).toEqual({
      type: 'client.resume',
      clientId: 'publisher-039',
      lastSeqSeen: 40,
    });
    expect(frames.at(-1)?.type).toBe('client.resume');
  });

  it('preserves the synthetic peer resume cursor when client.resume frames are capped', () => {
    const cursor: Record<string, number> = { [HQ_BROWSER_PEER_RESUME_CLIENT_ID]: 1 };
    for (let i = 0; i < 40; i++) cursor[`publisher-${String(i).padStart(3, '0')}`] = i + 100;
    client = new HqSocket({
      url: 'ws://test/ws',
      resumeCursor: () => cursor,
    });
    client.connect();
    currentWs!._open();

    const frames = currentWs!.sent.map((frame) => JSON.parse(frame));
    expect(frames).toHaveLength(32);
    // The synthetic peer cursor must be the first frame even when the
    // publisher set is much larger than the cap. A regression that drops
    // the peer cursor into the truncated tail would still pass a weaker
    // assertion that only checks `frames[0]?.clientId !== peer`, so we
    // assert the full shape: exactly one peer frame at index 0, then 31
    // publisher frames, and the peer cursor never appears again.
    expect(frames[0]).toEqual({
      type: 'client.resume',
      clientId: HQ_BROWSER_PEER_RESUME_CLIENT_ID,
      lastSeqSeen: 1,
    });
    expect(frames.slice(1)).toHaveLength(31);
    expect(frames.slice(1).every((f) => f.clientId !== HQ_BROWSER_PEER_RESUME_CLIENT_ID)).toBe(
      true,
    );
    expect(frames.slice(1).every((f) => f.clientId.startsWith('publisher-'))).toBe(true);
    // Frame-budget gate: the peer frame MUST survive even when the
    // publisher set alone already exceeds MAX_RESUME_FRAMES (= 32). This
    // is the load-bearing contract — the cap must not silently evict the
    // synthetic peer cursor.
    const peerFrameCount = frames.filter(
      (f) => f.clientId === HQ_BROWSER_PEER_RESUME_CLIENT_ID,
    ).length;
    expect(peerFrameCount).toBe(1);
  });

  it('uses the latest resume cursor value on reconnect', () => {
    let seq = 1;
    client = new HqSocket({ url: 'ws://test/ws', resumeCursor: () => ({ 'client-a': seq }) });
    client.connect();
    currentWs!._open();
    expect(JSON.parse(currentWs!.sent[0]!)).toEqual({
      type: 'client.resume',
      clientId: 'client-a',
      lastSeqSeen: 1,
    });

    currentWs!._close(1006, 'network loss');
    seq = 9;
    vi.advanceTimersByTime(5000);
    currentWs!._open();

    expect(JSON.parse(currentWs!.sent[0]!)).toEqual({
      type: 'client.resume',
      clientId: 'client-a',
      lastSeqSeen: 9,
    });
  });

  it('clamps non-finite resume cursor values to 0 instead of sending malformed frames', () => {
    client = new HqSocket({
      url: 'ws://test/ws',
      resumeCursor: () => ({ good: 3.9, bad: Number.NaN, infinite: Number.POSITIVE_INFINITY }),
    });
    expect(() => {
      client.connect();
      currentWs!._open();
    }).not.toThrow();

    expect(currentWs!.sent.map((frame) => JSON.parse(frame))).toEqual([
      { type: 'client.resume', clientId: 'good', lastSeqSeen: 3 },
      { type: 'client.resume', clientId: 'bad', lastSeqSeen: 0 },
      { type: 'client.resume', clientId: 'infinite', lastSeqSeen: 0 },
    ]);
  });

  it('ignores resume cursor provider errors instead of throwing on open', () => {
    client = new HqSocket({
      url: 'ws://test/ws',
      resumeCursor: () => {
        throw new Error('cursor unavailable');
      },
    });

    expect(() => {
      client.connect();
      currentWs!._open();
    }).not.toThrow();
    expect(client.state).toBe('connected');
    expect(currentWs!.sent).toEqual([]);
  });

  it('still starts heartbeat when sending client.resume fails on open', () => {
    client = new HqSocket({ url: 'ws://test/ws', resumeCursor: () => ({ 'client-a': 1 }) });
    client.connect();
    vi.spyOn(currentWs!, 'send').mockImplementation(() => {
      throw new Error('socket closed during send');
    });
    const closeSpy = vi.spyOn(currentWs!, 'close');

    expect(() => currentWs!._open()).not.toThrow();
    expect(client.state).toBe('connected');

    vi.advanceTimersByTime(50500);
    expect(closeSpy).toHaveBeenCalledWith(4000, 'heartbeat timeout');
    expect(client.state).toBe('reconnecting');
  });

  it('stops reconnecting after maxRetries', () => {
    client = new HqSocket({ url: 'ws://test/ws', maxRetries: 1 });
    client.connect();
    currentWs!._open();

    // First close → reconnect attempt 1
    currentWs!._close(); // state → 'reconnecting', timer set
    vi.advanceTimersByTime(5000); // timer fires → connect() → new ws
    expect(client.state).toBe('connecting'); // first reconnect attempt in progress

    // That attempt fails too
    currentWs!._close(); // state → 'reconnecting' → scheduleReconnect → maxRetries hit → 'disconnected'
    expect(client.state).toBe('disconnected');
  });

  it('uses Infinity maxRetries by default', () => {
    expect(client.maxRetries).toBe(Infinity);
  });

  // ── State handlers ────────────────────────────────────────────────────

  it('calls onStateChange handlers on state transitions', () => {
    const states: HqSocketState[] = [];
    client.onStateChange((s) => states.push(s));

    client.connect();
    currentWs!._open();
    currentWs!._close();

    expect(states).toContain('connecting');
    expect(states).toContain('connected');
    expect(states).toContain('reconnecting');
  });

  it('onStateChange immediately emits current state on subscribe', () => {
    const states: HqSocketState[] = [];
    client.onStateChange((s) => states.push(s));
    expect(states).toEqual(['disconnected']);
  });

  // ── Message handling ──────────────────────────────────────────────────

  it('dispatches messages to registered handlers', () => {
    const handler = vi.fn();
    client.on(handler);
    client.connect();
    currentWs!._open();
    currentWs!._message(JSON.stringify({ type: 'hq.snapshot', snapshot: {} }));
    expect(handler).toHaveBeenCalledWith({ type: 'hq.snapshot', snapshot: {} });
  });

  it('unsubscribes handler via returned function', () => {
    const handler = vi.fn();
    const unsub = client.on(handler);
    unsub();
    client.connect();
    currentWs!._open();
    currentWs!._message(JSON.stringify({ type: 'hq.snapshot', snapshot: {} }));
    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores malformed JSON messages', () => {
    const handler = vi.fn();
    client.on(handler);
    client.connect();
    currentWs!._open();
    currentWs!._message('not json');
    expect(handler).not.toHaveBeenCalled();
  });

  // ── Constructor URL resolution (no explicit url) ───────────────────────

  it('builds URL from window.location when no url option is given', () => {
    const noUrlClient = new HqSocket();
    expect(noUrlClient.state).toBe('disconnected');
    // The URL should contain /ws/browser
    expect((noUrlClient as unknown as { url: string }).url).toContain('/ws/browser');
    noUrlClient.close();
  });

  it('builds URL without token when resolveHqToken returns null', () => {
    // In node mode (no window), resolveHqToken returns null.
    const noUrlClient = new HqSocket();
    const url = (noUrlClient as unknown as { url: string }).url;
    // The URL should use the ws:// protocol and /ws/browser path
    expect(url).toMatch(/^ws:\/\/[^/]+\/ws\/browser$/);
    expect(url).not.toContain('?token=');
    noUrlClient.close();
  });

  it('attaches ?token= to the WS URL on a loopback origin with a stored token', () => {
    vi.stubGlobal('window', {
      location: {
        host: '127.0.0.1:3599',
        protocol: 'http:',
        hostname: '127.0.0.1',
        search: '',
      },
      localStorage: {
        getItem: (key: string) => (key === 'wrongstack.hq.token.v1' ? 'ws-loopback-token' : null),
        setItem: () => {},
        removeItem: () => {},
        clear: () => {},
        key: () => null,
        get length() {
          return 0;
        },
      },
    });
    try {
      const noUrlClient = new HqSocket();
      const url = (noUrlClient as unknown as { url: string }).url;
      expect(url).toBe('ws://127.0.0.1:3599/ws/browser?token=ws-loopback-token');
      noUrlClient.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps ?token= out of the WS URL on a non-loopback origin even with a stored token', () => {
    // The server refuses browser query-string tokens off-loopback (WS-009),
    // so carrying one would only leak it into the upgrade request line.
    vi.stubGlobal('window', {
      location: {
        host: 'hq.example.com:3599',
        protocol: 'http:',
        hostname: 'hq.example.com',
        search: '',
      },
      localStorage: {
        getItem: (key: string) => (key === 'wrongstack.hq.token.v1' ? 'ws-remote-token' : null),
        setItem: () => {},
        removeItem: () => {},
        clear: () => {},
        key: () => null,
        get length() {
          return 0;
        },
      },
    });
    try {
      const noUrlClient = new HqSocket();
      const url = (noUrlClient as unknown as { url: string }).url;
      expect(url).toBe('ws://hq.example.com:3599/ws/browser');
      expect(url).not.toContain('?token=');
      noUrlClient.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('isHeartbeatTimedOut returns true when ws is null', () => {
    // Before connect(), ws is null → isHeartbeatTimedOut should be true.
    expect(client.isHeartbeatTimedOut).toBe(true);
  });

  // ── Heartbeat timeout fires close + reconnect ─────────────────────────

  it('heartbeat timeout calls ws.close(4000) and schedules reconnect', () => {
    client.connect();
    currentWs!._open();
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // deterministic jitter
    const closeSpy = vi.spyOn(currentWs!, 'close');

    // Advance to 50500ms → this fires the interval at 50s (the second tick),
    // which calls close(4000) because isHeartbeatTimedOut is now true.
    // The reconnect timer (~750ms) is scheduled but hasn't fired yet.
    vi.advanceTimersByTime(50500);
    expect(closeSpy).toHaveBeenCalledWith(4000, 'heartbeat timeout');
    // After close, state should be reconnecting (before reconnect timer fires).
    expect(client.state).toBe('reconnecting');
  });

  // ── WebSocket constructor throws ─────────────────────────────────────

  it('calls scheduleReconnect when WebSocket constructor throws', () => {
    const throwingCtor = vi.fn(() => {
      throw new Error('ws fail');
    });
    vi.stubGlobal('WebSocket', throwingCtor);
    client.connect();
    // It should transition to 'reconnecting' (via scheduleReconnect)
    // without crashing.
    expect(client.state).toBe('reconnecting');
  });

  // ── Singleton ─────────────────────────────────────────────────────────

  it('getHqSocket returns the same instance on repeat calls', () => {
    const a = getHqSocket();
    const b = getHqSocket();
    expect(a).toBe(b);
    a.close();
  });

  it('closeHqSocket tears down the cached singleton so the next call builds a fresh one', () => {
    const a = getHqSocket();
    closeHqSocket();
    expect(a.state).toBe('disconnected');
    const b = getHqSocket();
    expect(b).not.toBe(a);
    b.close();
  });

  it('closeHqSocket is idempotent', () => {
    const a = getHqSocket();
    closeHqSocket();
    expect(() => closeHqSocket()).not.toThrow();
    expect(() => closeHqSocket()).not.toThrow();
    const b = getHqSocket();
    expect(b).not.toBe(a);
    b.close();
  });

  it('conflicting construction options on a live singleton warn instead of being silently dropped', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const first = getHqSocket({ url: 'ws://test-a/ws' });
      // Second call with a different URL — must NOT mutate the live
      // singleton's URL (the original bug), and must log a warning.
      const second = getHqSocket({ url: 'ws://test-b/ws' });
      expect(second).toBe(first);
      expect(first.url).toBe('ws://test-a/ws');
      expect(warnSpy).toHaveBeenCalled();
      const warning = warnSpy.mock.calls[0]?.[0] as string;
      expect(warning).toMatch(/url:/);
      first.close();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('matching construction options on a live singleton do not warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const first = getHqSocket({
        url: 'ws://test-c/ws',
        heartbeatIntervalMs: 1234,
        heartbeatTimeoutMs: 4321,
        maxBackoffMs: 9999,
        maxRetries: 7,
      });
      const second = getHqSocket({
        url: 'ws://test-c/ws',
        heartbeatIntervalMs: 1234,
        heartbeatTimeoutMs: 4321,
        maxBackoffMs: 9999,
        maxRetries: 7,
      });
      expect(second).toBe(first);
      expect(warnSpy).not.toHaveBeenCalled();
      first.close();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('accepts a Map-backed resume cursor (cross-realm safe)', () => {
    // Resetting the singleton so the live state for this test is independent
    // from earlier tests.
    closeHqSocket();
    const cursorMap: Map<string, number> = new Map([
      ['client-alpha', 3],
      ['client-beta', 5],
    ]);
    const localClient = new HqSocket({
      url: 'ws://test-map/ws',
      resumeCursor: () => cursorMap,
    });
    localClient.connect();
    currentWs!._open();
    // Resume frames are sorted by `lastSeqSeen desc` then `clientId asc`,
    // so a Map iteration order does not leak — the wire format is canonical.
    const frames = currentWs!.sent.map((frame) => JSON.parse(frame));
    expect(frames).toEqual([
      { type: 'client.resume', clientId: 'client-beta', lastSeqSeen: 5 },
      { type: 'client.resume', clientId: 'client-alpha', lastSeqSeen: 3 },
    ]);
    localClient.close();
  });
});
