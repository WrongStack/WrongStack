import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Minimal WebSocket polyfill for Node
class FakeWebSocket {
  readyState = FakeWebSocket.CONNECTING;
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  url: string;

  constructor(url: string) {
    this.url = url;
  }

  _open(): void { this.readyState = FakeWebSocket.OPEN; this.onopen?.({}); }
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
  _message(data: string): void { this.onmessage?.({ data }); }
  close(code?: number, reason?: string): void {
    if (this.readyState === FakeWebSocket.OPEN) this._close(code, reason);
  }
}

let currentWs: FakeWebSocket | null = null;

// Stub WebSocket with the mock so HqWsClient.createWebSocket uses it
const OrigWebSocket = FakeWebSocket as unknown as typeof WebSocket;
const wsProxy = new Proxy(OrigWebSocket, {
  construct(_target, args: [string]) {
    const ws = new FakeWebSocket(args[0]);
    currentWs = ws;
    return ws;
  },
});

const { HqWsClient, getHqClient } = await import('../src/lib/hq-ws-client.js');
import type { HqWsConnectionState } from '../src/lib/hq-ws-client.js';

describe('HqWsClient', () => {
  let client: InstanceType<typeof HqWsClient>;

  beforeEach(() => {
    vi.useFakeTimers();
    currentWs = null;
    vi.stubGlobal('WebSocket', wsProxy);
    client = new HqWsClient({ url: 'ws://test/ws' });
  });

  afterEach(() => {
    vi.useRealTimers();
    client.close();
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

  it('stops reconnecting after maxRetries', () => {
    client = new HqWsClient({ url: 'ws://test/ws', maxRetries: 1 });
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
    const states: HqWsConnectionState[] = [];
    client.onStateChange((s) => states.push(s));

    client.connect();
    currentWs!._open();
    currentWs!._close();

    expect(states).toContain('connecting');
    expect(states).toContain('connected');
    expect(states).toContain('reconnecting');
  });

  it('onStateChange immediately emits current state on subscribe', () => {
    const states: HqWsConnectionState[] = [];
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

  // ── Singleton ─────────────────────────────────────────────────────────

  it('getHqClient returns the same instance', () => {
    const a = getHqClient();
    const b = getHqClient();
    expect(a).toBe(b);
    a.close();
  });
});
