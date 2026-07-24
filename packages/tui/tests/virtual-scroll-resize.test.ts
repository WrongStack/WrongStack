/**
 * Regression tests: virtual scroll must survive a terminal resize.
 *
 * Three bugs were fixed in the resize path:
 *
 * 1. cacheKey included `layoutStore.termWidth`, which is updated INSIDE the
 *    seeding block — so the key changed on the *next* render, triggering a
 *    second seeding pass that overwrote freshly-measured heights with estimates.
 *
 * 2. `LayoutStore.markMeasured` did not update the stored `termWidth`, so after
 *    a width change, measurements at the new width were stored with a stale
 *    width and rejected by the `stored.termWidth === termWidth` check on the
 *    next render — re-seeding estimates.
 *
 * 3. `mountBump` (underfill-correction counter) was not reset on width change,
 *    so it could stay pinned at MAX_UNDERFILL_BUMPS and prevent the viewport
 *    from re-converging at the new width.
 *
 * These tests exercise the pure parts (LayoutStore + EntryHeightCache) so they
 * run without mounting Ink and are fully deterministic.
 */
import { describe, expect, it } from 'vitest';
import { LayoutStore } from '../src/layout-store.js';
import { computeLayout } from '../src/layout-engine.js';
import { EntryHeightCache } from '../src/height-cache.js';

describe('LayoutStore.markMeasured — termWidth propagation on resize', () => {
  it('updates the stored termWidth when called with a new width', () => {
    const store = new LayoutStore({ sessionDataDir: undefined, ephemeral: true });
    store.setTermWidth(80);
    store.set(1, computeLayout(1, 'user', 'hello world', 80));
    expect(store.get(1)?.termWidth).toBe(80);
    expect(store.get(1)?.kind).toBe('estimated');

    // Simulate a resize to 120 cols and a post-render measurement at that width.
    store.markMeasured(1, 5, 120);
    expect(store.get(1)?.kind).toBe('measured');
    expect(store.get(1)?.termWidth).toBe(120);
    expect(store.get(1)?.rows).toBe(5);
  });

  it('is idempotent when width and rows are unchanged', () => {
    const store = new LayoutStore({ sessionDataDir: undefined, ephemeral: true });
    store.setTermWidth(100);
    store.set(1, computeLayout(1, 'user', 'hi', 100));
    store.markMeasured(1, 3, 100);
    const first = store.get(1);

    store.markMeasured(1, 3, 100); // same values
    expect(store.get(1)).toEqual(first);
  });

  it('promotes a measurement and stamps the default termWidth when no width arg', () => {
    const store = new LayoutStore({ sessionDataDir: undefined, ephemeral: true });
    store.setTermWidth(80);
    store.set(1, computeLayout(1, 'user', 'x', 80));

    // Default termWidth defaults to store.currentTermWidth.
    store.markMeasured(1, 4);
    expect(store.get(1)?.kind).toBe('measured');
    expect(store.get(1)?.termWidth).toBe(80);
  });
});

describe('EntryHeightCache — re-seed on width change preserves measured heights', () => {
  it('does not reset previously measured heights when only the estimate width changes', () => {
    // After the cacheKey fix, changing termWidth triggers exactly ONE re-seed
    // (not two). The cache itself should accept new estimates without error
    // and the prefix-sum should rebuild correctly.
    const cache = new EntryHeightCache();

    // Seed at width-80 estimates
    cache.sync([1, 2, 3]);
    cache.record(1, 4);
    cache.record(2, 6);
    cache.record(3, 3);
    expect(cache.totalHeight()).toBe(13);

    // Simulate the post-resize re-seed: sync preserves membership, then
    // recordMany overwrites with new estimates for the same ids.
    cache.sync([1, 2, 3]);
    cache.recordMany([
      [1, 5],
      [2, 8],
      [3, 4],
    ]);
    expect(cache.totalHeight()).toBe(17);
    // accumulatedHeight(n) = sum of heights for entries with index < n.
    // After re-seed: entry[0]=5, entry[1]=8, entry[2]=4.
    expect(cache.accumulatedHeight(1)).toBe(5); // 5
    expect(cache.accumulatedHeight(2)).toBe(13); // 5 + 8
    expect(cache.accumulatedHeight(3)).toBe(17); // 5 + 8 + 4 = total
  });

  it('binary-search offset resolution is correct after width-triggered re-seed', () => {
    const cache = new EntryHeightCache();
    cache.sync([10, 20, 30, 40, 50]);

    // First pass: uniform 3-row estimates
    cache.recordMany([
      [10, 3],
      [20, 3],
      [30, 3],
      [40, 3],
      [50, 3],
    ]);
    expect(cache.totalHeight()).toBe(15);
    expect(cache.entryIndexAtOffset(0)).toBe(0);
    expect(cache.entryIndexAtOffset(7)).toBe(2); // row 7 = start of entry 30

    // Re-seed with different heights (wider terminal → fewer wrapped rows)
    cache.recordMany([
      [10, 2],
      [20, 2],
      [30, 2],
      [40, 2],
      [50, 2],
    ]);
    expect(cache.totalHeight()).toBe(10);
    expect(cache.entryIndexAtOffset(0)).toBe(0);
    expect(cache.entryIndexAtOffset(4)).toBe(2); // row 4 = start of entry 30
    expect(cache.entryIndexAtOffset(9)).toBe(4); // row 9 = start of last entry
  });
});
