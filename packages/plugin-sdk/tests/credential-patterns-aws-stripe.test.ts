import { describe, expect, it } from 'vitest';
import { cloneCredentialPatterns } from '../src/runtime/credential-patterns.js';

/**
 * F101: the plugin-sdk credential table knew only AKIA for AWS and only
 * sk_/rk_ for Stripe — the same gap closed in the primitives scrubber (F85),
 * skill scanner (F86), sage gate (F87) and AST scan (F88). ASIA STS temporary
 * credentials (identical 20-char shape) and whsec_ webhook signing secrets
 * (forged-event authority) passed plugin-surface detection unreported.
 */
function matches(type: string, text: string): boolean {
  const pattern = cloneCredentialPatterns().find((p) => p.type === type);
  if (!pattern) return false;
  pattern.regex.lastIndex = 0;
  return pattern.regex.test(text);
}

const asiaKey = `ASIA${'Q'.repeat(16)}`;
const akiaKey = `AKIA${'Q'.repeat(16)}`;
const whsec = `whsec_${'a'.repeat(32)}`;

describe('plugin-sdk credential coverage (F101)', () => {
  it('detects an ASIA temporary access key', () => {
    expect(matches('aws_access_key', `key=${asiaKey}`)).toBe(true);
  });

  it('still detects AKIA long-term keys (control)', () => {
    expect(matches('aws_access_key', akiaKey)).toBe(true);
  });

  it('detects a whsec_ webhook signing secret', () => {
    expect(matches('stripe_webhook_secret', `secret=${whsec}`)).toBe(true);
  });

  it('still detects sk_live secret keys (control)', () => {
    expect(matches('stripe_key', `sk_live_${'b'.repeat(24)}`)).toBe(true);
  });

  it('does not detect a too-short ASIA lookalike (control)', () => {
    expect(matches('aws_access_key', `ASIA${'Q'.repeat(15)}`)).toBe(false);
  });
});
