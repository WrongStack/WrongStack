/**
 * Pure geometry helpers for the managed history viewport.
 *
 * The component owns one absolute viewport-top row for wheel, page, and
 * scrollbar input. These helpers translate that coordinate into a temporary
 * {@link ScrollAnchor}: the render-group containing the row plus the number
 * of rows clipped inside it. Rendering begins at that anchor, with no spacer
 * elements.
 *
 * `null` means "pinned to the newest output" (follow mode). Pinned rendering
 * uses `justifyContent:'flex-end'` and needs no position math at all.
 *
 * Prefix sums over the {@link EntryHeightCache} translate absolute rows to
 * mounted groups and size the scrollbar. When a measurement corrects those
 * sums, the component resolves the same absolute row again instead of letting
 * separate anchor/offset/thumb states drift apart.
 *
 * Pure TypeScript — no React, no Ink. Unit-testable without mounting anything.
 */

import type { EntryHeightCache } from './height-cache.js';

/** Scroll position of the managed viewport. */
export interface ScrollAnchor {
  /** Index (into the render-group array) of the group at the viewport top. */
  index: number;
  /** Rows of that group clipped above the viewport top. Always >= 0 and less
   *  than the group's height (self-heals via clamping when heights change). */
  clip: number;
}

/** Everything the pure scroll math needs to know about current geometry. */
export interface ScrollGeometry {
  /** Height cache whose prefix sums cover exactly the render groups. */
  cache: EntryHeightCache;
  /** Number of render groups (must equal the cache's synced id count). */
  groupCount: number;
  /** Viewport height in rows (>= 1). */
  viewportRows: number;
  /** Fixed-height live tail rendered after the last group (0 when absent). */
  tailRows: number;
}

/** Extra rows mounted beyond the visible viewport so rapid scrolling has
 *  content ready before the next measurement pass. */
const OVERSCAN_ROWS = 8;

/** Total scrollable content height in rows (groups + live tail). */
export function contentRows(geometry: ScrollGeometry): number {
  return geometry.cache.totalHeight() + geometry.tailRows;
}

/** Highest legal viewport-top row. 0 when everything fits in the viewport. */
export function maxTopRow(geometry: ScrollGeometry): number {
  return Math.max(0, contentRows(geometry) - Math.max(1, geometry.viewportRows));
}

/**
 * Absolute content row of the viewport top implied by an anchor, clamped to
 * the legal range. `null` (pinned) maps to {@link maxTopRow}.
 */
export function anchorTopRow(geometry: ScrollGeometry, anchor: ScrollAnchor | null): number {
  const max = maxTopRow(geometry);
  if (anchor === null) return max;
  const raw = geometry.cache.accumulatedHeight(anchor.index) + Math.max(0, anchor.clip);
  return Math.max(0, Math.min(max, raw));
}

/**
 * Anchor for an absolute viewport-top row. Returns `null` (pinned) when the
 * row is at or past the bottom-most position. The returned anchor always
 * points inside a real group: a top row landing inside the tail suffix is
 * clamped back onto the last group.
 */
export function anchorAtTopRow(geometry: ScrollGeometry, topRow: number): ScrollAnchor | null {
  const max = maxTopRow(geometry);
  if (max <= 0) return null;
  const clamped = Math.max(0, Math.min(max, Math.round(topRow)));
  if (clamped >= max) return null;
  const { cache, groupCount } = geometry;
  if (groupCount <= 0) return null;
  const index = Math.min(groupCount - 1, cache.entryIndexAtOffset(clamped));
  const clip = Math.max(0, clamped - cache.accumulatedHeight(index));
  return { index, clip };
}

/**
 * Move the viewport by `deltaUp` rows (positive scrolls toward older content,
 * negative toward newer). From pinned, positive deltas un-pin; reaching the
 * bottom returns `null` (re-pin).
 */
export function scrollAnchorBy(
  geometry: ScrollGeometry,
  current: ScrollAnchor | null,
  deltaUp: number,
): ScrollAnchor | null {
  return anchorAtTopRow(geometry, anchorTopRow(geometry, current) - deltaUp);
}

/** Anchor for the very top of the transcript (or `null` when it all fits). */
export function scrollAnchorToTop(geometry: ScrollGeometry): ScrollAnchor | null {
  return anchorAtTopRow(geometry, 0);
}

/** Rows moved by one PageUp/PageDown press. */
export function pageRows(viewportRows: number): number {
  return Math.max(1, viewportRows - 1);
}

/**
 * Anchor for a 0-based cell clicked on a scrollbar track of `viewportRows`
 * height: cell 0 → oldest content, the last cell → pinned to newest.
 */
export function anchorForTrackCell(geometry: ScrollGeometry, cell: number): ScrollAnchor | null {
  const rows = Math.max(1, geometry.viewportRows);
  const max = maxTopRow(geometry);
  if (max <= 0) return null;
  const clampedCell = Math.max(0, Math.min(rows - 1, cell));
  const topRow = Math.round((clampedCell / Math.max(1, rows - 1)) * max);
  return anchorAtTopRow(geometry, topRow);
}

/** Result of planning which groups to mount for one frame. */
interface MountPlan {
  /** First group index to mount (inclusive). */
  startIdx: number;
  /** Last group index to mount (exclusive). */
  endIdx: number;
  /** Whether the live tail should be mounted after the groups. */
  mountTail: boolean;
}

/**
 * Plan the mounted window for a scrolled viewport: from the anchor downward
 * until the (estimated or measured) heights cover the anchor clip, the
 * viewport, the overscan, and `extraRows` of underfill correction. Estimates
 * only ever decide HOW MANY groups to mount — mounting too many is harmless
 * (the viewport clips them), and mounting too few is corrected by the
 * measurement pass bumping `extraRows`.
 */
export function planFromAnchor(
  geometry: ScrollGeometry,
  anchor: ScrollAnchor,
  extraRows = 0,
): MountPlan {
  const { cache, groupCount } = geometry;
  const startIdx = Math.max(0, Math.min(groupCount - 1, anchor.index));
  const needed =
    Math.max(0, anchor.clip) + Math.max(1, geometry.viewportRows) + OVERSCAN_ROWS + extraRows;
  const startTop = cache.accumulatedHeight(startIdx);
  let endIdx = startIdx;
  while (endIdx < groupCount && cache.accumulatedHeight(endIdx + 1) - startTop < needed) {
    endIdx++;
  }
  endIdx = Math.min(groupCount, endIdx + 1);
  // Floor: estimate the rows needed and convert to a row-budget group count
  // using the average per-group height already in the cache. Without this,
  // height estimates can be arbitrarily larger than real markdown layout
  // (e.g. runs of blank source lines collapse during rendering), and a
  // group-count floor would over-mount a transcript with many multi-row
  // entries (tool results, large code fences) by `viewportRows` groups when
  // only a handful of real rows are missing. A row-budget floor using the
  // mean of the already-mounted groups keeps the mount count correct in the
  // multi-row case while still guarding the collapsed-estimate underfill.
  if (endIdx > startIdx) {
    const coveredRows = cache.accumulatedHeight(endIdx) - startTop;
    const mountedCount = endIdx - startIdx;
    const avgRowsPerGroup = coveredRows > 0 ? coveredRows / mountedCount : 1;
    const rowBudgetCount = Math.max(1, Math.ceil(needed / Math.max(1, avgRowsPerGroup)));
    endIdx = Math.max(endIdx, Math.min(groupCount, startIdx + rowBudgetCount));
  } else {
    // No groups accumulated beyond the first one (its estimated height
    // already meets `needed`). Use the cache-wide average per-group height
    // for the floor instead of a raw group count so multi-row entries (tool
    // results, large code fences) do not over-mount by many groups when only
    // a few real rows are missing.
    const totalH = cache.totalHeight();
    const avgAll = groupCount > 0 && totalH > 0 ? totalH / groupCount : 1;
    const rowBudgetCount = Math.max(1, Math.ceil(needed / Math.max(1, avgAll)));
    endIdx = Math.max(endIdx, Math.min(groupCount, startIdx + rowBudgetCount));
  }
  return { startIdx, endIdx, mountTail: endIdx >= groupCount };
}

/**
 * Plan the mounted window for the pinned viewport: from the bottom upward
 * until the heights cover the viewport (minus the always-mounted tail) plus
 * overscan and correction. Overfill is clipped from the top by
 * `justifyContent:'flex-end'`, so generosity is safe.
 */
export function planPinned(geometry: ScrollGeometry, extraRows = 0): MountPlan {
  const { cache, groupCount } = geometry;
  const needed = Math.max(
    1,
    Math.max(1, geometry.viewportRows) + OVERSCAN_ROWS + extraRows - geometry.tailRows,
  );
  const total = cache.totalHeight();
  // Rows covered by groups [startIdx, groupCount) = total - accum(startIdx).
  let startIdx = groupCount;
  while (startIdx > 0 && total - cache.accumulatedHeight(startIdx) < needed) {
    startIdx--;
  }
  if (startIdx > 0) startIdx--;
  // Row-budget mirror of planFromAnchor's floor: convert `needed` rows back
  // into a group count using the average row size across the trailing
  // mounted range so multi-row groups don't pull in `viewportRows + overscan`
  // groups when only a few real rows are missing.
  const mountedCount = groupCount - startIdx;
  if (mountedCount > 0) {
    const mountedRows = total - cache.accumulatedHeight(startIdx);
    const avgRowsPerGroup = mountedRows > 0 ? mountedRows / mountedCount : 1;
    const rowBudgetCount = Math.max(1, Math.ceil(needed / Math.max(1, avgRowsPerGroup)));
    const rowBudgetStart = Math.max(0, groupCount - rowBudgetCount);
    startIdx = Math.min(startIdx, rowBudgetStart);
  } else {
    startIdx = Math.min(
      startIdx,
      Math.max(0, groupCount - (Math.max(1, geometry.viewportRows) + OVERSCAN_ROWS + extraRows)),
    );
  }
  return { startIdx, endIdx: groupCount, mountTail: true };
}
