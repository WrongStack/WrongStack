export const MAILBOX_HTTP_RATE_LIMIT_PER_MINUTE = 120;
export const MAILBOX_HTTP_RATE_LIMIT_WINDOW_MS = 60_000;

/** Sliding-window request limiter shared by every mailbox HTTP host. */
export class MailboxHttpRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    readonly limit = MAILBOX_HTTP_RATE_LIMIT_PER_MINUTE,
    readonly windowMs = MAILBOX_HTTP_RATE_LIMIT_WINDOW_MS,
  ) {}

  allow(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const fresh = (this.hits.get(key) ?? []).filter((timestamp) => timestamp > cutoff);
    if (fresh.length >= this.limit) {
      this.hits.set(key, fresh);
      return false;
    }
    fresh.push(now);
    this.hits.set(key, fresh);
    return true;
  }

  cleanup(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, timestamps] of this.hits) {
      const fresh = timestamps.filter((timestamp) => timestamp > cutoff);
      if (fresh.length === 0) this.hits.delete(key);
      else this.hits.set(key, fresh);
    }
  }
}
