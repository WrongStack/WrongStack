import { describe, expect, it } from 'vitest';
import { parseForwardedEntry } from '../src/hq-server/client-address.js';

describe('parseForwardedEntry IPv4 port validation', () => {
  it('accepts numeric ports and rejects non-numeric or empty port suffixes', () => {
    expect(parseForwardedEntry('1.2.3.4:5678')).toBe('1.2.3.4');
    expect(parseForwardedEntry('1.2.3.4:notaport')).toBeUndefined();
    expect(parseForwardedEntry('1.2.3.4:')).toBeUndefined();
  });
});
