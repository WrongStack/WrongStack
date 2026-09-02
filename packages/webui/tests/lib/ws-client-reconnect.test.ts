import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Fake WebSocket ────────────────────────────────────────────────────────
// A controllable stub. The WebSocket class also needs the static state
// constants (OPEN/CONNECTING/CLOSING/CLOSED) because the SUT references
// `WebSocket.OPEN` directly in connect(). The test drives transitions by
// invoking the installed onopen/onclose/onerror handlers.

interface FakeWS {
  url: string;
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((err: unknown) => void) | null;
  close: (code?: number, reason?: string) => void;
  send: (data: string) => void;
  binaryType: string;
}

const FakeWSModule = vi.hoisted(() => {
  const instances: FakeWS[] = [];
  const klass = class FakeWS {
    url: string;
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onclose: ((ev: { code: number; reason: string }) => void) | null = null;
    onerror: ((err: unknown) => void) | null = null;
    binaryType = 'arraybuffer';
    close: (code?: number, reason?: string) => void = () => {};
    send: (data: string) => void = () => {};
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url: string) {
      this.url = url;
      this.close = (_code?: number, _reason?: string) => {
        this.readyState = 3;
      };
      this.send = (_data: string) => {
        /* no-op */
      };
      instances.push(this);
    }
  };
  return { instances, klass };
});

vi.stubGlobal('WebSocket', FakeWSModule.klass);

// ensureAuthCookie() in connect() calls fetch; stub it so it resolves
// immediately without touching the network.
vi.stubGlobal(
  'fetch',
  vi.fn(() => Promise.resolve({ ok: true, status: 200 } as unknown as Response)),
);

// ── SUT (imported after stubs are registered) ─────────────────────────────
import { WrongStackWebSocketClient } from '../../src/lib/ws-client';

function instances(): FakeWS[] {
  return FakeWSModule.instances;
}
function last(): FakeWS | null {
  const all = instances();
  return all.length > 0 ? ((all[all.length - 1] as FakeWS) ?? null) : null;
}

beforeEach(() => {
  FakeWSModule.instances.length = 0;
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('WrongStackWebSocketClient — reconnection state machine', () => {
  it('emits connecting → open on a successful connect', async () => {
    const client = new WrongStackWebSocketClient('ws://127.0.0.1:65535');
    const statuses: Array<{ state: string }> = [];
    client.onStatus((s) => statuses.push({ state: s.state }));

    const p = client.connect();
    // Let ensureAuthCookie (fetch microtask) resolve + the WS constructor run.
    await new Promise((r) => setTimeout(r, 20));
    const ws = last();
    expect(ws).not.toBeNull();
    ws!.readyState = 1;
    ws!.onopen!();
    await p;

    const states = statuses.map((s) => s.state);
    expect(states).toContain('connecting');
    expect(states[states.length - 1]).toBe('open');
  });

  it('transitions to reconnecting {attempt:1} after an established connection drops', async () => {
    const client = new WrongStackWebSocketClient('ws://127.0.0.1:65535');
    const statuses: Array<{ state: string; attempt?: number }> = [];
    client.onStatus((s) => {
      if (s.state === 'reconnecting') {
        statuses.push({ state: s.state, attempt: s.attempt });
      } else {
        statuses.push({ state: s.state });
      }
    });

    // First, connect successfully.
    const p = client.connect();
    await new Promise((r) => setTimeout(r, 20));
    const ws = last()!;
    ws.readyState = 1;
    ws.onopen!();
    await p;

    // Drop the connection with a non-1000 code (abnormal).
    ws.readyState = 3;
    ws.onclose!({ code: 1011, reason: 'server restart' });

    // Status should now be 'reconnecting' with attempt 1.
    const reconnecting = statuses.filter((s) => s.state === 'reconnecting');
    expect(reconnecting.length).toBeGreaterThan(0);
    expect(reconnecting[0]!.attempt).toBe(1);

    // Stop the pending reconnect timer so the test doesn't leak.
    client['shouldReconnect'] = false;
    if (client['reconnectTimer']) clearTimeout(client['reconnectTimer']);
  });

  it('stops emitting reconnecting and emits closed when shouldReconnect is false', async () => {
    // Directly exercises the "give up" branch of attemptReconnect: when
    // shouldReconnect is false (e.g. explicit disconnect), a dropped
    // connection must land in 'closed' with an error string rather than
    // looping through 'reconnecting'.
    const client = new WrongStackWebSocketClient('ws://127.0.0.1:65535');
    client['shouldReconnect'] = false;

    const statuses: Array<{ state: string; error?: string }> = [];
    client.onStatus((s) => {
      if (s.state === 'closed') statuses.push({ state: s.state, error: s.error });
      else statuses.push({ state: s.state });
    });

    // Establish first (shouldReconnect is only consulted on drop).
    const p = client.connect();
    await new Promise((r) => setTimeout(r, 20));
    const ws = last()!;
    ws.readyState = 1;
    ws.onopen!();
    await p;

    // Drop — since shouldReconnect is false, attemptReconnect emits closed.
    ws.readyState = 3;
    ws.onclose!({ code: 1011, reason: 'shutdown' });

    const closed = statuses.filter((s) => s.state === 'closed');
    expect(closed.length).toBeGreaterThan(0);
    const lastClosed = closed[closed.length - 1];
    expect(lastClosed?.error).toBeTruthy();
  });

  it('retryNow resets the attempt counter and immediately connects', async () => {
    const client = new WrongStackWebSocketClient('ws://127.0.0.1:65535');
    let lastState = '';
    client.onStatus((s) => {
      lastState = s.state;
    });

    // Establish, then drop to enter reconnecting.
    const p = client.connect();
    await new Promise((r) => setTimeout(r, 20));
    const ws = last()!;
    ws.readyState = 1;
    ws.onopen!();
    await p;

    ws.readyState = 3;
    ws.onclose!({ code: 1011, reason: 'drop' });
    expect(lastState).toBe('reconnecting');

    // retryNow should immediately attempt a fresh connect.
    client.retryNow();
    await new Promise((r) => setTimeout(r, 20));
    const fresh = last()!;
    expect(fresh).not.toBe(ws);
    fresh.readyState = 1;
    fresh.onopen!();
    await new Promise((r) => setTimeout(r, 10));

    expect(lastState).toBe('open');
  });
});
