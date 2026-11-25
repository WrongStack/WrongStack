import { describe, expect, it } from 'vitest';
import {
  scrollbarThumb,
  scrollOffsetForTrackRow,
} from '../src/components/history/scrollbar-geometry.js';

describe('scrollbar-geometry non-finite guards', () => {
  it('returns finite thumb and track offset when offset or cell is NaN', () => {
    const thumb = scrollbarThumb(10, Number.NaN, 50);
    expect(Number.isFinite(thumb.top)).toBe(true);
    expect(Number.isFinite(thumb.size)).toBe(true);
    expect(Number.isFinite(scrollOffsetForTrackRow(10, 50, Number.NaN))).toBe(true);
  });
});
