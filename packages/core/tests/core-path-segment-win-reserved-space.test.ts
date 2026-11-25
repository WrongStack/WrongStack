import { describe, expect, it } from 'vitest';
import { isSafePathSegment } from '../src/utils/path-segment.js';

describe('isSafePathSegment Windows reserved device name whitespace guard (F2290)', () => {
  it('rejects Windows reserved names with trailing whitespace', () => {
    expect(isSafePathSegment('CON ')).toBe(false);
    expect(isSafePathSegment('NUL.txt ')).toBe(false);
    expect(isSafePathSegment('valid-id')).toBe(true);
  });
});
