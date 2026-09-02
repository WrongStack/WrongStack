import { describe, expect, it } from 'vitest';
import { EntryHeightCache, computeWindow } from '../src/height-cache.js';

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
    expect(c.totalHeight()).toBe(10);
  });

  it('returns accumulatedHeight for prefixes', () => {
    const c = new EntryHeightCache();
    c.record(10, 4);
    c.record(20, 6);
    c.record(30, 2);
    expect(c.accumulatedHeight(0)).toBe(0);
    expect(c.accumulatedHeight(1)).toBe(4);
    expect(c.accumulatedHeight(2)).toBe(10);
    expect(c.accumulatedHeight(3)).toBe(12);
  });

  it('clamps accumulatedHeight beyond last entry to total', () => {
    const c = new EntryHeightCache();
    c.record(1, 7);
    expect(c.accumulatedHeight(99)).toBe(7);
    expect(c.accumulatedHeight(5)).toBe(7);
  });

  it('updates existing entry height and rebuilds prefix', () => {
    const c = new EntryHeightCache();
    c.record(1, 3);
    c.record(2, 5);
    expect(c.totalHeight()).toBe(8);
    c.record(1, 10);
    expect(c.size).toBe(2);
    expect(c.getHeight(1)).toBe(10);
    expect(c.totalHeight()).toBe(15);
    expect(c.accumulatedHeight(1)).toBe(10);
  });

  it('returns false from record when height is unchanged', () => {
    const c = new EntryHeightCache();
    expect(c.record(1, 4)).toBe(true);
    expect(c.record(1, 4)).toBe(false);
  });

  it('returns false from record for non-finite or negative heights', () => {
    const c = new EntryHeightCache();
    expect(c.record(1, Infinity)).toBe(false);
    expect(c.record(2, NaN)).toBe(false);
    expect(c.record(3, -5)).toBe(false);
    expect(c.size).toBe(0);
  });

  it('stores zero heights (hidden entries render no rows)', () => {
    const c = new EntryHeightCache();
    c.record(1, 0);
    expect(c.getHeight(1)).toBe(0);
    c.record(2, 0.3);
    expect(c.getHeight(2)).toBe(0);
  });

  it('rounds fractional heights', () => {
    const c = new EntryHeightCache();
    c.record(1, 3.7);
    expect(c.getHeight(1)).toBe(4);
    c.record(2, 1.2);
    expect(c.getHeight(2)).toBe(1);
  });

  it('rounds height of exactly 0.5 to 1', () => {
    const c = new EntryHeightCache();
    c.record(1, 0.5);
    expect(c.getHeight(1)).toBe(1);
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
    it('returns 0 for empty cache and any offset', () => {
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
      c.record(10, 4);
      c.record(20, 6);
      c.record(30, 2);
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

  describe('retain', () => {
    it('removes entries not in retained set', () => {
      const c = new EntryHeightCache();
      c.record(1, 5);
      c.record(2, 3);
      c.record(3, 7);
      c.retain([1, 3]);
      expect(c.size).toBe(2);
      expect(c.getHeight(1)).toBe(5);
      expect(c.getHeight(2)).toBeUndefined();
      expect(c.getHeight(3)).toBe(7);
    });

    it('does nothing when ids match current order exactly', () => {
      const c = new EntryHeightCache();
      c.record(1, 5);
      c.record(2, 3);
      const totalBefore = c.totalHeight();
      c.retain([1, 2]);
      expect(c.size).toBe(2);
      expect(c.totalHeight()).toBe(totalBefore);
    });

    it('reorders prefix when ids change order', () => {
      const c = new EntryHeightCache();
      c.record(1, 5);
      c.record(2, 3);
      c.retain([2, 1]);
      // After retain, order should be [2, 1]
      expect(c.accumulatedHeight(0)).toBe(0);
      expect(c.accumulatedHeight(1)).toBe(3); // entry 2
      expect(c.accumulatedHeight(2)).toBe(8); // entry 2 + entry 1
    });

    it('handles empty ids gracefully - clears everything', () => {
      const c = new EntryHeightCache();
      c.record(1, 5);
      c.record(2, 3);
      c.retain([]);
      expect(c.size).toBe(0);
      expect(c.totalHeight()).toBe(0);
    });

    it('removes heights for ids not in entryIds', () => {
      const c = new EntryHeightCache();
      c.record(10, 4);
      c.record(20, 6);
      c.record(30, 2);
      const changed = c.retain([10, 30, 40]); // 40 not in heights
      void changed;
      // 20 removed, 40 not in heights so filtered out
      expect(c.size).toBe(2);
      expect(c.getHeight(10)).toBe(4);
      expect(c.getHeight(20)).toBeUndefined();
      expect(c.getHeight(30)).toBe(2);
    });
  });

  describe('sync', () => {
    it('rebuilds prefix from estimates for new ids', () => {
      const c = new EntryHeightCache();
      c.sync([10, 20, 30], 4);
      expect(c.size).toBe(3);
      expect(c.totalHeight()).toBe(12); // 4 + 4 + 4
      expect(c.accumulatedHeight(1)).toBe(4);
      expect(c.accumulatedHeight(2)).toBe(8);
    });

    it('preserves previously-measured heights for retained ids', () => {
      const c = new EntryHeightCache();
      c.record(1, 5);
      c.record(2, 3);
      c.sync([1, 2, 3], 2);
      expect(c.getHeight(1)).toBe(5); // preserved from earlier measurement
      expect(c.getHeight(2)).toBe(3); // preserved from earlier measurement
      expect(c.getHeight(3)).toBe(2); // seeded with estimate
      expect(c.totalHeight()).toBe(10); // 5 + 3 + 2
    });

    it('replaces ids order and repositions prefix', () => {
      const c = new EntryHeightCache();
      c.record(1, 5);
      c.record(2, 3);
      c.sync([2, 1]);
      expect(c.accumulatedHeight(0)).toBe(0);
      expect(c.accumulatedHeight(1)).toBe(3); // entry 2
      expect(c.accumulatedHeight(2)).toBe(8); // entry 2 + entry 1
    });

    it('handles empty entryIds — clears everything', () => {
      const c = new EntryHeightCache();
      c.record(1, 5);
      c.record(2, 3);
      c.sync([]);
      expect(c.size).toBe(0);
      expect(c.totalHeight()).toBe(0);
      expect(c.getHeight(1)).toBeUndefined();
    });

    it('returns false on identical repeated input', () => {
      const c = new EntryHeightCache();
      c.record(1, 5);
      c.record(2, 3);
      expect(c.sync([1, 2])).toBe(false);
    });

    it('returns true when ids change even if height contents match', () => {
      const c = new EntryHeightCache();
      c.record(1, 5);
      c.record(2, 3);
      expect(c.sync([2, 1])).toBe(true);
    });
  });

  describe('recordMany', () => {
    it('short-circuits on no-change rows', () => {
      const c = new EntryHeightCache();
      c.sync([1, 2, 3], 4);
      // All rows already at the estimated height (4).
      expect(
        c.recordMany([
          [1, 4],
          [2, 4],
          [3, 4],
        ]),
      ).toBe(false);
      expect(c.size).toBe(3);
      expect(c.totalHeight()).toBe(12);
    });

    it('returns true when at least one row changes', () => {
      const c = new EntryHeightCache();
      c.sync([1, 2], 4);
      expect(
        c.recordMany([
          [1, 6],
          [2, 4],
        ]),
      ).toBe(true);
      expect(c.totalHeight()).toBe(10); // 6 + 4
    });

    it('clamps and filters non-finite or negative heights silently', () => {
      const c = new EntryHeightCache();
      c.sync([1, 2, 3], 4);
      expect(
        c.recordMany([
          [1, Infinity],
          [2, NaN],
          [3, -5],
        ]),
      ).toBe(false);
      expect(c.getHeight(1)).toBe(4); // unchanged
      expect(c.getHeight(2)).toBe(4); // unchanged
      expect(c.getHeight(3)).toBe(4); // unchanged
    });

    it('throws RangeError for unknown ids — call sync() first', () => {
      const c = new EntryHeightCache();
      c.sync([10, 20], 3);
      expect(() =>
        c.recordMany([
          [30, 5],
          [40, 2],
        ]),
      ).toThrow(RangeError);
    });
  });
});

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

  it('returns empty window when entryCount is 0', () => {
    const c = new EntryHeightCache();
    c.record(1, 4); // Some data but zero entryCount
    const r = computeWindow(4, 20, 0, 0, c);
    expect(r.startIdx).toBe(0);
    expect(r.endIdx).toBe(0);
    expect(r.totalHeight).toBe(0);
    expect(r.windowed).toBe(false);
  });

  it('renders all entries when total fits viewport', () => {
    const c = filledCache([4, 3, 5]);
    const r = computeWindow(12, 20, 0, 3, c);
    expect(r.startIdx).toBe(0);
    expect(r.endIdx).toBe(3);
    expect(r.spacerAbove).toBe(0);
    expect(r.spacerBelow).toBe(0);
    expect(r.windowed).toBe(false);
  });

  it('shows last entries when pinned to bottom (offset 0)', () => {
    const heights = Array.from({ length: 20 }, () => 1);
    const c = filledCache(heights);
    const r = computeWindow(20, 10, 0, 20, c);
    expect(r.startIdx).toBe(10);
    expect(r.endIdx).toBe(20);
    expect(r.spacerAbove).toBe(0);
    expect(r.spacerBelow).toBe(0);
    expect(r.totalHeight).toBe(20);
    expect(r.windowed).toBe(true);
  });

  it('shows first entries when scrolled to top', () => {
    const heights = Array.from({ length: 20 }, () => 1);
    const c = filledCache(heights);
    const r = computeWindow(20, 10, 10, 20, c);
    expect(r.startIdx).toBe(0);
    expect(r.spacerAbove).toBe(0);
    expect(r.spacerBelow).toBeGreaterThan(0);
  });

  it('reserves MIN_WINDOW_ROWS below the visible area', () => {
    const c = filledCache([1, 1, 1, 1, 1]);
    const r = computeWindow(5, 3, 0, 5, c);
    expect(r.endIdx).toBe(5);
  });

  it('reports windowed=true when content exceeds viewport', () => {
    const c = filledCache(Array.from({ length: 100 }, () => 1));
    const r = computeWindow(100, 10, 0, 100, c);
    expect(r.windowed).toBe(true);
    expect(r.totalHeight).toBe(100);
  });

  it('produces valid window for every scroll offset', () => {
    const rowCount = 50;
    const heights = Array.from({ length: rowCount }, () => 1);
    const c = filledCache(heights);
    const vp = 10;
    const maxOffset = rowCount - vp;
    for (let offset = 0; offset <= maxOffset; offset++) {
      const r = computeWindow(rowCount, vp, offset, rowCount, c);
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
    const c = filledCache([5, 2, 8, 3, 4]);
    const r = computeWindow(22, 6, 0, 5, c);
    expect(r.startIdx).toBe(3);
    expect(r.endIdx).toBe(5);
    expect(r.spacerAbove).toBe(1);
  });

  it('handles negative scrollOffset by clamping viewportTop', () => {
    const c = filledCache([5, 5, 5]);
    const r = computeWindow(15, 10, -5, 3, c);
    // viewportTop = max(0, 15 - 10 - (-5)) = max(0, 10) = 10
    expect(r.startIdx).toBe(2);
    expect(r.windowed).toBe(true);
  });

  it('handles large scrollOffset that exceeds totalHeight - viewportRows', () => {
    const c = filledCache([5, 5]);
    const r = computeWindow(10, 5, 100, 2, c);
    // viewportTop = max(0, 10 - 5 - 100) = max(0, -95) = 0
    expect(r.startIdx).toBe(0);
    expect(r.endIdx).toBe(2);
  });
});
