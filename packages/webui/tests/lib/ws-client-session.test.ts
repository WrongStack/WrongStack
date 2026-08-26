import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { streamCoalescer } from '../../src/lib/stream-coalescer';
import { WrongStackWebSocketClient } from '../../src/lib/ws-client';

describe('WrongStackWebSocketClient session transitions', () => {
  beforeEach(() => {
    streamCoalescer.dropAll();
  });

  // Opening or switching a tab is NOT a discard: the buffered tokens belong to
  // the session being left, which stays open and will be clicked back into.
  // Dropping them truncated a streaming reply mid-sentence. They are flushed
  // into that session instead, before handleSessionStart snapshots it.
  it('flushes pending streams into the outgoing session when opening a new one', () => {
    const flush = vi.fn();
    const client = new WrongStackWebSocketClient('ws://127.0.0.1:3457');
    streamCoalescer.push('__thinking__', 'stale thinking', flush);

    client.newSession();

    expect(flush).toHaveBeenCalledWith('__thinking__', 'stale thinking');
    // Nothing is left buffered for the incoming tab to inherit.
    flush.mockClear();
    streamCoalescer.flushAll();
    expect(flush).not.toHaveBeenCalled();
  });

  it('flushes pending streams into the outgoing session when resuming another', () => {
    const flush = vi.fn();
    const client = new WrongStackWebSocketClient('ws://127.0.0.1:3457');
    streamCoalescer.push('assistant_1', 'stale assistant text', flush);

    client.resumeSessionById('sess_1');

    expect(flush).toHaveBeenCalledWith('assistant_1', 'stale assistant text');
    flush.mockClear();
    streamCoalescer.flushAll();
    expect(flush).not.toHaveBeenCalled();
  });

  it('sends session.new when requesting a new session', () => {
    const client = new WrongStackWebSocketClient('ws://127.0.0.1:3457');
    const sendSpy = vi.spyOn(client, 'send');

    client.newSession();

    expect(sendSpy).toHaveBeenCalledWith({ type: 'session.new', payload: {} });
  });

  it('drops pending streams for direct context clear messages', () => {
    const flush = vi.fn();
    const client = new WrongStackWebSocketClient('ws://127.0.0.1:3457');
    streamCoalescer.push('__thinking__', 'stale thinking', flush);

    client.send({ type: 'context.clear' });
    streamCoalescer.flushAll();

    expect(flush).not.toHaveBeenCalled();
  });
});

describe('WrongStackWebSocketClient auth bootstrap', () => {
  const originalLocation = window.location;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    Object.defineProperty(window, 'location', {
      value: {
        hostname: 'wrongstack.example.com',
        port: '',
        protocol: 'https:',
        search: '?token=abc123',
        href: 'https://wrongstack.example.com?token=abc123',
      },
      writable: true,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true }) as Response),
    );
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
    });
    vi.stubGlobal('fetch', originalFetch);
    vi.restoreAllMocks();
  });

  it('strips the WS URL token when the auth cookie applies to the WS host', async () => {
    const client = new WrongStackWebSocketClient(
      'wss://wrongstack.example.com/socket?token=abc123&x=1',
    );

    await client.ensureAuthCookie();

    expect((client as unknown as { url: string }).url).toBe(
      'wss://wrongstack.example.com/socket?x=1',
    );
  });

  it('keeps the WS URL token when public WS uses a different hostname', async () => {
    const client = new WrongStackWebSocketClient(
      'wss://wrongstack-ws.example.com/socket?token=abc123',
    );

    await client.ensureAuthCookie();

    expect((client as unknown as { url: string }).url).toBe(
      'wss://wrongstack-ws.example.com/socket?token=abc123',
    );
  });
});
