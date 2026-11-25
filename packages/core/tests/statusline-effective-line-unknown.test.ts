import { describe, expect, it } from 'vitest';
import { effectiveLine, type StatuslineItem } from '../src/statusline/index.js';

describe('effectiveLine unknown and prototype key guard (F2228)', () => {
  it('falls back to line 1 for unknown or Object.prototype chip keys', () => {
    expect(effectiveLine('nonexistent_chip' as StatuslineItem, undefined)).toBe(1);
    expect(effectiveLine('toString' as StatuslineItem, {})).toBe(1);
    expect(effectiveLine('state', undefined)).toBe(2);
  });
});
