/**
 * Verification test: 1000+ entry scenario for the virtual-scroll viewport.
 *
 * Exercises EntryHeightCache, computeWindow, and scrollbarThumb with a large
 * entry count to confirm the virtual window system scales without the old
 * 500-entry cap.
 *
 * All functions tested here are pure — no Ink/React dependencies — so this
 * runs in <1ms and is fully deterministic.
 */
import { describe, expect, it } from 'vitest';
import { scrollOffsetForTrackRow, scrollbarThumb } from '../src/components/scrollable-history.js';
import { EntryHeightCache, computeWindow } from '../src/height-cache.js';

/** Fill a cache with N entries of uniform height. */
function filledCache(heights: number[]): EntryHeightCache {
  const c = new EntryHeightCache();
  heights.forEach((h, i) => {
    c.record(i + 1, h);
  });
  return c;
}

describe('1000+ entry virtual window — EntryHeightCache', () => {
  it('stores 1000 entries with correct total height', () => {
    const c = filledCache(Array.from({ length: 1000 }, () => 2));
    expect(c.size).toBe(1000);
    expect(c.totalHeight()).toBe(2000);
  });

  it('binary search resolves correct entry for any row offset (1000 entries)', () => {
    const c = filledCache(Array.from({ length: 1000 }, () => 3));
    // Row 0-2 → entry 0, row 3-5 → entry 1, ...
    expect(c.entryIndexAtOffset(0)).toBe(0);
    expect(c.entryIndexAtOffset(2)).toBe(0);
    expect(c.entryIndexAtOffset(3)).toBe(1);
    expect(c.entryIndexAtOffset(1500)).toBe(500); // row 1500 = start of entry 500
    expect(c.entryIndexAtOffset(2997)).toBe(999); // row 2997 = start of last entry
    expect(c.entryIndexAtOffset(3000)).toBe(1000); // past end
  });

  it('accumulatedHeight is accurate for any index (1000 entries)', () => {
    const c = filledCache(Array.from({ length: 1000 }, () => 4));
    expect(c.accumulatedHeight(0)).toBe(0);
    expect(c.accumulatedHeight(500)).toBe(2000); // 500 * 4
    expect(c.accumulatedHeight(1000)).toBe(4000); // total
  });

  it('updating entry heights preserves total accuracy', () => {
    const c = filledCache(Array.from({ length: 1000 }, () => 1));
    expect(c.totalHeight()).toBe(1000);
    // Update every entry to height 2
    for (let i = 1; i <= 1000; i++) c.record(i, 2);
    expect(c.totalHeight()).toBe(2000);
  });
});

describe('1000+ entry virtual window — computeWindow', () => {
  it('shows the last entries when pinned to bottom (1000 entries)', () => {
    const c = filledCache(Array.from({ length: 1000 }, () => 1));
    const r = computeWindow(1000, 30, 0, 1000, c);
    // Viewport top = 1000 - 30 - 0 = 970
    expect(r.startIdx).toBe(970);
    expect(r.endIdx).toBe(1000);
    expect(r.spacerAbove).toBe(0); // entry 970 starts exactly at row 970
    expect(r.spacerBelow).toBe(0);
    expect(r.windowed).toBe(true);
  });

  it('shows the first entries when scrolled to top (1000 entries)', () => {
    const c = filledCache(Array.from({ length: 1000 }, () => 1));
    const maxOffset = 1000 - 30; // 970
    const r = computeWindow(1000, 30, maxOffset, 1000, c);
    expect(r.startIdx).toBe(0);
    expect(r.spacerAbove).toBe(0);
    expect(r.spacerBelow).toBeGreaterThan(0);
    expect(r.windowed).toBe(true);
  });

  it('shows middle entries when scrolled halfway (1000 entries)', () => {
    const c = filledCache(Array.from({ length: 1000 }, () => 1));
    const halfOffset = Math.floor((1000 - 30) / 2); // ~485
    const r = computeWindow(1000, 30, halfOffset, 1000, c);
    // Viewport top = 1000 - 30 - 485 = 485
    expect(r.startIdx).toBe(485);
    // endIdx includes entries through scanTarget (viewportBottom + 8 buffer)
    expect(r.endIdx).toBeGreaterThanOrEqual(485);
    expect(r.endIdx).toBeLessThanOrEqual(1000);
    // spacerAbove is 0 because the first visible entry (485) starts
    // exactly at viewportTop (485). spacerBelow accounts for entries
    // after the render-ahead buffer. Entries before startIdx (0-484)
    // are not tracked in spacers — they're above the viewport.
    expect(r.spacerAbove).toBe(0);
    expect(r.spacerBelow).toBeGreaterThanOrEqual(0);
  });

  it('renders visible window of roughly viewport size (1000 entries)', () => {
    const c = filledCache(Array.from({ length: 1000 }, () => 1));
    const r = computeWindow(1000, 25, 0, 1000, c);
    // Visible entries count should be close to viewport rows
    const visibleCount = r.endIdx - r.startIdx;
    expect(visibleCount).toBeGreaterThanOrEqual(25);
    expect(visibleCount).toBeLessThanOrEqual(25 + 8); // MIN_WINDOW_ROWS buffer
  });

  it('maintains invariants at every 100th scroll offset (1000 entries)', () => {
    const c = filledCache(Array.from({ length: 1000 }, () => 2));
    const vp = 20;
    const maxOffset = 2000 - vp;
    for (let offset = 0; offset <= maxOffset; offset += 100) {
      const r = computeWindow(2000, vp, offset, 1000, c);
      expect(r.startIdx).toBeGreaterThanOrEqual(0);
      expect(r.endIdx).toBeLessThanOrEqual(1000);
      expect(r.startIdx).toBeLessThanOrEqual(r.endIdx);
      expect(r.spacerAbove).toBeGreaterThanOrEqual(0);
      expect(r.spacerBelow).toBeGreaterThanOrEqual(0);
      expect(r.totalHeight).toBe(2000);
      expect(r.windowed).toBe(true);
    }
  });
});

describe('1000+ entry virtual window — scrollbar integration', () => {
  it('produces a scrollable thumb at 1000 entries', () => {
    const vp = 30;
    const total = 3000; // 1000 entries × 3 rows each
    const { top, size, scrollable } = scrollbarThumb(vp, 0, total);
    expect(scrollable).toBe(true);
    expect(size).toBeGreaterThanOrEqual(1);
    expect(top + size).toBe(vp); // bottom-aligned when pinned
  });

  it('thumb covers the correct fraction at 1000 entries', () => {
    const vp = 20;
    const total = 2000;
    // viewport is 1% of content → thumb ≈ 1% of track
    const { size } = scrollbarThumb(vp, 0, total);
    expect(size).toBe(1); // 20/2000 * 20 = 0.2, rounded to 1
  });

  it('scrollOffsetForTrackRow is monotonic and never exceeds maxOffset (1000 entries)', () => {
    const vp = 25;
    const total = 5000;
    const maxOffset = total - vp;
    let prevRecovered = -1;
    for (let offset = 0; offset <= maxOffset; offset += 100) {
      const recovered = scrollOffsetForTrackRow(vp, total, scrollbarThumb(vp, offset, total).top);
      // Result must be in valid range
      expect(recovered).toBeGreaterThanOrEqual(0);
      expect(recovered).toBeLessThanOrEqual(maxOffset);
      // Must be monotonic: scrolling up (larger offset) never gives a smaller recovered value
      expect(recovered).toBeGreaterThanOrEqual(prevRecovered);
      prevRecovered = recovered;
    }
  });

  it('scrollbar covers oldest at top and newest at bottom (1000 entries)', () => {
    const vp = 15;
    const total = 15000; // 1000 entries × 15 rows
    const atNewest = scrollOffsetForTrackRow(vp, total, vp - 1);
    expect(atNewest).toBe(0);
    const atOldest = scrollOffsetForTrackRow(vp, total, 0);
    expect(atOldest).toBe(total - vp);
  });
});

describe('1000+ entry virtual window — end-to-end sequence', () => {
  it('handles continuous growth from 0 to 1000+ entries without degrading', () => {
    const cache = new EntryHeightCache();
    const viewport = 30;

    // Simulate growing from 0 to 1500 entries
    for (let n = 0; n <= 1500; n += 100) {
      if (n === 0) continue;

      // Record entries into the cache (simulating what ScrollableHistory does)
      for (let i = 1; i <= n; i++) {
        cache.record(i, 3); // 3 rows per entry
      }

      const total = cache.totalHeight();
      const vp = viewport;

      // Before cache data: fallback expected
      if (total <= 0) {
        expect(n).toBeLessThanOrEqual(0);
        continue;
      }

      // Test pinned-to-bottom state
      const rPinned = computeWindow(total, vp, 0, n, cache);
      expect(rPinned.windowed).toBe(total > vp);
      expect(rPinned.endIdx).toBe(n);

      // Test scrolled-to-top state
      const maxOffset = Math.max(0, total - vp);
      const rTop = computeWindow(total, vp, maxOffset, n, cache);
      expect(rTop.startIdx).toBe(0);

      // Test invariants
      expect(rPinned.startIdx).toBeLessThanOrEqual(rPinned.endIdx);
      expect(rPinned.spacerAbove).toBeGreaterThanOrEqual(0);
      expect(rPinned.spacerBelow).toBeGreaterThanOrEqual(0);
      expect(rTop.startIdx).toBeLessThanOrEqual(rTop.endIdx);
      expect(rTop.spacerAbove).toBeGreaterThanOrEqual(0);
      expect(rTop.spacerBelow).toBeGreaterThanOrEqual(0);
    }
  });

  it('window size stays bounded as entries grow from 500 to 2000', () => {
    const cache = new EntryHeightCache();
    const vp = 25;

    for (const count of [500, 1000, 1500, 2000]) {
      for (let i = 1; i <= count; i++) cache.record(i, 3);
      const total = count * 3;

      // compute at 3 scroll positions: bottom, middle, top
      const offsets = [0, Math.floor((total - vp) / 2), total - vp];
      for (const offset of offsets) {
        const r = computeWindow(total, vp, offset, count, cache);
        const windowHeight = r.endIdx - r.startIdx;
        // Window should be at least 1 entry and never exceed the entry count
        expect(windowHeight).toBeGreaterThanOrEqual(1);
        expect(windowHeight).toBeLessThanOrEqual(count);
        // At the top of content (offset = max), the window starts at 0
        if (offset === total - vp) {
          expect(r.startIdx).toBe(0);
        }
        // At the bottom of content (offset = 0), the window shows the last entries
        if (offset === 0) {
          expect(r.endIdx).toBe(count);
        }
        // Clean invariants
        expect(r.startIdx).toBeGreaterThanOrEqual(0);
        expect(r.endIdx).toBeLessThanOrEqual(count);
        expect(r.startIdx).toBeLessThanOrEqual(r.endIdx);
        expect(r.spacerAbove).toBeGreaterThanOrEqual(0);
        expect(r.spacerBelow).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
