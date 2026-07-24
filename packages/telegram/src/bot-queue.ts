// ---------------------------------------------------------------------------
// Telegram outbound queue integration.
//
// Provides a TelegramBot helper that routes manual sends (the
// telegram_send tool, /telegram:send) through the same bounded outbound
// queue used by automatic notifications, so user-triggered and
// notification-triggered sends share per-chat ordering and backpressure.
//
// Manual entries reject on overflow (caller sees the error), per the P1.4
// acceptance criterion "manual sends are never silently dropped".
// Notification entries are dropped on overflow per the same criterion.
//
// Rate limiting: each chat gets a token bucket that paces sends according
// to Telegram's per-chat rate limits. The default policy (0.33 tokens/s,
// burst 4) is conservative for group chats while permitting short notification
// bursts to drain immediately; private chats use a higher rate (30 tokens/s,
// burst 5) when the chat type is known.
// ---------------------------------------------------------------------------

import type { Logger } from '@wrongstack/core/types';
import type { TelegramApiMessage } from './api-client.js';
import type { TelegramBot, TelegramBotResponse } from './bot.js';
import { type OutboundEntry, OutboundQueue } from './outbound-queue.js';
import { createTokenBucket, type TokenBucket } from './rate-limiter.js';

export interface BotOutboundOptions {
  readonly bot: TelegramBot;
  /** Pass-through logger (defaults to bot's internal logger via the bot's debug hook). */
  readonly log: Logger;
  /** Optional override; defaults to 32 entries per chat. */
  readonly maxPerChat?: number;
  /** Optional override; defaults to 4 concurrent sends. */
  readonly maxConcurrency?: number;
  /**
   * Live getter for tokens per second on the per-chat rate limiter.
   * Default: 0.33 (≈20 messages/minute, safe for groups).
   * Private chats can safely use 30.
   * Passed as a getter so config hot-reload takes effect on the next new
   * bucket (existing buckets retain their captured parameters for the
   * queue lifetime, which is the intended lifetime of the bot).
   */
  readonly getRateLimitTokensPerSecond?: (() => number) | undefined;
  /**
   * Live getter for maximum burst size on the per-chat rate limiter.
   * Default: 4. Read lazily per new-bucket creation so config
   * hot-reload propagates without queue rebuild.
   */
  readonly getRateLimitBurst?: (() => number) | undefined;
}

/** How often idle, fully-refilled per-chat buckets are swept from the map. */
const BUCKET_SWEEP_INTERVAL_MS = 60_000;

export class TelegramBotOutbound {
  readonly #queue: OutboundQueue;
  readonly #bot: TelegramBot;
  readonly #log: Logger;
  readonly #buckets = new Map<string, TokenBucket>();
  readonly #getRateTokensPerSecond: () => number;
  readonly #getRateBurst: () => number;
  readonly #bucketSweepTimer: ReturnType<typeof setInterval>;
  #stopped = false;

  constructor(opts: BotOutboundOptions) {
    this.#bot = opts.bot;
    this.#log = opts.log;
    this.#getRateTokensPerSecond = opts.getRateLimitTokensPerSecond ?? (() => 0.33);
    this.#getRateBurst = opts.getRateLimitBurst ?? (() => 4);
    this.#queue = new OutboundQueue({
      maxPerChat: opts.maxPerChat,
      maxConcurrency: opts.maxConcurrency,
      send: (chatId, text) => this.#rateLimitedSend(chatId, text),
      log: opts.log,
    });
    // Without this the bucket map grows one entry per distinct chatId for the
    // whole process lifetime (a bot reachable by many chats leaks memory).
    // Only fully-refilled buckets are evicted: they carry no pacing state, so
    // the next send to that chat lazily recreates an identical full bucket.
    // A depleted (actively rate-limited) bucket is never full, so its pacing
    // state always survives the sweep.
    this.#bucketSweepTimer = setInterval(() => this.#sweepIdleBuckets(), BUCKET_SWEEP_INTERVAL_MS);
    this.#bucketSweepTimer.unref?.();
  }

  #sweepIdleBuckets(): void {
    for (const [key, bucket] of this.#buckets) {
      if (bucket.isFull()) this.#buckets.delete(key);
    }
  }

  /** Per-chat rate-limited send: waits for a token, then delegates to the bot.
   * Rate-limit values are resolved lazily when a new bucket is created via
   * the constructor getters so a live config change applies to subsequent
   * chats without rebuilding the queue. */
  async #rateLimitedSend(
    chatId: string | number,
    text: string,
  ): Promise<TelegramBotResponse<TelegramApiMessage>> {
    const key = String(chatId);
    let bucket = this.#buckets.get(key);
    if (!bucket) {
      bucket = createTokenBucket({
        tokensPerSecond: this.#getRateTokensPerSecond(),
        burst: this.#getRateBurst(),
      });
      this.#buckets.set(key, bucket);
    }

    // Wait up to 5s for a token slot; if timeout, proceed anyway so the
    // queue doesn't stall. Telegram will return 429 if we're still over the
    // limit, and the api-client's retry logic will handle it.
    await bucket.waitForToken(5_000);

    const res = await this.#bot.sendMessage(chatId, text);
    if (!res.ok) {
      throw new Error(`Telegram outbound send returned ok=false for chat ${chatId}`);
    }
    return res;
  }

  /** Manual send (telegram_send tool, /telegram:send): never silently dropped. */
  async sendManual(
    chatId: string | number,
    text: string,
  ): Promise<TelegramBotResponse<TelegramApiMessage>> {
    if (this.#stopped) {
      throw new Error('Telegram outbound queue is stopped');
    }
    return (await this.#queue.enqueue({
      chatId,
      text,
      kind: 'manual',
    })) as TelegramBotResponse<TelegramApiMessage>;
  }

  /**
   * Notification send (session ended, long tool, delegate): fire-and-forget.
   * The returned promise resolves as soon as the queue accepts the entry;
   * downstream send failures are logged and counted but not surfaced.
   */
  enqueueNotification(chatId: string | number, text: string): void {
    if (this.#stopped) {
      this.#log.debug(`Telegram outbound queue ignored notification for chat ${chatId}: stopped`);
      return;
    }
    const entry: OutboundEntry = { chatId, text, kind: 'notification' };
    // Notifications are accepted or dropped without rejection. The outer
    // stopped guard prevents the only rejecting state of the inner queue.
    void this.#queue.enqueue(entry);
  }

  stats() {
    return this.#queue.stats();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#bucketSweepTimer);
    await this.#queue.stop();
  }
}
