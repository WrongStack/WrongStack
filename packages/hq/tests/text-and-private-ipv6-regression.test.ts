import { describe, expect, it } from 'vitest';
import { parseHqNotifyChannel, validateHqNotifyUrl } from '../src/notify-config.js';
import { scrubAndTruncateHqPreview } from '../src/redaction.js';

const hasLoneSurrogate = (value: string): boolean =>
  [...value].some((character) => character.length === 1 && /[\uD800-\uDFFF]/u.test(character));

describe('HQ bounded text and private endpoints', () => {
  it('keeps truncated previews well-formed', () => {
    expect(hasLoneSurrogate(scrubAndTruncateHqPreview('ab😀tail', 3) ?? '')).toBe(false);
  });

  it('keeps capped notification channel names well-formed', () => {
    const result = parseHqNotifyChannel(
      {
        name: `${'a'.repeat(79)}😀tail`,
        type: 'webhook',
        url: 'https://example.com/hook',
        kinds: ['alert'],
      },
      'demo',
    );
    expect(result.ok).toBe(true);
    expect(hasLoneSurrogate(result.ok ? result.channel.name : '')).toBe(false);
  });

  it('allows plain HTTP for IPv6 private-network endpoints', () => {
    expect(validateHqNotifyUrl('http://[fd12:3456::1]/hook').ok).toBe(true);
    expect(validateHqNotifyUrl('http://[fe80::1]/hook').ok).toBe(true);
    expect(validateHqNotifyUrl('http://[2001:db8::1]/hook').ok).toBe(false);
  });
});
