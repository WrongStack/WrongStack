import { describe, expect, it } from 'vitest';
import { isHqMobilePath } from '../src/mobile/route.js';

describe('HQ mobile route', () => {
  it.each(['/mobile', '/mobile/', '/mobile/session-1'])('selects mobile for %s', (pathname) => {
    expect(isHqMobilePath(pathname)).toBe(true);
  });

  it.each(['/', '/fleet', '/mobile-console', '/api/mobile'])('keeps desktop for %s', (pathname) => {
    expect(isHqMobilePath(pathname)).toBe(false);
  });
});
