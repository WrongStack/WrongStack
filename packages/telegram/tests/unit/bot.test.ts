import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TelegramIncomingMessage } from '../../src/bot.js';
import { escapeHtml, TelegramBot, truncateForTelegram } from '../../src/bot.js';
import { PollLock } from '../../src/poll-lock.js';

const log: Logger = {
  level: 'debug',
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  child() {
    return this;
  },
};

function makeBot(overrides?: {
  onMessage?: (msg: TelegramIncomingMessage) => void;
  allowedUsers?: string[];
  allowedChats?: string[];
}) {
  return new TelegramBot({
    token: 'test:token',
    pollIntervalSec: 60, // don't actually poll during tests
    allowedUsers: new Set(overrides?.allowedUsers ?? []),
    allowedChats: new Set(overrides?.allowedChats ?? []),
    bufferSize: 10,
    log,
    onMessage: overrides?.onMessage ?? vi.fn(),
  });
}

// ---------------------------------------------------------------------------
// Buffer
// ---------------------------------------------------------------------------

describe('TelegramBot buffer', () => {
  let received: TelegramIncomingMessage[] = [];

  beforeEach(() => {
    received = [];
  });

  function pushMsg(bot: TelegramBot, msg: Partial<TelegramIncomingMessage>) {
    // Use internal push — we simulate what polling would do via processMessage.
    const buf = (bot as never as { buffer: TelegramIncomingMessage[] }).buffer;
    buf.push({
      messageId: msg.messageId ?? 1,
      chatId: msg.chatId ?? 123,
      chatType: msg.chatType ?? 'private',
      userId: msg.userId,
      userName: msg.userName,
      text: msg.text ?? 'hello',
      timestamp: msg.timestamp ?? Date.now(),
    });
    // Respect buffer max (mirrors processMessage logic)
    while (buf.length > 10) buf.shift();
  }

  it('getMessages returns messages newest first', () => {
    const bot = makeBot({ onMessage: (m) => received.push(m) });
    pushMsg(bot, { messageId: 1, text: 'first' });
    pushMsg(bot, { messageId: 2, text: 'second' });
    pushMsg(bot, { messageId: 3, text: 'third' });

    const msgs = bot.getMessages();
    expect(msgs).toHaveLength(3);
    expect(msgs[0]!.text).toBe('third');
    expect(msgs[1]!.text).toBe('second');
    expect(msgs[2]!.text).toBe('first');
  });

  it('getMessages filters by chatId', () => {
    const bot = makeBot({ onMessage: (m) => received.push(m) });
    pushMsg(bot, { messageId: 1, text: 'a', chatId: 111 });
    pushMsg(bot, { messageId: 2, text: 'b', chatId: 222 });
    pushMsg(bot, { messageId: 3, text: 'c', chatId: 111 });

    const msgs = bot.getMessages({ chatId: 111 });
    expect(msgs).toHaveLength(2);
    expect(msgs.every((m) => m.chatId === 111)).toBe(true);
  });

  it('getMessages respects limit', () => {
    const bot = makeBot({ onMessage: (m) => received.push(m) });
    for (let i = 1; i <= 20; i++) pushMsg(bot, { messageId: i, text: `msg${i}` });

    expect(bot.getMessages({ limit: 5 })).toHaveLength(5);
  });

  it('acknowledge removes processed messages', () => {
    const bot = makeBot({ onMessage: (m) => received.push(m) });
    pushMsg(bot, { messageId: 10, text: 'old' });
    pushMsg(bot, { messageId: 20, text: 'new' });
    pushMsg(bot, { messageId: 30, text: 'newest' });

    expect(bot.bufferCount).toBe(3);
    const acked = bot.acknowledge(20);
    expect(acked).toBe(2);
    expect(bot.bufferCount).toBe(1);
    expect(bot.getMessages()[0]!.text).toBe('newest');
  });

  it('buffer respects max size (circular)', () => {
    const bot = makeBot({ onMessage: (m) => received.push(m) });
    for (let i = 1; i <= 15; i++) pushMsg(bot, { messageId: i, text: `msg${i}` });

    expect(bot.bufferCount).toBe(10);
    const msgs = bot.getMessages();
    expect(msgs[0]!.text).toBe('msg15');
    expect(msgs[9]!.text).toBe('msg6');
  });

  it('acknowledge returns 0 when no messages match', () => {
    const bot = makeBot({ onMessage: (m) => received.push(m) });
    pushMsg(bot, { messageId: 100, text: 'recent' });

    const acked = bot.acknowledge(50); // 50 < 100, nothing matches
    expect(acked).toBe(0);
    expect(bot.bufferCount).toBe(1);
  });

  it('scoped acknowledge only clears matching chat and preserves other chats', () => {
    const bot = makeBot({ onMessage: (m) => received.push(m) });
    pushMsg(bot, { messageId: 1000, chatId: 111, text: 'chat1 msg' });
    pushMsg(bot, { messageId: 20, chatId: 222, text: 'chat2 msg' });

    expect(bot.bufferCount).toBe(2);
    // Acknowledge chat 222 up to messageId 20
    const acked = bot.acknowledge(20, 222);
    expect(acked).toBe(1);
    expect(bot.bufferCount).toBe(1);
    expect(bot.getMessages()[0]!.chatId).toBe(111);
    expect(bot.getMessages()[0]!.text).toBe('chat1 msg');
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe('helpers', () => {
  describe('truncateForTelegram', () => {
    it('passes through short messages', () => {
      expect(truncateForTelegram('hello', 4000)).toBe('hello');
    });

    it('hard-cuts when no boundaries exist', () => {
      const long = 'a'.repeat(5000);
      const result = truncateForTelegram(long, 100);
      expect(result.length).toBeLessThanOrEqual(110);
      expect(result).toContain('…[+');
    });

    it('splits on double newline (paragraph) boundary first', () => {
      const text = 'First paragraph with enough text.\n\nSecond paragraph here.';
      const result = truncateForTelegram(text, 40);
      // Should split at the double newline (pos ~25), not mid-word
      expect(result).toContain('First paragraph');
      expect(result).toContain('\n\n…');
    });

    it('falls back to single newline when no paragraph break', () => {
      // Text has a newline well past cutoff=70, within searchEnd=100
      const prefix = 'Line one\n' + 'x'.repeat(80);
      const text = prefix + '\n' + 'a'.repeat(200);
      const result = truncateForTelegram(text, 100);
      expect(result).toContain('Line one');
      // Should find the newline after "xxxx...", not mid-word
      expect(result).toContain('\n…');
    });

    it('falls back to sentence boundary when no newline', () => {
      const text = 'Hello world. This is a sentence. And here is more text that goes on.';
      const result = truncateForTelegram(text, 45);
      // Should split after the second period (sentence boundary), not mid-word
      expect(result).toContain('Hello world. This is a sentence.');
    });

    it('falls back to word boundary when no sentence break', () => {
      const text = 'word1 word2 word3 word4 word5 word6 word7 word8 ' + 'z'.repeat(60);
      const result = truncateForTelegram(text, 55);
      // Should split at a space, keeping complete words
      expect(result).toContain(' …');
    });

    it('hard-cuts as last resort', () => {
      const text = 'a'.repeat(200);
      const result = truncateForTelegram(text, 50);
      expect(result.length).toBeLessThan(60);
      expect(result).toContain('…[+');
    });
  });

  it('escapeHtml replaces special chars', () => {
    expect(escapeHtml('<b>bold</b> & text')).toBe('&lt;b&gt;bold&lt;/b&gt; &amp; text');
  });
});

// ---------------------------------------------------------------------------
// Lifecycle — start / stop
// ---------------------------------------------------------------------------

describe('TelegramBot lifecycle', () => {
  let _originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    _originalFetch = globalThis.fetch;
    // getMe returns ok by default; getUpdates returns idle
    globalThis.fetch = vi.fn().mockImplementation((_url: string) => {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: [] }),
      });
    }) as never as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = _originalFetch;
  });

  it('start is idempotent', () => {
    const bot = makeBot();
    bot.start();
    const firstStartTime = bot.startedAt;
    bot.start(); // second call should be noop
    expect(bot.startedAt).toBe(firstStartTime);
    bot.stop();
  });

  it('stop clears state', () => {
    const bot = makeBot();
    bot.start();
    expect(bot.running).toBe(true);
    bot.stop();
    expect(bot.running).toBe(false);
  });

  it('health returns bot info', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          ok: true,
          result: { id: 1, is_bot: true, first_name: 'T', username: 'mybot' },
        }),
    }) as never as typeof fetch;

    const bot = makeBot();
    const h = await bot.health();
    expect(h.ok).toBe(true);
    expect(h.username).toBe('mybot');
  });

  it('health returns error on API failure', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: false, description: 'Unauthorized' }),
    }) as never as typeof fetch;

    const bot = makeBot();
    const h = await bot.health();
    expect(h.ok).toBe(false);
    expect(h.error).toBe('Unauthorized');
  });

  it('health returns error on network failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const bot = makeBot();
    const h = await bot.health();
    expect(h.ok).toBe(false);
    expect(h.error).toBe('ECONNREFUSED');
  });

  it('health returns error when result is null', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, result: null }),
    }) as never as typeof fetch;

    const bot = makeBot();
    const h = await bot.health();
    expect(h.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sendMessage — retry, error, and edge cases
// ---------------------------------------------------------------------------

describe('TelegramBot sendMessage', () => {
  it('retries on transient failure then succeeds', async () => {
    const bot = makeBot();
    let attempts = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      attempts++;
      if (attempts < 3) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({ ok: false, description: 'Too many requests', error_code: 429 }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: { message_id: 1 } }),
      });
    }) as never as typeof fetch;

    // Speed up retry sleep
    const res = await bot.sendMessage('123', 'test');
    expect(res.ok).toBe(true);
    expect(attempts).toBe(3);
  });

  it('throws on terminal 403 after exactly one fetch attempt', async () => {
    const bot = makeBot();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: false, description: 'Forbidden', error_code: 403 }),
    });
    globalThis.fetch = fetchMock as never as typeof fetch;

    await expect(bot.sendMessage('123', 'test')).rejects.toThrow('Forbidden');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('retries a non-envelope HTTP 502 gateway response and then succeeds', async () => {
    const bot = makeBot();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        json: () => Promise.reject(new SyntaxError('Unexpected token <')),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve({ ok: true, result: { message_id: 3 } }),
      });
    globalThis.fetch = fetchMock as never as typeof fetch;

    await expect(bot.sendMessage('123', 'test')).resolves.toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('catches fetch network error and retries', async () => {
    const bot = makeBot();
    let attempts = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      attempts++;
      if (attempts < 3) return Promise.reject(new Error('ECONNRESET'));
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: { message_id: 2 } }),
      });
    }) as never as typeof fetch;

    const res = await bot.sendMessage('123', 'test');
    expect(res.ok).toBe(true);
    expect(attempts).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Poll error handling
// ---------------------------------------------------------------------------

describe('TelegramBot poll errors', () => {
  it('uses a request deadline longer than the Telegram long-poll timeout', async () => {
    const bot = makeBot();
    const getUpdates = vi.fn().mockResolvedValue([]);
    const internals = bot as unknown as {
      api: { getUpdates: typeof getUpdates };
      poller: { poll(): Promise<void> };
    };
    internals.api.getUpdates = getUpdates;

    await internals.poller.poll();

    expect(getUpdates).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutSeconds: 10,
        deadlineMs: 15_000,
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('logs getUpdates API failure at debug level', async () => {
    const onMessage = vi.fn();
    // Use very short poll interval so we catch the first poll quickly
    const bot = new TelegramBot({
      token: 'test:token',
      pollIntervalSec: 0,
      allowedUsers: new Set<string>(),
      allowedChats: new Set<string>(),
      bufferSize: 10,
      log,
      onMessage,
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: false, description: 'Service unavailable' }),
    }) as never as typeof fetch;

    bot.start();

    // Wait for the poll cycle (0ms interval, fires immediately)
    await new Promise((r) => setTimeout(r, 50));

    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining('Service unavailable'));

    bot.stop();
  });

  it('catches poll network error gracefully', async () => {
    const onMessage = vi.fn();
    const bot = new TelegramBot({
      token: 'test:token',
      pollIntervalSec: 0,
      allowedUsers: new Set<string>(),
      allowedChats: new Set<string>(),
      bufferSize: 10,
      log,
      onMessage,
    });

    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ETIMEDOUT'));

    bot.start();
    await new Promise((r) => setTimeout(r, 50));

    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining('ETIMEDOUT'));

    bot.stop();
  });
});

// ---------------------------------------------------------------------------
// Single-poller lock — standby and takeover
// ---------------------------------------------------------------------------

describe('TelegramBot poll lock', () => {
  let dir: string;
  let _originalFetch: typeof globalThis.fetch;
  const polledUrls: string[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wstack-bot-lock-'));
    polledUrls.length = 0;
    _originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      polledUrls.push(String(url));
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: [] }),
      });
    }) as never as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = _originalFetch;
    rmSync(dir, { recursive: true, force: true });
  });

  function makeLockedBot(token: string, opts?: { standbyRetryMs?: number }) {
    return new TelegramBot({
      token,
      pollIntervalSec: 0,
      allowedUsers: new Set<string>(),
      allowedChats: new Set<string>(),
      bufferSize: 10,
      log,
      onMessage: vi.fn(),
      lock: new PollLock(join(dir, 'poll.lock')),
      standbyRetryMs: opts?.standbyRetryMs ?? 30,
    });
  }

  it('second instance stands by instead of polling', async () => {
    const first = makeLockedBot('test:token-one');
    const second = makeLockedBot('test:token-two');

    first.start();
    second.start();
    await new Promise((r) => setTimeout(r, 60));

    expect(first.standby).toBe(false);
    expect(second.standby).toBe(true);
    expect(polledUrls.some((u) => u.includes('token-one'))).toBe(true);
    expect(polledUrls.some((u) => u.includes('token-two'))).toBe(false);

    first.stop();
    second.stop();
  });

  it('standby instance takes over after the holder stops', async () => {
    const first = makeLockedBot('test:token-one');
    const second = makeLockedBot('test:token-two', { standbyRetryMs: 20 });

    first.start();
    second.start();
    await new Promise((r) => setTimeout(r, 40));
    expect(second.standby).toBe(true);

    first.stop();
    await new Promise((r) => setTimeout(r, 100));

    expect(second.standby).toBe(false);
    expect(polledUrls.some((u) => u.includes('token-two'))).toBe(true);

    second.stop();
  });

  it('standby instance never processes updates (it does not poll, so Telegram never sends them)', async () => {
    // P1.10 safe-standby invariant: a standby instance is one that
    // failed to acquire the poll lock, so it does not call getUpdates
    // and Telegram therefore never sends it an update. If we manually
    // drive an update through the bot (bypassing the gate), the bot
    // processes it normally — the safety contract is "standby never
    // polls, so Telegram never sends it updates", not "standby
    // ignores updates". This test pins the contract end-to-end.
    const standby = makeLockedBot('test:token-two', { standbyRetryMs: 30 });
    const _other = makeLockedBot('test:token-one');
    _other.start();
    standby.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(standby.standby).toBe(true);
    expect(polledUrls.some((u) => u.includes('token-two'))).toBe(false);
    standby.stop();
    _other.stop();
  });

  it('stop releases the lock so a fresh instance can poll immediately', async () => {
    const first = makeLockedBot('test:token-one');
    first.start();
    await new Promise((r) => setTimeout(r, 20));
    first.stop();

    const second = makeLockedBot('test:token-two');
    second.start();
    expect(second.standby).toBe(false);
    second.stop();
  });

  it('bot without a lock polls unconditionally (standby is false)', () => {
    const bot = makeBot();
    bot.start();
    expect(bot.standby).toBe(false);
    bot.stop();
  });
});

// ---------------------------------------------------------------------------
// Allowlist rejections
// ---------------------------------------------------------------------------

function mockSingleUpdate(update: Record<string, unknown>) {
  let sent = false;
  return vi.fn().mockImplementation(() => {
    if (sent) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: [] }),
      });
    }
    sent = true;
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ ok: true, result: [update] }),
    });
  }) as never as typeof fetch;
}

describe('TelegramBot allowlist', () => {
  it('fails closed when a user allowlist is configured but the message has no sender', async () => {
    const onMessage = vi.fn();
    const bot = new TelegramBot({
      token: 'test:token',
      pollIntervalSec: 0,
      allowedUsers: new Set(['111']),
      allowedChats: new Set<string>(),
      bufferSize: 10,
      log,
      onMessage,
    });

    globalThis.fetch = mockSingleUpdate({
      update_id: 1,
      message: {
        message_id: 99,
        chat: { id: 555, type: 'channel' },
        date: Math.floor(Date.now() / 1000),
        text: 'sender identity omitted',
      },
    });

    bot.start();
    await new Promise((r) => setTimeout(r, 100));

    expect(onMessage).not.toHaveBeenCalled();
    expect(bot.bufferCount).toBe(0);
    bot.stop();
  });

  it('rejects users not in allowedUsers', async () => {
    const onMessage = vi.fn();
    const bot = new TelegramBot({
      token: 'test:token',
      pollIntervalSec: 0,
      allowedUsers: new Set(['111']),
      allowedChats: new Set<string>(),
      bufferSize: 10,
      log,
      onMessage,
    });

    globalThis.fetch = mockSingleUpdate({
      update_id: 1,
      message: {
        message_id: 100,
        from: { id: 999, is_bot: false, first_name: 'BadActor' },
        chat: { id: 555, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: 'unauthorized message',
      },
    });

    bot.start();
    await new Promise((r) => setTimeout(r, 100));

    expect(onMessage).not.toHaveBeenCalled();
    expect(bot.bufferCount).toBe(0);
    bot.stop();
  });

  it('does not send an unauthorized-user reply into a non-allowlisted chat', async () => {
    const onMessage = vi.fn();
    const fetchSpy = mockSingleUpdate({
      update_id: 1,
      message: {
        message_id: 100,
        from: { id: 999, is_bot: false, first_name: 'BadActor' },
        chat: { id: 666, type: 'group' },
        date: Math.floor(Date.now() / 1000),
        text: 'dual denial',
      },
    });
    globalThis.fetch = fetchSpy;
    const bot = new TelegramBot({
      token: 'test:token',
      pollIntervalSec: 0,
      allowedUsers: new Set(['111']),
      allowedChats: new Set(['555']),
      bufferSize: 10,
      log,
      onMessage,
    });

    bot.start();
    await new Promise((r) => setTimeout(r, 100));

    expect(onMessage).not.toHaveBeenCalled();
    expect(bot.bufferCount).toBe(0);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/sendMessage'))).toBe(false);
    bot.stop();
  });

  it('allows messages when both identity constraints are intentionally empty', async () => {
    const onMessage = vi.fn();
    const bot = new TelegramBot({
      token: 'test:token',
      pollIntervalSec: 0,
      allowedUsers: new Set<string>(),
      allowedChats: new Set<string>(),
      bufferSize: 10,
      log,
      onMessage,
    });

    globalThis.fetch = mockSingleUpdate({
      update_id: 1,
      message: {
        message_id: 100,
        chat: { id: 555, type: 'channel' },
        date: Math.floor(Date.now() / 1000),
        text: 'explicit public message',
      },
    });

    bot.start();
    await new Promise((r) => setTimeout(r, 100));

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'explicit public message', userId: undefined }),
    );
    expect(bot.bufferCount).toBe(1);
    bot.stop();
  });

  it('rejects chats not in allowedChats', async () => {
    const onMessage = vi.fn();
    const bot = new TelegramBot({
      token: 'test:token',
      pollIntervalSec: 0,
      allowedUsers: new Set<string>(),
      allowedChats: new Set(['-100pub']),
      bufferSize: 10,
      log,
      onMessage,
    });

    globalThis.fetch = mockSingleUpdate({
      update_id: 1,
      message: {
        message_id: 101,
        from: { id: 333, is_bot: false, first_name: 'User' },
        chat: { id: 666, type: 'group', title: 'random group' },
        date: Math.floor(Date.now() / 1000),
        text: 'hello from random group',
      },
    });

    bot.start();
    await new Promise((r) => setTimeout(r, 100));

    expect(onMessage).not.toHaveBeenCalled();
    expect(bot.bufferCount).toBe(0);
    bot.stop();
  });

  it('allows message when user passes allowlists', async () => {
    const onMessage = vi.fn();
    const bot = new TelegramBot({
      token: 'test:token',
      pollIntervalSec: 0,
      allowedUsers: new Set(['111']),
      allowedChats: new Set<string>(),
      bufferSize: 10,
      log,
      onMessage,
    });

    globalThis.fetch = mockSingleUpdate({
      update_id: 1,
      message: {
        message_id: 200,
        from: { id: 111, is_bot: false, first_name: 'Alice' },
        chat: { id: 555, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: 'legit message',
      },
    });

    bot.start();
    await new Promise((r) => setTimeout(r, 100));

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'legit message', userId: 111 }),
    );
    expect(bot.bufferCount).toBe(1);
    bot.stop();
  });
});
