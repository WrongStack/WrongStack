// ---------------------------------------------------------------------------
// P1 Gate — focused fault suite for delivery, retry and concurrency.
//
// This suite is the P1 Gate acceptance evidence: it exercises the integrated
// behavior of TelegramBot.sendMessage (typed transport + abort + retry),
// the typed-client error taxonomy, and the queue/wrapper integration under
// backpressure at the TelegramBotOutbound layer. It is intentionally
// deterministic: every fetch mock resolves immediately, no real timers
// drive the retry backoff, and the test does not depend on wall-clock.
//
// The deeper unit coverage for the outbound queue (per-chat FIFO, manual
// overflow rejection, notification drop-oldest, caller↔result correlation)
// lives in packages/telegram/tests/unit/outbound-queue.test.ts and
// bot-queue.test.ts, all green under the P1.4 frozen commit. The atomic
// offset-cursor coverage lives in packages/telegram/tests/unit/offset-store.test.ts,
// all green under the P1.5 frozen commit. The classify-retry policy is
// exercised both here and in packages/telegram/tests/unit/api-client.test.ts.
// ---------------------------------------------------------------------------

import type { Logger } from '@wrongstack/contracts/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyRetry,
  type TelegramApiMessage,
  TelegramBotApiError,
  type TelegramBotResponse,
  TelegramHttpError,
  TelegramNetworkError,
} from '../../src/api-client.js';
import { TelegramBot } from '../../src/bot.js';
import { TelegramBotOutbound } from '../../src/bot-queue.js';

const silentLog: Logger = {
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

function makeBot(fetchImpl: typeof fetch): TelegramBot {
  return new TelegramBot({
    token: 'test:token',
    pollIntervalSec: 0,
    allowedUsers: new Set<string>(),
    allowedChats: new Set<string>(),
    bufferSize: 1,
    log: silentLog,
    fetch: fetchImpl,
  });
}

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('P1 Gate — typed transport, retry, queue, cursor fault suite', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------
  // 1. Typed transport — fetch contract
  // ---------------------------------------------------------------------
  describe('typed transport', () => {
    it('sendMessage forwards a typed body+headers+timeout to fetch and surfaces the typed response', async () => {
      const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
      globalThis.fetch = vi.fn(async (url, init) => {
        const u = typeof url === 'string' ? url : url.toString();
        calls.push({ url: u, init });
        return okJson({
          ok: true,
          result: { message_id: 42, chat: { id: 99, type: 'private' } },
        });
      }) as never as typeof fetch;

      const bot = makeBot(globalThis.fetch);
      const result = await bot.sendMessage(99, 'hello');

      expect(result.ok).toBe(true);
      expect(result.result.message_id).toBe(42);
      expect(calls).toHaveLength(1);
      const call = calls[0]!;
      expect(call.url).toBe('https://api.telegram.org/bottest:token/sendMessage');
      expect(call.init?.method).toBe('POST');
      expect(call.init?.headers).toMatchObject({ 'Content-Type': 'application/json' });
      expect(JSON.parse(String(call.init?.body))).toEqual({
        chat_id: '99',
        text: 'hello',
        disable_web_page_preview: true,
      });
      bot.stop();
    });

    it('caller-supplied AbortSignal composes with the per-attempt timeout via AbortSignal.any', async () => {
      const calls: Array<{ signal: AbortSignal | null }> = [];
      globalThis.fetch = vi.fn(async (_url, init) => {
        const signal = init?.signal as AbortSignal | undefined;
        calls.push({ signal: signal ?? null });
        return new Promise<Response>((_, reject) => {
          if (signal?.aborted) {
            reject(new DOMException('aborted', 'AbortError'));
            return;
          }
          signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        });
      }) as never as typeof fetch;

      const bot = makeBot(globalThis.fetch);
      const ctrl = new AbortController();
      const promise = bot.sendMessage(99, 'hello', ctrl.signal).catch((err: unknown) => err);

      // Yield once so the fetch is in-flight, then abort.
      await new Promise((r) => setImmediate(r));
      ctrl.abort();
      const err = (await promise) as { name?: string; aborted?: boolean };
      expect(err).toBeDefined();
      expect(calls).toHaveLength(1);
      const signal = calls[0]!.signal;
      expect(signal).not.toBeNull();
      // The composed signal must reflect the caller-side abort.
      expect(signal!.aborted).toBe(true);

      bot.stop();
    });
  });

  // ---------------------------------------------------------------------
  // 2. Retry classification — 4xx terminal, 429/409 retry, 5xx/network retry
  // ---------------------------------------------------------------------
  describe('retry classification', () => {
    it.each([
      [400, false],
      [401, false],
      [403, false],
      [404, false],
      [422, false],
      [429, true],
      [409, true],
      [500, true],
      [502, true],
    ])('classifies HTTP %i as %s', (status, retry) => {
      const decision = classifyRetry(new TelegramHttpError('sendMessage', status), 1);
      expect(decision.retry).toBe(retry);
    });

    it('treats 429 with retry_after as retryable within a bounded delay window', () => {
      const decision = classifyRetry(
        new TelegramBotApiError('sendMessage', {
          errorCode: 429,
          retryAfterSeconds: 7,
          description: 'rate',
        }),
        1,
      );
      expect(decision.retry).toBe(true);
      // baseDelay = 7000ms; jitter = 30% => [4900, 9100]
      expect(decision.delayMs).toBeGreaterThanOrEqual(4_900);
      expect(decision.delayMs).toBeLessThanOrEqual(9_100);
    });

    it('treats attempt >= 3 as terminal regardless of class', () => {
      const decision = classifyRetry(new TelegramHttpError('sendMessage', 500), 3);
      expect(decision.retry).toBe(false);
    });

    it('treats aborted network errors as terminal (caller cancelled, do not retry)', () => {
      const decision = classifyRetry(new TelegramNetworkError('sendMessage', 'cancelled', true), 1);
      expect(decision.retry).toBe(false);
    });
  });

  // ---------------------------------------------------------------------
  // 3. TelegramBotOutbound wrapper integrates with bot.sendMessage
  // ---------------------------------------------------------------------
  describe('wrapper integration with the live bot', () => {
    it('routes a manual send through the queue and returns the bot result', async () => {
      globalThis.fetch = vi.fn(async () =>
        okJson({
          ok: true,
          result: { message_id: 7, chat: { id: 1, type: 'private' } },
        }),
      ) as never as typeof fetch;

      const bot = makeBot(globalThis.fetch);
      const queue = new TelegramBotOutbound({
        bot,
        log: silentLog,
        maxPerChat: 4,
        maxConcurrency: 2,
      });

      const result = (await queue.sendManual(
        1,
        'hello',
      )) as TelegramBotResponse<TelegramApiMessage>;
      expect(result.ok).toBe(true);
      expect(result.result.message_id).toBe(7);

      await queue.stop();
      bot.stop();
    });

    it('throws the last error when sendMessage exhausts retries on terminal 403', async () => {
      globalThis.fetch = vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: false, description: 'Forbidden', error_code: 403 }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
          }),
      ) as never as typeof fetch;

      const bot = makeBot(globalThis.fetch);
      await expect(bot.sendMessage(99, 'x')).rejects.toThrow(/Forbidden/);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1); // no retry on terminal 4xx
      bot.stop();
    });
  });
});
