import { describe, expect, it } from 'vitest';
import { DefaultSecretScrubber } from '../src/secret-scrubber.js';

/**
 * F85: the scrubber's AWS pattern knew only AKIA (long-term access keys).
 * ASIA-prefixed keys are AWS STS TEMPORARY credentials — the standard output
 * of SSO/CI federation — with the identical 20-char shape. They passed through
 * verbatim into logs, error text and persisted tool output. Stripe webhook
 * signing secrets (whsec_…) were likewise uncovered: they let an attacker
 * forge webhook events, yet only sk_/rk_ keys were redacted.
 */
const scrubber = new DefaultSecretScrubber();
const asiaKey = `ASIA${'Q'.repeat(16)}`;
const akiaKey = `AKIA${'Q'.repeat(16)}`;
const whsec = `whsec_${'a'.repeat(32)}`;

describe('AWS STS temporary credential coverage (F85)', () => {
  it('redacts an ASIA temporary access key', () => {
    const out = scrubber.scrub(`credential=${asiaKey} expired`);
    expect(out).not.toContain(asiaKey);
    expect(out).toContain('[REDACTED:aws_access_key]');
  });

  it('still redacts AKIA long-term keys (control)', () => {
    const out = scrubber.scrub(`credential=${akiaKey}`);
    expect(out).not.toContain(akiaKey);
    expect(out).toContain('[REDACTED:aws_access_key]');
  });

  it('redacts ASIA keys embedded in JSON error text', () => {
    const out = scrubber.scrub(`{"AccessKeyId":"${asiaKey}","Message":"denied"}`);
    expect(out).not.toContain(asiaKey);
  });

  it('does not redact a too-short or embedded lookalike (control)', () => {
    const short = `ASIA${'Q'.repeat(15)}`;
    expect(scrubber.scrub(short)).toBe(short);
    const embedded = `XASIA${'Q'.repeat(16)}`;
    expect(scrubber.scrub(embedded)).toBe(embedded);
  });
});

describe('Stripe webhook signing secret coverage (F85)', () => {
  it('redacts a whsec_ webhook signing secret', () => {
    const out = scrubber.scrub(`STRIPE_WEBHOOK_SECRET=${whsec}`);
    expect(out).not.toContain(whsec);
    expect(out).toContain('[REDACTED:stripe_webhook_secret]');
  });

  it('still redacts sk_live secret keys (control)', () => {
    const sk = `sk_live_${'b'.repeat(24)}`;
    const out = scrubber.scrub(sk);
    expect(out).not.toContain(sk);
    expect(out).toContain('[REDACTED:stripe_key]');
  });

  it('scrubbing is idempotent for the new shapes', () => {
    for (const secret of [asiaKey, whsec]) {
      const once = scrubber.scrub(`x ${secret} y`);
      expect(scrubber.scrub(once)).toBe(once);
    }
  });
});
