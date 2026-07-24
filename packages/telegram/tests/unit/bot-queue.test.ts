import type { Logger } from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';
import type { TelegramBot } from '../../src/bot.js';
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

const makeBot = (sendImpl: ReturnType<typeof vi.fn>) =>
  ({
    sendMessage: sendImpl,
  }) as unknown as TelegramBot;

describe('TelegramBotOutbound', () => {
  it('exposes stats and rejects sends after stop', async () => {
    const queue = new TelegramBotOutbound({
      bot: makeBot(vi.fn()),
      log: silentLog,
    });
    expect(queue.stats()).toMatchObject({ pending: 0 });
    await queue.stop();
    await expect(queue.sendManual(1, 'late')).rejects.toThrow('queue is stopped');
    queue.enqueueNotification(1, 'ignored');
    expect(silentLog.debug).toHaveBeenCalledWith(expect.stringContaining('ignored notification'));
  });

  it('surfaces Telegram ok=false responses', async () => {
    const queue = new TelegramBotOutbound({
      bot: makeBot(vi.fn().mockResolvedValue({ ok: false })),
      log: silentLog,
    });
    await expect(queue.sendManual(9, 'failure')).rejects.toThrow('ok=false');
    await queue.stop();
  });

  it('sweeps only fully-refilled idle buckets', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const rate = vi.fn().mockReturnValue(1);
      const burst = vi.fn().mockReturnValue(1);
      const send = vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } });
      const queue = new TelegramBotOutbound({
        bot: makeBot(send),
        log: silentLog,
        getRateLimitTokensPerSecond: rate,
        getRateLimitBurst: burst,
      });
      await queue.sendManual(1, 'first');
      await vi.advanceTimersByTimeAsync(60_000);
      await queue.sendManual(1, 'second');
      expect(rate).toHaveBeenCalledTimes(2);
      await queue.stop();

      const slowRate = vi.fn().mockReturnValue(0.0001);
      const slow = new TelegramBotOutbound({
        bot: makeBot(send),
        log: silentLog,
        getRateLimitTokensPerSecond: slowRate,
        getRateLimitBurst: () => 1,
      });
      await slow.sendManual(2, 'first');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(slowRate).toHaveBeenCalledOnce();
      await slow.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('routes manual sends through the queue and resolves with the bot result', async () => {
    const send = vi.fn(async () => ({
      ok: true as const,
      result: { message_id: 1, chat: { id: 99, type: 'private' as const } },
    }));
    const queue = new TelegramBotOutbound({
      bot: makeBot(send),
      log: silentLog,
      maxPerChat: 4,
      maxConcurrency: 2,
    });

    const result = await queue.sendManual(99, 'hello');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(99, 'hello');
    expect(result.ok).toBe(true);
    await queue.stop();
  });

  it('routes notifications through the queue fire-and-forget', async () => {
    const send = vi.fn(async () => ({
      ok: true as const,
      result: { message_id: 2, chat: { id: 99, type: 'private' as const } },
    }));
    const queue = new TelegramBotOutbound({
      bot: makeBot(send),
      log: silentLog,
      maxPerChat: 4,
      maxConcurrency: 1,
    });

    queue.enqueueNotification(99, 'one');
    queue.enqueueNotification(99, 'two');

    // Drain.
    await new Promise((r) => setTimeout(r, 20));
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map((c) => c[1])).toEqual(['one', 'two']);
    await queue.stop();
  });

  it('paces sends when rate-limit burst is exhausted', async () => {
    // Burst=1, 0.33 tokens/s: the first send consumes the only token, so the
    // second must wait ~3s for a refill. We assert the second send is held
    // (not called within a short window) when burst is 1, then verify it
    // completes once we allow enough time.
    const send = vi.fn(async () => ({
      ok: true as const,
      result: { message_id: 3, chat: { id: 77, type: 'private' as const } },
    }));
    const queue = new TelegramBotOutbound({
      bot: makeBot(send),
      log: silentLog,
      maxPerChat: 4,
      maxConcurrency: 2,
      getRateLimitTokensPerSecond: () => 0.33,
      getRateLimitBurst: () => 1,
    });

    // First send consumes the token immediately.
    await queue.sendManual(77, 'first');
    expect(send).toHaveBeenCalledTimes(1);

    // Second send is rate-limited — it should not complete within 50ms
    // because the token needs ~3s to refill.
    let secondResolved = false;
    const second = queue.sendManual(77, 'second').then(() => {
      secondResolved = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(secondResolved).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);

    // Now allow the refill to complete (wait beyond 3s + the 5s timeout).
    await second;
    expect(send).toHaveBeenCalledTimes(2);
    await queue.stop();
  });

  it('allows a burst of notifications to drain immediately', async () => {
    // With the default burst of 4, two notifications to the same chat should
    // both complete within a short window without waiting for a refill.
    const send = vi.fn(async (_chatId: string | number, _text: string) => ({
      ok: true as const,
      result: { message_id: 4, chat: { id: 88, type: 'private' as const } },
    }));
    const queue = new TelegramBotOutbound({
      bot: makeBot(send),
      log: silentLog,
      maxPerChat: 4,
      maxConcurrency: 2,
      // Use defaults (burst=4)
    });

    queue.enqueueNotification(88, 'one');
    queue.enqueueNotification(88, 'two');

    await new Promise((r) => setTimeout(r, 50));
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map((c) => c[1])).toEqual(['one', 'two']);
    await queue.stop();
  });

  it('surfaces a manual overflow as an error rather than silently dropping', async () => {
    let rejectSend!: (err: Error) => void;
    const gate = new Promise<never>((_, reject) => {
      rejectSend = reject;
    });
    const send = vi.fn(() => gate);
    const queue = new TelegramBotOutbound({
      bot: makeBot(send),
      log: silentLog,
      maxPerChat: 1,
      maxConcurrency: 1,
    });

    const first = queue.sendManual(99, 'first');
    // Second send overflows because one is already in-flight (maxPerChat=1).
    await expect(queue.sendManual(99, 'second')).rejects.toThrow(/per-chat limit/);
    // Reject the in-flight send so stop() can drain.
    rejectSend(new Error('network error'));
    await expect(first).rejects.toThrow();
    await queue.stop();
  });
});
