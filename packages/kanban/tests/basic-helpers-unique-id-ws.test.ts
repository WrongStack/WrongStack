import { describe, expect, it } from 'vitest';
import { uniqueIdFromSet } from '../src/manager/basic-helpers.js';

describe('uniqueIdFromSet whitespace handling (F1984)', () => {
  it('falls back to item for whitespace-only IDs and trims valid IDs', () => {
    const used = new Set<string>();
    expect(uniqueIdFromSet(used, '   ')).toBe('item');
    expect(uniqueIdFromSet(used, '  foo  ')).toBe('foo');
  });
});
