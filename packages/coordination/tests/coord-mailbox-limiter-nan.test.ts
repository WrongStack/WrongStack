import { describe, expect, it } from 'vitest';
import { MailboxHttpRateLimiter } from '../src/mailbox-http-rate-limit.js';

describe('MailboxHttpRateLimiter non-finite constructor guard (F2293)', () => {
  it('falls back to default limit and windowMs when NaN is supplied', () => {
    const limiter = new MailboxHttpRateLimiter(Number.NaN, Number.NaN);
    let allowed = 0;
    for (let i = 0; i < 150; i++) {
      if (limiter.allow('client-1')) allowed++;
    }
    expect(allowed).toBe(120);
  });
});
