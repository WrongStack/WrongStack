/**
 * WS-029 — the WebSocket message rate limit, and why it can now be on.
 *
 * The limiter existed and shipped DISABLED. Its call site recorded the reason:
 * it "counted pings/list calls too" and "was tripping during normal use". A
 * limiter that is off is not a limiter, but raising the number would have left
 * the miscounting in place and only moved the same bug further out.
 *
 * So the counting is what changed: keepalives are exempt, and the charge
 * happens AFTER decode — except for undecodable frames, which are charged
 * precisely because a flood of garbage is the abuse case and never reaches a
 * type check. Only then is a default safe to enable.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import {
  createConnectionLifecycle,
  RATE_LIMIT_EXEMPT_TYPES,
} from '../src/server/connection-lifecycle.js';

class TestSocket {
  readonly listeners = new Map<string, (...args: unknown[]) => unknown>();
  on(event: string, listener: (...args: never[]) => unknown): this {
    this.listeners.set(event, listener as (...args: unknown[]) => unknown);
    return this;
  }
  async emit(event: string, value?: unknown): Promise<void> {
    await this.listeners.get(event)?.(value);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

interface Harness {
  socket: TestSocket;
  send: ReturnType<typeof vi.fn>;
  dispatch: ReturnType<typeof vi.fn>;
  ready: Promise<void>;
}

/** A lifecycle whose decoder maps a raw frame to `{type}`, or fails on ''. */
function makeHarness(rateLimitMax: number): Harness {
  const socket = new TestSocket();
  const send = vi.fn();
  const dispatch = vi.fn(async () => undefined);
  const lifecycle = createConnectionLifecycle({
    clients: new Map<WebSocket, { id: string }>(),
    pendingConfirms: new Map(),
    createClient: (_ws, id) => ({ id }),
    registerClient: vi.fn(),
    decode: (raw: string) =>
      raw === 'GARBAGE'
        ? { ok: false as const, issue: { code: 'invalid_envelope', message: 'nope' } }
        : { ok: true as const, message: { type: raw } },
    dispatch,
    send,
    sessionPayload: (payload) => payload,
    buildInitialPayload: async () => ({ sessionId: 's1' }),
    rateLimitMax,
  });
  return { socket, send, dispatch, ready: lifecycle(socket as never, undefined) };
}

const rateLimitErrors = (send: ReturnType<typeof vi.fn>): unknown[] =>
  send.mock.calls.filter(
    (call) => (call[1] as { payload?: { phase?: string } })?.payload?.phase === 'rate_limit',
  );

describe('WebSocket rate limiting (WS-029)', () => {
  it('exempts keepalives — the reason the limiter shipped disabled', async () => {
    const h = makeHarness(3);
    await h.ready;
    // Ten pings against a budget of three. The browser sends these on a timer
    // regardless of what the user is doing, so an idle tab used to exhaust the
    // budget on its own.
    for (let i = 0; i < 10; i++) await h.socket.emit('message', Buffer.from('ping'));
    expect(rateLimitErrors(h.send)).toHaveLength(0);
    expect(h.dispatch).toHaveBeenCalledTimes(10);
  });

  it('charges real messages and refuses past the budget', async () => {
    const h = makeHarness(3);
    await h.ready;
    for (let i = 0; i < 5; i++) await h.socket.emit('message', Buffer.from('session.send'));
    expect(h.dispatch).toHaveBeenCalledTimes(3);
    expect(rateLimitErrors(h.send).length).toBeGreaterThan(0);
  });

  it('charges undecodable frames — a garbage flood never reaches a type check', async () => {
    const h = makeHarness(3);
    await h.ready;
    for (let i = 0; i < 5; i++) await h.socket.emit('message', Buffer.from('GARBAGE'));
    expect(rateLimitErrors(h.send).length).toBeGreaterThan(0);
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('a keepalive flood does not consume the budget a real message needs', async () => {
    // The precise failure the old counting produced: pings starved genuine
    // traffic, so the user's next action was refused.
    const h = makeHarness(3);
    await h.ready;
    for (let i = 0; i < 50; i++) await h.socket.emit('message', Buffer.from('ping'));
    await h.socket.emit('message', Buffer.from('session.send'));
    expect(rateLimitErrors(h.send)).toHaveLength(0);
    expect(h.dispatch).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), {
      type: 'session.send',
    });
  });

  it('stays fully open when the limit is 0 — the documented opt-out', async () => {
    const h = makeHarness(0);
    await h.ready;
    for (let i = 0; i < 100; i++) await h.socket.emit('message', Buffer.from('session.send'));
    expect(rateLimitErrors(h.send)).toHaveLength(0);
    expect(h.dispatch).toHaveBeenCalledTimes(100);
  });

  it('exempts only genuinely automatic traffic', () => {
    // A caller must not be able to make the server do work for free. If a type
    // is added here, it has to be one that costs nothing to serve.
    expect([...RATE_LIMIT_EXEMPT_TYPES].sort()).toEqual(['ping', 'pong']);
  });
});
