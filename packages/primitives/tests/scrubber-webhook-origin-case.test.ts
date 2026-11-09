import { describe, expect, it } from 'vitest';
import { DefaultSecretScrubber } from '../src/secret-scrubber.js';

const token = 'Q'.repeat(24);
const path = `/services/Tfixture/Bfixture/${token}`;
const canonical = `https://hooks.slack.com${path}`;
const replacement = '[REDACTED:slack_webhook]';

describe('Slack webhook scheme and hostname casing', () => {
  it.each(['HTTPS://HOOKS.SLACK.COM', 'https://Hooks.Slack.Com', 'HtTpS://hOoKs.sLaCk.CoM'])(
    'redacts the equivalent origin %s',
    (origin) => {
      const input = origin + path;
      expect(new URL(input).href).toBe(new URL(canonical).href);
      const scrubber = new DefaultSecretScrubber();
      expect(scrubber.scrub(input)).toBe(replacement);
      expect(scrubber.scrub(scrubber.scrub(input))).toBe(replacement);
    },
  );

  it('retains canonical-origin handling', () => {
    expect(new DefaultSecretScrubber().scrub(canonical)).toBe(replacement);
  });

  it.each(['copy', 'shared'])('protects object fields through %s scrubbing', (mode) => {
    const input = { webhookUrl: `HTTPS://HOOKS.SLACK.COM${path}`, note: 'kept' };
    const before = { ...input };
    const scrubber = new DefaultSecretScrubber();
    const result =
      mode === 'copy' ? scrubber.scrubObject(input) : scrubber.scrubObjectShared(input);
    expect(result).toEqual({ webhookUrl: replacement, note: 'kept' });
    expect(input).toEqual(before);
  });

  it.each([
    `https://hooks.slack.com.evil${path}`,
    `https://hooks.slack.com/Services/Tfixture/Bfixture/${token}`,
    `https://hooks.slack.com/services/tfixture/Bfixture/${token}`,
  ])('does not fold path components or admit lookalike hosts in %s', (input) => {
    expect(new DefaultSecretScrubber().scrub(input)).toBe(input);
  });

  it('preserves surrounding diagnostic text', () => {
    const input = `Failed to call HTTPS://HOOKS.SLACK.COM${path} after retry`;
    expect(new DefaultSecretScrubber().scrub(input)).toBe(
      `Failed to call ${replacement} after retry`,
    );
  });
});
