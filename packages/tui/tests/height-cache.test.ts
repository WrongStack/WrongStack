import { describe, expect, it } from 'vitest';
import {
  EntryHeightCache,
  computeWindow,
} from '../src/height-cache.js';

// ─── EntryHeightCache ─────────────────────────────────────────────────

describe('EntryHeightCache', () => {
  it('starts empty with zero total height', () => {
    const c = new EntryHeightCache();
    expect(c.size).toBe(0);
    expect(c.totalHeight()).toBe(0);
    expect(c.getHeight(1)).toBeUndefined();
  });

  it('records a single entry height', () => {
    const c = new EntryHeightCache();
    c.record(1, 5);
    expect(c.size).toBe(1);
    expect(c.getHeight(1)).toBe(5);
    expect(c.totalHeight()).toBe(5);
  });

  it('records multiple entries in insertion order', () => {
    const c = new EntryHeightCache();
    c.record(1, 3);
    c.record(2, 5);
    c.record(3, 2);
    expect(c.size).toBe(3);
    expect(c.totalHeight()).toBe(10); // 3 + 5 + 2
  });

  it('returns accumulatedHeight for prefixes', () => {
    const c = new EntryHeightCache();
    c.record(10, 4);
    c.record(20, 6);
    c.record(30, 2);
    // indices: 0 → id=10, 1 → id=20, 2 → id=30
    expect(c.accumulatedHeight(0)).toBe(0);
    expect(c.accumulatedHeight(1)).toBe(4);  // entry 0
    expect(c.accumulatedHeight(2)).toBe(10); // entries 0+1
    expect(c.accumulatedHeight(3)).toBe(12); // entries 0+1+2
  });

  it('clamps accumulatedHeight beyond last entry to total', () => {
    const c = new EntryHeightCache();
    c.record(1, 7);
    expect(c.accumulatedHeight(99)).toBe(7);
  });

  it('updates existing entry height and rebuilds prefix', () => {
    const c = new EntryHeightCache();
    c.record(1, 3);
    c.record(2, 5);
    expect(c.totalHeight()).toBe(8);

    c.record(1, 10); // update entry 1
    expect(c.size).toBe(2); // same number of entries
    expect(c.getHeight(1)).toBe(10);
    expect(c.totalHeight()).toBe(15); // 10 + 5
    expect(c.accumulatedHeight(1)).toBe(10); // start of entry 2
  });

  it('returns false from record when height is unchanged', () => {
    const c = new EntryHeightCache();
    expect(c.record(1, 4)).toBe(true);
    expect(c.record(1, 4)).toBe(false); // same height
  });

  it('returns false from record for non-finite or negative heights', () => {
    const c = new EntryHeightCache();
    expect(c.record(1, Infinity)).toBe(false);
    expect(c.record(2, NaN)).toBe(false);
    expect(c.record(3, -5)).toBe(false);
    expect(c.size).toBe(0);
  });

  it('clamps height to minimum of 1 row', () => {
    const c = new EntryHeightCache();
    c.record(1, 0);
    expect(c.getHeight(1)).toBe(1);
    c.record(2, 0.3);
    expect(c.getHeight(2)).toBe(1);
  });

  it('rounds fractional heights', () => {
    const c = new EntryHeightCache();
    c.record(1, 3.7);
    expect(c.getHeight(1)).toBe(4);
    c.record(2, 1.2);
    expect(c.getHeight(2)).toBe(1);
  });

  it('clears all state', () => {
    const c = new EntryHeightCache();
    c.record(1, 5);
    c.record(2, 3);
    expect(c.size).toBe(2);
    c.clear();
    expect(c.size).toBe(0);
    expect(c.totalHeight()).toBe(0);
    expect(c.getHeight(1)).toBeUndefined();
  });

  describe('entryIndexAtOffset', () => {
    it('returns 0 for empty cache', () => {
      const c = new EntryHeightCache();
      expect(c.entryIndexAtOffset(0)).toBe(0);
      expect(c.entryIndexAtOffset(100)).toBe(0);
    });

    it('returns 0 for offset at or before first entry', () => {
      const c = new EntryHeightCache();
      c.record(1, 5);
      c.record(2, 3);
      expect(c.entryIndexAtOffset(0)).toBe(0);
      expect(c.entryIndexAtOffset(2)).toBe(0);
    });

    it('finds the correct entry index for a given row offset', () => {
      const c = new EntryHeightCache();
      // Entry 0: 4 rows, Entry 1: 6 rows, Entry 2: 2 rows
      c.record(10, 4);
      c.record(20, 6);
      c.record(30, 2);
      // Row offsets: 0-3 → entry 0, 4-9 → entry 1, 10-11 → entry 2
      expect(c.entryIndexAtOffset(0)).toBe(0);
      expect(c.entryIndexAtOffset(3)).toBe(0);
      expect(c.entryIndexAtOffset(4)).toBe(1);
      expect(c.entryIndexAtOffset(5)).toBe(1);
      expect(c.entryIndexAtOffset(9)).toBe(1);
      expect(c.entryIndexAtOffset(10)).toBe(2);
      expect(c.entryIndexAtOffset(11)).toBe(2);
    });

    it('returns last index + 1 for offsets past total height', () => {
      const c = new EntryHeightCache();
      c.record(1, 5);
      expect(c.entryIndexAtOffset(5)).toBe(1);
      expect(c.entryIndexAtOffset(100)).toBe(1);
    });
  });
});

// ─── computeWindow ────────────────────────────────────────────────────

function filledCache(heights: number[]): EntryHeightCache {
  const c = new EntryHeightCache();
  heights.forEach((h, i) => {
    c.record(i + 1, h);
  });
  return c;
}

describe('computeWindow', () => {
  it('returns empty window for zero content', () => {
    const c = new EntryHeightCache();
    const r = computeWindow(0, 20, 0, 0, c);
    expect(r.startIdx).toBe(0);
    expect(r.endIdx).toBe(0);
    expect(r.totalHeight).toBe(0);
    expect(r.windowed).toBe(false);
  });

  it('renders all entries when total fits viewport', () => {
    const c = filledCache([4, 3, 5]); // 12 rows total
    const r = computeWindow(12, 20, 0, 3, c);
    expect(r.startIdx).toBe(0);
    expect(r.endIdx).toBe(3);
    expect(r.spacerAbove).toBe(0);
    expect(r.spacerBelow).toBe(0);
    expect(r.windowed).toBe(false);
  });

  it('shows last entries when pinned to bottom (offset 0)', () => {
    // 20 entries, each 1 row. Viewport 10 rows. Total 20 rows.
    const heights = Array.from({ length: 20 }, () => 1);
    const c = filledCache(heights);
    const r = computeWindow(20, 10, 0, 20, c);
    // Viewport top = 20 - 10 - 0 = 10, so entry 10 starts exactly at
    // the viewport top (row 10). spacerAbove = 0 because there's no
    // partial entry above the viewport.
    expect(r.startIdx).toBe(10);
    expect(r.endIdx).toBe(20); // includes the tail
    expect(r.spacerAbove).toBe(0); // first visible entry aligns exactly
    expect(r.spacerBelow).toBe(0); // pinned to bottom
    expect(r.totalHeight).toBe(20);
    expect(r.windowed).toBe(true);
  });

  it('shows first entries when scrolled to top', () => {
    const heights = Array.from({ length: 20 }, () => 1);
    const c = filledCache(heights);
    // Max offset = 20 - 10 = 10.
    const r = computeWindow(20, 10, 10, 20, c);
    expect(r.startIdx).toBe(0);
    expect(r.spacerAbove).toBe(0); // at top
    expect(r.spacerBelow).toBeGreaterThan(0);
  });

  it('reserves MIN_WINDOW_ROWS below the visible area', () => {
    // 5 entries, each 1 row. Viewport 3 rows. Total 5 rows.
    const c = filledCache([1, 1, 1, 1, 1]);
    const r = computeWindow(5, 3, 0, 5, c);
    // Viewport top = 5 - 3 - 0 = 2. Window walks to 2 + 3 + 8 = 13 rows
    // which is past total 5, so endIdx = 5.
    expect(r.endIdx).toBe(5);
  });

  it('reports windowed=true when content exceeds viewport', () => {
    const c = filledCache(Array.from({ length: 100 }, () => 1));
    const r = computeWindow(100, 10, 0, 100, c);
    expect(r.windowed).toBe(true);
    expect(r.totalHeight).toBe(100);
  });

  it('produces valid window for every scroll offset (property test)', () => {
    const rowCount = 50;
    const heights = Array.from({ length: rowCount }, () => 1);
    const c = filledCache(heights);
    const vp = 10;
    const maxOffset = rowCount - vp;

    for (let offset = 0; offset <= maxOffset; offset++) {
      const r = computeWindow(rowCount, vp, offset, rowCount, c);
      // Invariants for every offset
      expect(r.startIdx).toBeGreaterThanOrEqual(0);
      expect(r.endIdx).toBeLessThanOrEqual(rowCount);
      expect(r.startIdx).toBeLessThanOrEqual(r.endIdx);
      expect(r.spacerAbove).toBeGreaterThanOrEqual(0);
      expect(r.spacerBelow).toBeGreaterThanOrEqual(0);
      expect(r.totalHeight).toBe(rowCount);
      expect(r.windowed).toBe(true);
    }
  });

  it('handles variable-height entries correctly', () => {
    // Entries: [5 rows, 2 rows, 8 rows, 3 rows, 4 rows] = 22 total
    const c = filledCache([5, 2, 8, 3, 4]);
    const r = computeWindow(22, 6, 0, 5, c);
    // Viewport top = 22 - 6 - 0 = 16. Entry 3 starts at row 15, entry 4
    // starts at row 18. So startIdx should be 3 (entry at row 15-17).
    expect(r.startIdx).toBe(3);
    expect(r.endIdx).toBe(5); // all remaining
    expect(r.spacerAbove).toBe(1); // 16 - 15 = 1 row of partial visibility
  });
});
