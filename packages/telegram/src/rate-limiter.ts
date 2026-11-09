// ---------------------------------------------------------------------------
// Per-chat token bucket rate limiter for Telegram outbound sends.
//
// Telegram enforces per-chat rate limits:
//   - Groups: ~20 messages per minute (≈ 0.33 msg/s)
//   - Private chats: ~30 messages per second
//
// Instead of hardcoding chat-type limits (which would require an API call
// per chat to discover the type), this limiter exposes a configurable
// tokens-per-second and burst cap. The caller (OutboundQueue) decides
// the policy for each chat based on known chat type.
//
// Each chat gets its own token bucket. When a send is attempted and no
// tokens are available, the caller waits (via waitForToken) until a token
// refills. The wait is bounded by an optional timeout to prevent head-of-line
// blocking when a slow chat stalls the queue.
//
// Thread safety: the bucket state is guarded by the calling pattern —
// OutboundQueue serializes per-chat sends (single ChatLane runner), so
// concurrent access to the same bucket never happens. Cross-chat buckets
// are independent and need no coordination.
// ---------------------------------------------------------------------------

export interface RateLimiterOptions {
  /** Tokens per second (refill rate). Default: 0.33 (≈20/min for groups). */
  tokensPerSecond?: number | undefined;
  /** Maximum burst size (bucket capacity). Default: 4. */
  burst?: number | undefined;
}

export interface TokenBucket {
  /** Wait until a token is available, respecting the optional timeout. */
  waitForToken(timeoutMs?: number | undefined, signal?: AbortSignal | undefined): Promise<void>;
  /** Current fill level (for diagnostics). */
  fill(): number;
  /**
   * True once the bucket has refilled to full capacity. A full, idle bucket
   * holds no pacing state — recreating it yields an identical full bucket — so
   * callers can safely evict it to bound a per-chat bucket map without losing
   * any rate-limit state. A depleted (in-use) bucket is never full.
   */
  isFull(): boolean;
}

/**
 * Create a token bucket for a single chat.
 *
 * The bucket starts full (`burst` tokens). Every `waitForToken` call
 * consumes one token if available; otherwise it waits until a token
 * is refilled. Refills happen at `tokensPerSecond` rate, capped at
 * `burst`.
 *
 * @example
 * ```ts
 * const bucket = createTokenBucket({ tokensPerSecond: 0.33, burst: 4 });
 * await bucket.waitForToken(5_000); // waits up to 5s for a slot
 * bot.sendMessage(chatId, text);
 * ```
 */
export function createTokenBucket(opts?: RateLimiterOptions): TokenBucket {
  const tokensPerSecond =
    typeof opts?.tokensPerSecond === 'number' &&
    Number.isFinite(opts.tokensPerSecond) &&
    opts.tokensPerSecond !== 0
      ? opts.tokensPerSecond
      : 0.33;
  const burst =
    typeof opts?.burst === 'number' && Number.isFinite(opts.burst) && opts.burst >= 0
      ? opts.burst
      : 4;

  let tokens = burst;
  let lastRefill = Date.now();

  return { waitForToken, fill, isFull };

  async function waitForToken(
    timeoutMs?: number | undefined,
    signal?: AbortSignal | undefined,
  ): Promise<void> {
    const deadline = timeoutMs !== undefined ? Date.now() + timeoutMs : Infinity;

    while (true) {
      signal?.throwIfAborted();
      refill();

      if (tokens >= 1) {
        tokens -= 1;
        return;
      }

      const now = Date.now();
      if (now >= deadline) {
        return; // Timeout — caller should proceed or skip
      }

      // Wait until the missing fraction of a token has refilled, or the
      // deadline. refill() just moved `lastRefill` to now, so waiting a whole
      // refill interval from it ignored the fraction already accumulated —
      // at 0.9 tokens a group chat slept 3 s instead of 0.3 s.
      const untilToken = Math.ceil(((1 - tokens) / tokensPerSecond) * 1000);
      const delay = Math.min(
        Math.max(untilToken, 1),
        deadline - now,
        5000, // safety cap: never sleep longer than 5s
      );

      await sleep(delay, signal);
    }
  }

  function refill(): void {
    const now = Date.now();
    const elapsed = now - lastRefill;
    if (elapsed <= 0) return;

    const newTokens = (elapsed / 1000) * tokensPerSecond;
    tokens = Math.min(burst, tokens + newTokens);
    lastRefill = now;
  }

  function fill(): number {
    refill();
    return tokens;
  }

  function isFull(): boolean {
    refill();
    return tokens >= burst;
  }
}

function sleep(ms: number, signal?: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('The operation was aborted', 'AbortError'));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new DOMException('The operation was aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
