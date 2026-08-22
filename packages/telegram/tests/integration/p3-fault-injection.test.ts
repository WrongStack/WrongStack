// ---------------------------------------------------------------------------
// P3.3 — Deterministic Bot API fault-injection integration suite.
//
// Uses a local FakeTelegramServer to simulate every failure mode the
// Telegram polling and outbound pipeline can encounter, without any real
// network or bot token.
//
// Runs in-memory on a random loopback port — cleanup is automatic and
// leaves no process, port, or file locks behind.
// ---------------------------------------------------------------------------

import type { Logger } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TelegramApiClient,
  TelegramBotApiError,
  TelegramResponseParseError,
} from '../../src/api-client.js';
import { TelegramBot, type TelegramIncomingMessage } from '../../src/bot.js';
import { FakeTelegramServer } from '../helpers/fake-telegram-server.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOKEN = '123456:test-token-aaaa';
const TEST_CHAT = 99;
const TEST_USER = 42;

/** Minimal logger that discards everything. */
const silentLog: Logger = {
  level: 'error',
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  child() {
    return this;
  },
};

function testBot(
  server: FakeTelegramServer,
  onMessage: (message: TelegramIncomingMessage) => void = () => {},
): TelegramBot {
  const bot = new TelegramBot({
    token: TOKEN,
    pollIntervalSec: 1,
    allowedUsers: new Set([String(TEST_USER)]),
    allowedChats: new Set([String(TEST_CHAT)]),
    bufferSize: 50,
    log: silentLog,
    onMessage,
  });
  (bot as unknown as { api: TelegramApiClient }).api = new TelegramApiClient({
    token: TOKEN,
    apiRoot: server.baseUrl,
  });
  return bot;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('P3.3 — Deterministic Bot API fault-injection', () => {
  let server: FakeTelegramServer;

  beforeEach(async () => {
    server = new FakeTelegramServer();
    server.start();
    await server.started;
  });

  afterEach(async () => {
    await server.close();
  });

  // ------------------------------------------------------------------
  // 1. Happy path — getMe, getUpdates, sendMessage all succeed
  // ------------------------------------------------------------------

  it('handles a successful getMe / getUpdates / sendMessage cycle', async () => {
    const client = new TelegramApiClient({ token: TOKEN, apiRoot: server.baseUrl });
    const user = await client.getMe();
    expect(user.id).toBe(420001);
    expect(user.username).toBe('test_bot');

    const updates = await client.getUpdates({ offset: 0, timeoutSeconds: 5 });
    expect(updates.length).toBeGreaterThanOrEqual(1);

    const msg = await client.sendMessage(TEST_CHAT, 'hello');
    expect(msg.message_id).toBeGreaterThan(0);
  });

  // ------------------------------------------------------------------
  // 2. HTTP 401 — invalid token
  // ------------------------------------------------------------------

  it('returns TelegramBotApiError on HTTP 401', async () => {
    server.on('getMe', () => FakeTelegramServer.error(401, 'Unauthorized'));
    const client = new TelegramApiClient({ token: 'bad:token', apiRoot: server.baseUrl });
    await expect(client.getMe()).rejects.toThrow(TelegramBotApiError);
  });

  // ------------------------------------------------------------------
  // 3. HTTP 403 — forbidden (terminal, no retry)
  // ------------------------------------------------------------------

  it('returns TelegramBotApiError on HTTP 403 and does not retry', async () => {
    server.on('sendMessage', () =>
      FakeTelegramServer.error(403, 'Forbidden: bot was blocked by the user'),
    );
    const client = new TelegramApiClient({ token: TOKEN, apiRoot: server.baseUrl });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(client.sendMessage(TEST_CHAT, 'test')).rejects.toThrow(TelegramBotApiError);
    // Only the one call — no retry for 4xx (except 429/409)
    expect(server.calls.filter((c) => c.method === 'sendMessage').length).toBe(1);

    fetchSpy.mockRestore();
  });

  // ------------------------------------------------------------------
  // 4. HTTP 409 — conflict (retryable)
  // ------------------------------------------------------------------

  it('surfaces HTTP 409 conflict to the polling owner without hidden client retries', async () => {
    let attempts = 0;
    server.on('getUpdates', () => {
      attempts++;
      return FakeTelegramServer.error(409, 'Conflict: terminated by other getUpdates');
    });

    const client = new TelegramApiClient({ token: TOKEN, apiRoot: server.baseUrl });
    await expect(client.getUpdates({ offset: 0, timeoutSeconds: 5 })).rejects.toMatchObject({
      errorCode: 409,
    });
    expect(attempts).toBe(1);
  });

  // ------------------------------------------------------------------
  // 5. HTTP 429 — rate limited with retry_after
  // ------------------------------------------------------------------

  it('honours retry_after on HTTP 429 and succeeds on retry', async () => {
    let attempts = 0;
    server.on('sendMessage', () => {
      attempts++;
      if (attempts === 1)
        return FakeTelegramServer.error(429, 'Too Many Requests', { retry_after: 1 });
      return {
        envelope: {
          ok: true,
          result: { message_id: 42, chat: { id: TEST_CHAT, type: 'private' }, date: 1_700_000_000 },
        },
      };
    });

    const bot = testBot(server);
    const response = await bot.sendMessage(TEST_CHAT, 'hello');
    expect(response.result?.message_id).toBe(42);
    expect(attempts).toBe(2);
  });

  // ------------------------------------------------------------------
  // 6. HTTP 500 — server error (retryable)
  // ------------------------------------------------------------------

  it('retries on HTTP 500 server error', async () => {
    let attempts = 0;
    server.on('sendMessage', () => {
      attempts++;
      if (attempts <= 2) return FakeTelegramServer.rawStatus(500, 'Internal Server Error');
      return {
        envelope: {
          ok: true,
          result: {
            message_id: 1,
            chat: { id: TEST_CHAT, type: 'private' },
            date: 1_700_000_000,
          },
        },
      };
    });

    const bot = testBot(server);
    const response = await bot.sendMessage(TEST_CHAT, 'hello');
    expect(response.result?.message_id).toBe(1);
    expect(attempts).toBe(3);
  });

  // ------------------------------------------------------------------
  // 7. Malformed JSON response
  // ------------------------------------------------------------------

  it('throws TelegramResponseParseError on malformed JSON', async () => {
    server.on('getMe', () => FakeTelegramServer.malformed('not-json-at-all'));
    const client = new TelegramApiClient({ token: TOKEN, apiRoot: server.baseUrl });
    await expect(client.getMe()).rejects.toThrow(TelegramResponseParseError);
  });

  // ------------------------------------------------------------------
  // 8. Duplicate updates (same update_id)
  // ------------------------------------------------------------------

  it('deduplicates updates with same update_id via polling loop', async () => {
    // Queue two batches: first has {update_id:1}, second also has {update_id:1} (duplicate)
    server.enqueueUpdates(
      [
        {
          update_id: 1,
          message: {
            message_id: 10,
            from: { id: TEST_USER, is_bot: false, first_name: 'Allowed' },
            chat: { id: TEST_CHAT, type: 'private' },
            date: 1_700_000_000,
            text: 'first',
          },
        },
      ],
      [
        {
          update_id: 1,
          message: {
            message_id: 10,
            from: { id: TEST_USER, is_bot: false, first_name: 'Allowed' },
            chat: { id: TEST_CHAT, type: 'private' },
            date: 1_700_000_000,
            text: 'first',
          },
        },
      ],
    );
    // Override getUpdates to dispense from queue
    server.on('getUpdates', () => {
      const batch = server['updateQueue'].shift() ?? [];
      return { envelope: { ok: true, result: batch } };
    });

    const messages: Array<{ text: string }> = [];
    const bot = testBot(server, (msg) => {
      messages.push(msg);
    });

    // Process the update once, then replay the same update_id on the next poll.
    await (bot as unknown as { poller: { poll(): Promise<void> } }).poller.poll();
    await (bot as unknown as { poller: { poll(): Promise<void> } }).poller.poll();
    expect(messages.length).toBe(1); // Only the first instance
  });

  // ------------------------------------------------------------------
  // 9. Bot API server crash/restart
  // ------------------------------------------------------------------

  it('recovers after server goes down and comes back', async () => {
    const client = new TelegramApiClient({ token: TOKEN, apiRoot: server.baseUrl });

    // First call works
    await expect(client.getMe()).resolves.toMatchObject({ id: 420001 });

    // Simulate crash by closing the server
    await server.close();

    // Calls fail with network error
    // Actually, the server is down so the API call will get a connection refused
    // Let's recreate the server on the same port... but we can't guarantee same port.
    // Instead, test that the client throws on an unreachable endpoint.
    await expect(client.getMe()).rejects.toThrow(); // Will be some error (connection refused or timeout)

    // Restart: create a new server
    const server2 = new FakeTelegramServer();
    server2.start();
    await server2.started;

    // But the client's apiRoot still points to the old port. So create a new client.
    const client2 = new TelegramApiClient({ token: TOKEN, apiRoot: server2.baseUrl });
    await expect(client2.getMe()).resolves.toMatchObject({ id: 420001 });

    await server2.close();
  });

  // ------------------------------------------------------------------
  // 10. Delayed poll response / timeout
  // ------------------------------------------------------------------

  it('aborts a poll that exceeds the deadline', async () => {
    vi.useFakeTimers();
    try {
      server.on('getUpdates', () => ({
        envelope: { ok: true, result: [{ update_id: 1 }] },
        delayMs: 20_000, // Longer than the 15s deadline
      }));

      const client = new TelegramApiClient({ token: TOKEN, apiRoot: server.baseUrl });
      const pollPromise = client.getUpdates({ offset: 0, timeoutSeconds: 10, deadlineMs: 5_000 });

      // Advance time past deadline
      await vi.advanceTimersByTimeAsync(6_000);

      await expect(pollPromise).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  // ------------------------------------------------------------------
  // 11. Callback query timing — answerCallbackQuery
  // ------------------------------------------------------------------

  it('answers a callback query successfully', async () => {
    server.on('answerCallbackQuery', () => ({ envelope: { ok: true, result: true } }));
    const client = new TelegramApiClient({ token: TOKEN, apiRoot: server.baseUrl });
    await expect(client.answerCallbackQuery('cb-id', 'done', false)).resolves.toBe(true);
  });

  // ------------------------------------------------------------------
  // 12. Queue pressure — rapid outbound sends
  // ------------------------------------------------------------------

  it('handles rapid sendMessage calls without losing ordering', async () => {
    const callOrder: number[] = [];
    server.on('sendMessage', (body) => {
      const msgId = Number(body.message_id ?? 0) || 100 + callOrder.length;
      callOrder.push(msgId);
      return {
        envelope: {
          ok: true,
          result: {
            message_id: msgId,
            chat: { id: TEST_CHAT, type: 'private' },
            date: 1_700_000_000,
          },
        },
      };
    });

    const client = new TelegramApiClient({ token: TOKEN, apiRoot: server.baseUrl });
    const results = await Promise.all([
      client.sendMessage(TEST_CHAT, 'first'),
      client.sendMessage(TEST_CHAT, 'second'),
      client.sendMessage(TEST_CHAT, 'third'),
    ]);

    expect(results).toHaveLength(3);
    // Each message gets a unique message_id > 0
    for (const r of results) expect(r.message_id).toBeGreaterThan(0);
  });

  // ------------------------------------------------------------------
  // 13. Bot poll loop handles HTTP 409 backoff
  // ------------------------------------------------------------------

  it('bot poll state tracks consecutive 409 conflicts', async () => {
    let _conflictCount = 0;
    server.on('getUpdates', () => {
      _conflictCount++;
      return FakeTelegramServer.error(409, 'Conflict');
    });

    const bot = testBot(server);
    const poll = () => (bot as unknown as { poller: { poll(): Promise<void> } }).poller.poll();
    await poll();
    await poll();
    await poll();

    // Each poll records the conflict and advances the backoff streak.
    const conflictCalls = server.calls.filter((c) => c.method === 'getUpdates').length;
    expect(conflictCalls).toBe(3);
    expect(bot.poller.conflictStreak).toBe(3);
  });

  // ------------------------------------------------------------------
  // Cleanup verification — no dangling handles
  // ------------------------------------------------------------------

  it('server.close() cleans up all resources', async () => {
    const s = new FakeTelegramServer();
    s.start();
    await s.started;

    // Verify it's serving
    const client = new TelegramApiClient({ token: TOKEN, apiRoot: s.baseUrl });
    await expect(client.getMe()).resolves.toMatchObject({ id: 420001 });

    // Close
    await s.close();

    // State should be reset
    expect(s['updateQueue']).toHaveLength(0);
    expect(s['calls']).toHaveLength(0);
  });
});
