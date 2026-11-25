import { describe, expect, it } from 'vitest';
import { later } from '../src/manager/recovery.js';

describe('later invalid timestamp handling', () => {
  it('prefers the valid timestamp when the other is unparseable', () => {
    const valid = '2026-11-25T10:00:00Z';
    expect(later(valid, 'not-a-date')).toBe(valid);
    expect(later('not-a-date', valid)).toBe(valid);
  });
});
