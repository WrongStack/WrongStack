/**
 * Copy-hit geometry helpers — pure functions for resolving copy-icon targets
 * in viewport coordinates.
 *
 * Extracted from scrollable-history.tsx.
 */
import { COPY_ICON_WIDTH, copyableTextForEntries, copyableTextForEntry } from './copy-icon.js';
import type { HistoryEntry } from './index.js';

/**
 * A clickable copy-icon target resolved in viewport coordinates during the
 * post-render measurement pass. `entryId` identifies a single card or the first
 * member of a compact tool group; `entryIds` contains every group member when
 * present. `startRow`/`endRow` bound the box's visible rows (0-based from the
 * viewport top, `endRow` exclusive); `iconCol` is the 0-based terminal column
 * the icon renders at on the box's first visible row.
 */
export interface CopyHit {
  entryId: number;
  entryIds?: readonly number[] | undefined;
  startRow: number;
  endRow: number;
  iconCol: number;
}

/** Sentinel returned after copying the active, non-retained tool-stream box. */
export const LIVE_TOOL_STREAM_COPY_ID = -1;

/** Sentinel returned after copying a drag-select-then-right-click selection.
 *  Distinct from any retained entry id so the host can render a different
 *  status-line notice ("Selected range copied") without flashing a specific
 *  card's copy icon (which only makes sense when a single entry was copied). */
export const SELECTION_COPY_ID = -2;

/**
 * Resolve the copy target under a viewport cell, or null. A cell matches when
 * its `row` is within the card's visible rows and its `col` is within the
 * icon's cell span. Iterates newest-first so overlapping row estimates favor
 * the most recently rendered card. Exported-shape pure helper for unit tests.
 */
export function findCopyHit(hits: readonly CopyHit[], row: number, col: number): CopyHit | null {
  for (let i = hits.length - 1; i >= 0; i--) {
    const hit = hits[i];
    if (!hit) continue;
    if (row < hit.startRow || row >= hit.endRow) continue;
    if (col < hit.iconCol || col >= hit.iconCol + COPY_ICON_WIDTH) continue;
    return hit;
  }
  return null;
}

/** Resolve a hit to the complete current clipboard payload without performing I/O. */
export function resolveCopyPayload(
  hit: CopyHit,
  entriesById: ReadonlyMap<number, HistoryEntry>,
  liveToolText?: string | undefined,
): { entryId: number; text: string } | null {
  if (hit.entryId === LIVE_TOOL_STREAM_COPY_ID) {
    return liveToolText ? { entryId: LIVE_TOOL_STREAM_COPY_ID, text: liveToolText } : null;
  }
  const entryIds = hit.entryIds ?? [hit.entryId];
  const entries = entryIds
    .map((entryId) => entriesById.get(entryId))
    .filter((entry): entry is HistoryEntry => entry !== undefined);
  if (entries.length !== entryIds.length) return null;
  const firstEntry = entries[0];
  if (firstEntry === undefined) return null;
  return {
    entryId: hit.entryId,
    text: entries.length === 1 ? copyableTextForEntry(firstEntry) : copyableTextForEntries(entries),
  };
}

/**
 * Rows clipped from the top of the mounted history stack before it appears in
 * the viewport. Scrolled frames clip by the anchor's row offset; pinned frames
 * rely on Ink flex-end clipping, which hides top overflow from mounted groups
 * plus the live tool tail.
 */
export function copyRegistryVisibleClip(opts: {
  scrolled: boolean;
  clip: number;
  mountedRows: number;
  tailRows: number;
  viewportRows: number;
}): number {
  if (opts.scrolled) return opts.clip;
  return Math.max(0, opts.mountedRows + opts.tailRows - opts.viewportRows);
}

/** Build the live tool-stream header hit, accounting for ToolStreamBox's top margin.
 *  The `pinnedSlack` offset must match {@link buildCopyRegistry}'s card-hit math so
 *  the live-stream icon stays visually aligned with its header row in underfilled
 *  pinned frames (flex-end parks the mounted stack at the bottom of the viewport). */
export function liveToolStreamCopyHit(opts: {
  visible: boolean;
  mountedRows: number;
  visibleClip: number;
  viewportRows: number;
  iconCol: number;
  pinnedSlack?: number;
}): CopyHit | null {
  const slack = opts.pinnedSlack ?? 0;
  const headerRow = opts.mountedRows - opts.visibleClip + 1 + slack;
  if (!opts.visible || headerRow < 0 || headerRow >= opts.viewportRows) return null;
  return {
    entryId: LIVE_TOOL_STREAM_COPY_ID,
    startRow: headerRow,
    endRow: headerRow + 1,
    iconCol: opts.iconCol,
  };
}
