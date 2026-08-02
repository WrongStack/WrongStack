/**
 * Scrollbar math and card-span geometry — pure functions for thumb position,
 * track-cell-to-offset mapping, and mounted card viewport spans.
 *
 * Extracted from scrollable-history.tsx.
 */
import type { EntryHeightCache } from '../../height-cache.js';
import { isCopyableEntry } from './copy-icon.js';
import { copyRegistryVisibleClip } from './copy-geometry.js';
import { type RenderGroup, renderGroupId } from './tool-group.js';

/** Pure thumb geometry for the scrollbar: where the thumb starts and how many
 *  cells it spans, given the track height, scroll offset, and total content
 *  height. Exported for testing. */
export function scrollbarThumb(
  rows: number,
  offset: number,
  total: number,
): { top: number; size: number; scrollable: boolean } {
  const scrollable = total > rows;
  if (!scrollable) return { top: 0, size: rows, scrollable: false };
  const windowTop = Math.max(0, total - rows - offset);
  const size = Math.max(1, Math.round((rows / total) * rows));
  const maxWindowTop = total - rows;
  const top = Math.max(
    0,
    Math.min(rows - size, Math.round((windowTop / maxWindowTop) * (rows - size))),
  );
  return { top, size, scrollable: true };
}

/** Inverse of {@link scrollbarThumb}: given a clicked/dragged 0-based cell on a
 *  track of `rows` height, return the scroll offset (rows up from the bottom)
 *  that lands the visible window there. Cell 0 (top) → oldest content (max
 *  offset); cell rows-1 (bottom) → newest (offset 0). Exported for testing. */
export function scrollOffsetForTrackRow(rows: number, total: number, cell: number): number {
  if (total <= rows) return 0;
  const maxOffset = total - rows;
  const clampedCell = Math.max(0, Math.min(rows - 1, cell));
  const windowTop = Math.round((clampedCell / Math.max(1, rows - 1)) * maxOffset);
  return Math.max(0, Math.min(maxOffset, maxOffset - windowTop));
}

/**
 * Per-card viewport span for the currently-mounted groups. Mirrors
 * {@link buildCopyRegistry}'s visibleClip math so the drag-select gesture asks
 * the same geometry question the copy-hit registry already answers.
 */
export interface MountedCardSpan {
  entryId: number;
  /** 0-based viewport row of the first VISIBLE row of the card. */
  viewportStartRow: number;
  /** 0-based viewport row one past the last VISIBLE row of the card. */
  viewportEndRow: number;
  /** Card's geometry in rows; visibleClip + scrolled-clip aware. */
  totalRows: number;
  entryIds?: readonly number[];
}

/**
 * Build per-card viewport spans for every mounted render group. Pure — given
 * the same render-group list, height cache, scroll state, and viewport size,
 * the result is deterministic and matches the copy-hit registry. Exported so
 * tests can verify the span map without mounting the full component.
 */
export function buildMountedCardSpans(opts: {
  renderGroups: readonly RenderGroup[];
  heightCache: EntryHeightCache;
  scrolled: boolean;
  clip: number;
  tailRows: number;
  viewportRows: number;
  showModelReasoning?: boolean | undefined;
}): MountedCardSpan[] {
  const mountedGroupRows = opts.renderGroups.reduce(
    (rows, group) => rows + (opts.heightCache.getHeight(renderGroupId(group)) ?? 0),
    0,
  );
  const visibleClip = copyRegistryVisibleClip({
    scrolled: opts.scrolled,
    clip: opts.clip,
    mountedRows: mountedGroupRows,
    tailRows: opts.tailRows,
    viewportRows: opts.viewportRows,
  });
  const spans: MountedCardSpan[] = [];
  let offset = 0;
  const pinnedSlack = !opts.scrolled
    ? Math.max(0, opts.viewportRows - mountedGroupRows - opts.tailRows)
    : 0;
  for (const group of opts.renderGroups) {
    const gid = renderGroupId(group);
    const groupHeight = opts.heightCache.getHeight(gid) ?? 0;
    const viewportStartRow = offset - visibleClip + pinnedSlack;
    offset += groupHeight;
    const entryIds =
      group.type === 'tool-group'
        ? group.data.entries.map((entry) => entry.id)
        : isCopyableEntry(group.entry) &&
            !(group.entry.kind === 'thinking' && opts.showModelReasoning === false)
          ? [group.entry.id]
          : [];
    const entryId = entryIds[0];
    if (entryId === undefined) continue;
    const viewportEndRow = viewportStartRow + groupHeight;
    if (viewportEndRow <= 0 || viewportStartRow >= opts.viewportRows) continue;
    spans.push({
      entryId,
      viewportStartRow,
      viewportEndRow,
      totalRows: groupHeight,
      ...(entryIds.length > 1 ? { entryIds } : {}),
    });
  }
  return spans;
}

/**
 * Find the card whose viewport row range contains `row`. Pure.
 * Returns null when the row is in a blank gap or outside the viewport.
 */
export function selectionHitAt(
  row: number,
  spans: readonly MountedCardSpan[],
): { entryId: number; entryIds?: readonly number[] } | null {
  for (const span of spans) {
    if (row >= span.viewportStartRow && row < span.viewportEndRow) {
      return { entryId: span.entryId, ...(span.entryIds ? { entryIds: span.entryIds } : {}) };
    }
  }
  return null;
}
