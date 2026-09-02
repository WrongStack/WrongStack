import { beforeEach, describe, expect, it } from 'vitest';
import { WrongStackWebSocketClient } from '../../src/lib/ws-client';

/**
 * Regression tests for the offline-message queue cap (H4 in synthesis).
 *
 * Pre-fix: messageQueue was unbounded. Long disconnects (e.g. network
 * outage + browser tab left open) let the queue grow without limit;
 * on reconnect, every stale message re-fired on the server. The cap +
 * FIFO drop bounds memory and ensures the most recent user intent is
 * preserved.
 *
 * Strategy: use the real WrongStackWebSocketClient but never call
 * connect() — that way every send() falls into the queue branch
 * (`ws?.readyState === WebSocket.OPEN` is false on a fresh instance).
 */
describe('WrongStackWebSocketClient — offline queue cap (H4)', () => {
  beforeEach(() => {
    // Reset the singleton between tests — getWSClient() caches one
    // instance, and we want a fresh queue for each assertion.
    // Note: tests below construct their own client directly, so this
    // is mostly defensive in case other test files leak state.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (WrongStackWebSocketClient as any).__test_queue_isolation;
  });

  it('queues messages when the socket is not open', () => {
    const client = new WrongStackWebSocketClient('ws://127.0.0.1:3457');
    // No connect() — ws is null, so every send() goes to the queue.
    client.send({ type: 'ping' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any).messageQueue).toHaveLength(1);
  });

  it('drops the oldest message when the cap is exceeded (FIFO)', () => {
    const client = new WrongStackWebSocketClient('ws://127.0.0.1:3457');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cap = (WrongStackWebSocketClient as any).MAX_QUEUED_MESSAGES as number;

    // Push cap+5 messages: only the LAST cap should survive (the oldest
    // 5 should have been FIFO-dropped).
    const total = cap + 5;
    for (let i = 0; i < total; i++) {
      client.send({
        type: 'prefs.update',
        payload: { index: i },
      });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const queue = (client as any).messageQueue as Array<{
      type: string;
      payload: { index: number };
    }>;
    expect(queue).toHaveLength(cap);
    // The oldest 5 (indices 0..4) should be gone.
    expect(queue[0]?.payload.index).toBe(5);
    expect(queue[cap - 1]?.payload.index).toBe(total - 1);
  });

  it('logs a structured warning when the queue is full and a drop happens', () => {
    // Suppress the actual console.warn so the test output stays clean.
    const originalWarn = console.warn;
    const warnings: unknown[] = [];
    console.warn = (msg: unknown) => {
      warnings.push(typeof msg === 'string' ? JSON.parse(msg) : msg);
    };

    try {
      const client = new WrongStackWebSocketClient('ws://127.0.0.1:3457');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cap = (WrongStackWebSocketClient as any).MAX_QUEUED_MESSAGES as number;

      // Fill the queue, then push ONE more — that's the drop event.
      for (let i = 0; i < cap; i++) {
        client.send({ type: 'prefs.update', payload: { index: i } });
      }
      expect(warnings).toHaveLength(0); // no drops yet
      client.send({ type: 'prefs.update', payload: { index: cap } });
      expect(warnings).toHaveLength(1);
      const w = warnings[0] as {
        level: string;
        event: string;
        cap: number;
        droppedType: string;
      };
      expect(w.level).toBe('warn');
      expect(w.event).toBe('ws_client.message_queue_full');
      expect(w.cap).toBe(cap);
      expect(w.droppedType).toBe('prefs.update');
    } finally {
      console.warn = originalWarn;
    }
  });

  it('preserves the most recent message when the queue overflows', () => {
    const client = new WrongStackWebSocketClient('ws://127.0.0.1:3457');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cap = (WrongStackWebSocketClient as any).MAX_QUEUED_MESSAGES as number;
    // Total = cap + 100. Last 100 should be the survivors.
    for (let i = 0; i < cap + 100; i++) {
      client.send({ type: 'prefs.update', payload: { index: i } });
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const queue = (client as any).messageQueue as Array<{ payload: { index: number } }>;
    expect(queue).toHaveLength(cap);
    // The very last queued message must be the most recent intent.
    expect(queue[queue.length - 1]?.payload.index).toBe(cap + 100 - 1);
  });

  it('also bounds retained serialized payload size', () => {
    const ctor = WrongStackWebSocketClient as unknown as { MAX_QUEUED_CHARS: number };
    const originalCap = ctor.MAX_QUEUED_CHARS;
    const warn = console.warn;
    console.warn = () => {};
    ctor.MAX_QUEUED_CHARS = 256;
    try {
      const client = new WrongStackWebSocketClient('ws://127.0.0.1:3457');
      client.send({ type: 'prefs.update', payload: { index: 1, blob: 'x'.repeat(140) } });
      client.send({ type: 'prefs.update', payload: { index: 2, blob: 'y'.repeat(140) } });
      const queue = (client as unknown as { messageQueue: Array<{ payload: { index: number } }> })
        .messageQueue;
      expect(queue).toHaveLength(1);
      expect(queue[0]?.payload.index).toBe(2);
      expect(
        (client as unknown as { messageQueueChars: number }).messageQueueChars,
      ).toBeLessThanOrEqual(ctor.MAX_QUEUED_CHARS);
    } finally {
      ctor.MAX_QUEUED_CHARS = originalCap;
      console.warn = warn;
    }
  });

  it('rejects one offline message larger than the byte budget', () => {
    const ctor = WrongStackWebSocketClient as unknown as { MAX_QUEUED_CHARS: number };
    const originalCap = ctor.MAX_QUEUED_CHARS;
    const warn = console.warn;
    console.warn = () => {};
    ctor.MAX_QUEUED_CHARS = 128;
    try {
      const client = new WrongStackWebSocketClient('ws://127.0.0.1:3457');
      expect(client.send({ type: 'prefs.update', payload: { blob: 'x'.repeat(256) } })).toBe(false);
      expect((client as unknown as { messageQueue: unknown[] }).messageQueue).toHaveLength(0);
    } finally {
      ctor.MAX_QUEUED_CHARS = originalCap;
      console.warn = warn;
    }
  });

  it('clears the queue when disconnect() is called', () => {
    const client = new WrongStackWebSocketClient('ws://127.0.0.1:3457');
    client.send({ type: 'ping' });
    client.send({ type: 'ping' });
    client.send({ type: 'ping' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any).messageQueue).toHaveLength(3);

    client.disconnect();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any).messageQueue).toHaveLength(0);
    // Reconnect is also disabled — disconnect is final.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any).shouldReconnect).toBe(false);
  });
});
