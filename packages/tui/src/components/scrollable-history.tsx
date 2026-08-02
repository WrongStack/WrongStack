import type React from 'react';
import {
  type MutableRefObject,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { writeClipboardText } from '../clipboard.js';
import { EntryHeightCache } from '../height-cache.js';
import { SCROLLBAR_HIT_WIDTH } from '../hit-test.js';
import { Box, type DOMElement, measureElement, Text, useStdout } from '../ink.js';
import { computeLayout } from '../layout-engine.js';
import {
  anchorForTrackCell,
  anchorTopRow,
  contentRows,
  maxTopRow,
  pageRows,
  planFromAnchor,
  planPinned,
  type ScrollAnchor,
  type ScrollGeometry,
  scrollAnchorBy,
  scrollAnchorToTop,
} from '../scroll-anchor.js';
import { theme } from '../theme.js';
import { setTuiHistoryMemoryGauges } from '../tui-memory-counters.js';
import { EntryErrorBoundary } from './entry-error-boundary.js';
import {
  COPY_ICON,
  COPY_ICON_WIDTH,
  copyableTextForEntries,
  copyableTextForEntry,
  isCopyableEntry,
} from './history/copy-icon.js';
import {
  estimateRenderGroupRows,
  groupEntries,
  type RenderGroup,
  renderGroupId,
  ToolGroup,
} from './history/tool-group.js';
import {
  Entry,
  type HistoryEntry,
  type HistoryProps,
  MAX_STREAM_DISPLAY_CHARS,
  ToolStreamBox,
  tailForDisplay,
  toolStreamBoxHeight,
} from './history.js';

/**
 * Imperative scroll surface owned by the ScrollableHistory component. The app
 * key/mouse handlers call these instead of dispatching reducer actions: all
 * scroll math needs the live height cache, which lives here, and routing it
 * through app state previously forced totals and offsets to travel through
 * separate commits — the root cause of an entire family of jump bugs.
 */
export interface HistoryScrollController {
  /** Scroll by `deltaUp` rows: positive = older content, negative = newer. */
  scrollBy(deltaUp: number): void;
  /** Scroll by one viewport page. */
  scrollPage(dir: 'up' | 'down'): void;
  /** Jump to the oldest retained entry. */
  scrollToTop(): void;
  /** Re-pin to the newest output. */
  scrollToBottom(): void;
  /** Jump to a 0-based cell clicked/dragged on the scrollbar track. */
  scrollToTrackCell(cell: number): void;
  /** True while the viewport is scrolled away from the newest output. */
  isScrolled(): boolean;
  /**
   * True when the viewport cell lands on a copyable card's copy icon. Lets the
   * mouse handler decide synchronously whether to consume the click before
   * firing the async copy. See {@link copyAtViewportCell} for the `row`/`col`
   * coordinate contract.
   */
  hasCopyTargetAt(row: number, col: number): boolean;
  /**
   * Handle a left-click inside the history viewport. `row` is 0-based from the
   * viewport top; `col` is 0-based from the LEFT EDGE OF THE HISTORY BAND, not
   * the raw terminal column. In the interactive mount the band renders flush at
   * terminal column 0 (the scrollbar occupies the rightmost columns), so the
   * caller passes the terminal column directly; a band that is inset from the
   * left must subtract its left offset first. When the cell lands on a copyable
   * card's copy icon, its content is written to the system clipboard and the
   * entry id is returned; otherwise returns null.
   */
  copyAtViewportCell(row: number, col: number): Promise<number | null>;
  /**
   * Begin a drag-to-select gesture at `row`,`col` (history-band viewport cell).
   * The cell must be inside a card's row range and inside the rendered band
   * (`0 <= col < termWidth`); the mouse handler has already excluded the rail.
   * Calls that don't satisfy that contract are silently ignored. Existing
   * scrollbar/copy-icon/wheel paths remain intact because they call their own
   * handlers; this only kicks in when the mouse layer explicitly routes a
   * left-press into the card band.
   */
  beginSelection(row: number, col: number): void;
  /**
   * Extend an active selection to `row`,`col`. If no selection is in progress,
   * the call is a no-op. Crossing into the gutter or below the viewport cancels
   * the drag internally — leaving stale viewport-relative coords around after
   * a mid-drag escape would let the next right-click paste from the wrong
   * card, which is the worse failure mode than the selection disappearing.
   */
  extendSelection(row: number, col: number): void;
  /**
   * End an active drag (left-release). Does NOT write to the clipboard — the
   * copy is performed by {@link commitSelection}, which is triggered by a
   * separate right-click in the history band (per the drag-select-then-commit
   * contract). If no selection is in progress, the call is a no-op.
   */
  endSelection(): void;
  /** Drop any in-progress or committed selection without copying. */
  clearSelection(): void;
  /**
   * Commit the active selection to the system clipboard. Returns true if a
   * non-empty selection was resolved and the write succeeded. Returns false
   * silently when there is no selection, the selection is empty (e.g. the drag
   * never moved), or the write fails — the caller can show a transient notice
   * on the truthy branch and stay silent on the falsy branch.
   */
  commitSelection(): Promise<boolean>;
}

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

/**
 * Selection rectangle in viewport cell coordinates, normalized so
 * `topLeft.row <= bottomRight.row` and the column pairs are likewise ordered.
 * Both endpoints are inclusive — the cell at `bottomRight` is selected.
 */
export interface SelectionRect {
  topLeft: { row: number; col: number };
  bottomRight: { row: number; col: number };
  /** True while the user is still dragging; false after left-release but
   *  before either clearSelection or commitSelection runs. */
  inProgress: boolean;
}

/** Canonicalize two viewport cells into a SelectionRect. Pure. */
export function normalizeSelection(
  a: { row: number; col: number },
  b: { row: number; col: number },
  inProgress: boolean,
): SelectionRect {
  const topLeft = { row: Math.min(a.row, b.row), col: Math.min(a.col, b.col) };
  const bottomRight = { row: Math.max(a.row, b.row), col: Math.max(a.col, b.col) };
  return { topLeft, bottomRight, inProgress };
}

/** True when the column lies outside the rendered card band. Inside the band
 *  the layout reserves `SCROLLBAR_HIT_WIDTH` columns for the rail AFTER the
 *  band, so `0..termWidth-1` is always in-band and nothing inside needs to be
 *  excluded. The mouse handler must already have excluded the rail before
 *  calling into the controller — we only check the band bounds here. */
export function isOutOfBand(col: number, termWidth: number): boolean {
  return col < 0 || col >= termWidth;
}

/**
 * One entry's contribution to a drag-selected range. Returned in document
 * (row-index-in-card) coordinates so the caller decides how to slice into
 * the entry's source text. `start` is the column inside the card (0-based
 * from the left edge of the card's visible rectangle, NOT the terminal
 * column — the gutter is excluded by the caller before reaching here).
 * `end` is inclusive. When `startRow === endRow`, the slice is one row; the
 * caller is responsible for translating text columns into source offsets.
 */
export interface SelectionSlice {
  entryId: number;
  /** Inclusive row-in-card for the start of the slice. */
  startRow: number;
  /** Inclusive column, 0-based, inside the card's text area (gutter excluded). */
  startCol: number;
  /** Inclusive end row. */
  endRow: number;
  /** Inclusive end column, 0-based. */
  endCol: number;
}

/**
 * Translate a viewport-cell selection into per-entry row/col slices, walking
 * the same mounted-group geometry the copy-hit registry uses so the two
 * systems share one row index. Entries wholly outside the selection return
 * nothing. Entries whose vertical span is wholly inside the selection are
 * returned as a single row-range; entries the selection clips at the top or
 * bottom are returned with row bounds matching the clip.
 *
 * `cardVisibleCols` is the number of columns inside the card the user can
 * see — the band width minus the right gutter (`viewportWidth - SCROLLBAR_HIT_WIDTH`).
 * Slices never include the gutter or any column to its right; the caller has
 * already validated that.
 *
 * Returned slices are in document (entry-local) coordinates: `startRow`/`endRow`
 * are rows inside the entry's own geometry, NOT viewport cells. This is what
 * the assembler needs to recover text — slicing into the raw entry text uses
 * per-row layout, which the caller resolves via the layout store.
 */
export function selectionToSlices(opts: {
  selection: SelectionRect;
  cards: ReadonlyArray<{
    entryId: number;
    /** 0-based viewport row of the card's first visible row. */
    viewportStartRow: number;
    /** 0-based viewport row just past the card's last visible row. */
    viewportEndRow: number;
  }>;
  cardVisibleCols: number;
}): SelectionSlice[] {
  const { selection, cards, cardVisibleCols } = opts;
  const maxCol = Math.max(0, cardVisibleCols - 1);
  const result: SelectionSlice[] = [];
  for (const card of cards) {
    // Compute the intersection in viewport coordinates.
    const visTop = Math.max(selection.topLeft.row, card.viewportStartRow);
    const visBot = Math.min(selection.bottomRight.row, card.viewportEndRow - 1);
    if (visTop > visBot) continue;
    // Translate to entry-local rows.
    const entryStartRow = visTop - card.viewportStartRow;
    const entryEndRow = visBot - card.viewportStartRow;
    // Clip the column range to the card's visible area. When the slice's
    // first row is the selection's first viewport row, the left edge is the
    // user's drag start column; otherwise we begin at col 0 (the rendered
    // text starts at the card's left edge). The right edge is symmetric —
    // except the right edge is *always* capped to `maxCol` so a drag that
    // overshoots the card width never includes cells that don't exist.
    // `selectionToSlices` emits INCLUSIVE end columns, matching the
    // `SelectionSlice.endCol` contract — so col=3 from the user's drag
    // means "include char 3" rather than "exclude char 3". This is the
    // intuitive convention a user reading "drag col 0..3 copies 4 chars"
    // expects.
    const startCol =
      entryStartRow === selection.topLeft.row - card.viewportStartRow
        ? Math.max(0, Math.min(maxCol, selection.topLeft.col))
        : 0;
    const endCol =
      entryEndRow === selection.bottomRight.row - card.viewportStartRow
        ? Math.max(startCol, Math.min(maxCol, selection.bottomRight.col))
        : maxCol;
    result.push({
      entryId: card.entryId,
      startRow: entryStartRow,
      startCol,
      endRow: entryEndRow,
      endCol,
    });
  }
  return result;
}

interface CopyRegistry {
  hits: CopyHit[];
  liveHit: CopyHit | null;
}

/**
 * Resolve copy icons into the already-reserved scrollbar gap column.
 *
 * Copy affordances must not alter card width: changing the width changes
 * wrapped row counts, which invalidates the prefix sums that map scrollbar
 * positions to virtual entry slices. This helper derives icon rows from the
 * same cached heights used by the mount plan while leaving entry geometry
 * untouched.
 */
function buildCopyRegistry(opts: {
  renderGroups: readonly RenderGroup[];
  heightCache: EntryHeightCache;
  scrolled: boolean;
  clip: number;
  tailRows: number;
  viewportRows: number;
  iconCol: number;
  showModelReasoning?: boolean | undefined;
  liveToolVisible: boolean;
}): CopyRegistry {
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
  // Pinned frames whose mounted stack is shorter than the viewport are
  // rendered with flex-end (parking the first card at row `vp - mountedRows`).
  // Mirror the same `pinnedSlack` offset `buildMountedCardSpans` uses so the
  // copy icon row stays visually aligned with the card row — without this,
  // icons render at row 0 while the card itself sits at row `vp - h`.
  const pinnedSlack = !opts.scrolled
    ? Math.max(0, opts.viewportRows - mountedGroupRows - opts.tailRows)
    : 0;
  const hits: CopyHit[] = [];
  let offset = 0;
  for (const group of opts.renderGroups) {
    const gid = renderGroupId(group);
    const groupHeight = opts.heightCache.getHeight(gid) ?? 0;
    const startRow = offset - visibleClip + pinnedSlack;
    offset += groupHeight;
    const groupEntryIds =
      group.type === 'tool-group'
        ? group.data.entries.map((entry) => entry.id)
        : isCopyableEntry(group.entry) &&
            !(group.entry.kind === 'thinking' && opts.showModelReasoning === false)
          ? [group.entry.id]
          : [];
    const entryId = groupEntryIds[0];
    if (entryId === undefined || startRow < 0 || startRow >= opts.viewportRows) continue;
    hits.push({
      entryId,
      ...(groupEntryIds.length > 1 ? { entryIds: groupEntryIds } : {}),
      startRow,
      endRow: startRow + 1,
      iconCol: opts.iconCol,
    });
  }
  return {
    hits,
    liveHit: liveToolStreamCopyHit({
      visible: opts.liveToolVisible,
      mountedRows: mountedGroupRows,
      visibleClip,
      viewportRows: opts.viewportRows,
      iconCol: opts.iconCol,
      pinnedSlack,
    }),
  };
}

export interface ScrollableHistoryProps extends HistoryProps {
  /** Height of the viewport in rows, computed by App from the bottom region. */
  viewportRows: number;
  /** Receives the imperative scroll controller. The component assigns on
   *  mount and clears on unmount. Optional for isolated renderers. */
  controllerRef?: MutableRefObject<HistoryScrollController | null> | undefined;
  /** Reports scroll-state transitions (scrolled away from / re-pinned to the
   *  newest output) so the host can adjust key hints. */
  onScrollInfo?: ((info: { scrolled: boolean }) => void) | undefined;
  /** Optional cap on the width used for entry wrapping (right panel mode). */
  maxWidth?: number | undefined;
  /** Layout store for persisting entry height data across renders and sessions.
   *  When provided, the ScrollableHistory seeds its height cache from the
   *  store's persisted measurements and marks entries as measured after render,
   *  eliminating estimate-vs-actual scroll jumps on re-render. */
  layoutStore?: import('../layout-store.js').LayoutStore | undefined;
  /**
   * Entry id of the card whose copy icon was just clicked. That card's icon
   * renders in the success color for the brief window the host keeps this set,
   * giving per-card visual feedback alongside the status-line "Copied" notice.
   * `null` / undefined = no card highlighted.
   */
  copiedEntryId?: number | null | undefined;
  /**
   * Called when the user scrolls near the top of the currently loaded
   * entries. The host should respond by loading older entries from the
   * history archive and dispatching `archiveLoaded` to prepend them.
   */
  onRequestOlderEntries?: (() => void) | undefined;
}

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
  // Visible window top in content-line space; 0 = oldest, total = newest.
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
  // Pinned frames whose mounted stack is shorter than the viewport are
  // rendered with flex-end (parking the first card at row `vp - mountedRows`).
  // `visibleClip` alone is 0 in underfill, which would claim rows [0, H) while
  // Ink draws the same cards at [vp-H, vp) — drags over visible text never
  // start a selection, and clicks on the blank top band "select" off-screen
  // content. Add the same slack `buildCopyRegistry` uses so spans, copy
  // icons, and the rendered frame all share one coordinate system.
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

/**
 * Build the clipboard payload for a selection by slicing into each affected
 * entry's full renderable text. The v1 contract is line-then-column on the
 * entry's source text: each slice exposes `startRow`/`endRow` and
 * `startCol`/`endCol` in card-local coordinates; we split the entry's
 * text on `\n`, keep only the rows inside the row range, and within those
 * rows apply the column range. The matrix matches what the source line
 * index would be when no wrapping occurs — i.e. one card row maps to one
 * source line. Wrap-geometry translation is intentionally absent in v1
 * because the layout store does not yet expose per-card-row wrap segments;
 * it returns when those segments exist and a v1.1 test demands it.
 *
 * `toolGroupsByHeadId` lets a multi-member tool-group expand: when the
 * head id appears with `entryIds.length > 1`, the assembler copies via
 * `copyableTextForEntries` (raw ordered JSON of every member, matching
 * the existing copy-icon contract). A single-entry head falls through
 * to `copyableTextForEntry`.
 *
 * Multi-entry selections are joined with `\n---\n` so the user can see
 * where one card ends and the next begins. Empty selections and
 * selections that resolve to no text return `""` so the caller can fall
 * through silently.
 */
export function assembleSelectionText(opts: {
  slices: readonly SelectionSlice[];
  entriesById: ReadonlyMap<number, HistoryEntry>;
  /**
   * For each tool-group head id present in `slices`, the ordered member list.
   * When a head has a multi-member group, the assembler slices into the
   * group's combined text via `copyableTextForEntries`. A single-entry
   * head falls through to `copyableTextForEntry`.
   */
  toolGroupsByHeadId?: ReadonlyMap<number, readonly number[]> | undefined;
}): string {
  const { slices, entriesById, toolGroupsByHeadId } = opts;
  if (slices.length === 0) return '';
  const byEntry = new Map<number, SelectionSlice[]>();
  for (const slice of slices) {
    const list = byEntry.get(slice.entryId);
    if (list) list.push(slice);
    else byEntry.set(slice.entryId, [slice]);
  }
  const segments: string[] = [];
  let toolGroupCount = 0;
  for (const [entryId, entrySlices] of byEntry) {
    const head = entriesById.get(entryId);
    if (!head) continue;
    // Tool-group expansion: when the head id resolves to a multi-member
    // group, slice the combined text from every member in order. A
    // single-entry head falls through to the existing path.
    const groupMembers = toolGroupsByHeadId?.get(entryId);
    const entries =
      groupMembers && groupMembers.length > 1
        ? groupMembers
            .map((id) => entriesById.get(id))
            .filter((entry): entry is HistoryEntry => entry !== undefined)
        : [head];
    if (entries.length === 0) continue;
    if (entries.length > 1) toolGroupCount += 1;
    const fullText =
      entries.length === 1
        ? copyableTextForEntry(entries[0] as HistoryEntry)
        : copyableTextForEntries(entries);
    if (fullText.length === 0) continue;
    // For a multi-member tool-group, the slice's row range is in the
    // group's *header* coordinate system (a small fixed box, typically
    // 1-3 rows), NOT in the combined JSON text's row space — slicing
    // `fullText` by that range picks an arbitrary fragment of the JSON
    // rather than the group's content. The drag intent for a tool-group
    // head is "copy the whole group", so emit the full `fullText`
    // regardless of the slice geometry. Single-entry heads still slice
    // normally because their text and slice share the same coordinate
    // space.
    if (entries.length > 1) {
      segments.push(fullText);
      continue;
    }
    for (const slice of entrySlices) {
      const rows = fullText.split('\n');
      const collected: string[] = [];
      for (let r = slice.startRow; r <= slice.endRow && r < rows.length; r++) {
        const line = rows[r] ?? '';
        if (slice.startRow === slice.endRow) {
          const start = Math.max(0, Math.min(line.length, slice.startCol));
          const end = Math.max(start, Math.min(line.length, slice.endCol + 1));
          if (end > start) collected.push(line.slice(start, end));
        } else if (r === slice.startRow) {
          const start = Math.max(0, Math.min(line.length, slice.startCol));
          if (start < line.length) collected.push(line.slice(start));
        } else if (r === slice.endRow) {
          const end = Math.max(0, Math.min(line.length, slice.endCol + 1));
          if (end > 0) collected.push(line.slice(0, end));
        } else {
          collected.push(line);
        }
      }
      const seg = collected.join('\n');
      if (seg.length > 0) segments.push(seg);
    }
  }
  if (segments.length === 0) return '';
  // Distinct heads use `---`; identical heads (multi-row drag in one
  // card) join with a plain newline so the user sees the natural row
  // break. A tool-group expansion acts like one logical entry, so the
  // plain-newline rule applies within a tool-group; distinct cards (heads
  // or tool-groups) get the boundary.
  const separator = byEntry.size > 1 || toolGroupCount > 0 ? '\n---\n' : '\n';
  return segments.join(separator);
}

/**
 * Right-edge rail for the managed viewport. Its first column is the copy-icon
 * gap and its second column is the scrollbar track. Both columns are always
 * reserved, so copy affordances and scrollability never reflow chat content.
 */
function Scrollbar({
  rows,
  offset,
  total,
  copyHits,
  copiedEntryId,
}: {
  rows: number;
  offset: number;
  total: number;
  copyHits: readonly CopyHit[];
  copiedEntryId?: number | null | undefined;
}): React.ReactElement {
  const { top: thumbTop, size: thumbSize, scrollable } = scrollbarThumb(rows, offset, total);
  const cells: string[] = [];
  for (let i = 0; i < rows; i++) {
    cells.push(i >= thumbTop && i < thumbTop + thumbSize ? '█' : '│');
  }
  const copyByRow = new Map<number, CopyHit>();
  for (const hit of copyHits) copyByRow.set(hit.startRow, hit);
  return (
    <Box flexDirection="column" flexShrink={0}>
      {cells.map((cell, row) => {
        const copyHit = copyByRow.get(row);
        return (
          <Box key={row} flexDirection="row">
            <Text
              color={copyHit && copiedEntryId === copyHit.entryId ? theme.success : theme.textMuted}
            >
              {copyHit ? COPY_ICON : ' '}
            </Text>
            <Text
              {...(scrollable ? { color: theme.accent } : {})}
              dimColor={!scrollable || cell === '│'}
            >
              {cell}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

/** Minimum extra rows mounted per underfill-correction step. The effective
 *  step is `max(UNDERFILL_BUMP_ROWS, viewportRows)`: the deficit the step must
 *  cover scales with the viewport (estimate error is roughly proportional to
 *  the rows planned), so a fixed 16-row step that heals a 30-row terminal in
 *  one pass starves a 150-row terminal for many frames — the reported
 *  blank-band symptom on tall terminals. */
const UNDERFILL_BUMP_ROWS = 16;
/** Cap on underfill-correction steps per anchor position (loop guard). */
const MAX_UNDERFILL_BUMPS = 8;

/**
 * Bounded history viewport with stable-anchor virtual scrolling.
 *
 * Instead of streaming entries into the terminal's native scrollback via
 * `<Static>`, retained entries render into a fixed-height `overflowY:'hidden'`
 * viewport the app scrolls itself. Wheel, PageUp/PageDown, and Ctrl+U/D scroll
 * it in every mode; full mouse mode additionally enables scrollbar interaction.
 * All paths use the {@link HistoryScrollController} this component owns.
 *
 * Positioning model (Ink-7 verified against real yoga layout):
 * - Pinned (`anchor:null`): `justifyContent:'flex-end'` + enough trailing
 *   groups mounted to overfill the viewport. Ink clips the overflow at the
 *   TOP, so the newest output hugs the input line with zero position math.
 * - Scrolled: wheel, page keys, and scrollbar gestures all resolve to the
 *   render-group id at the viewport top plus a row clipped inside that group.
 *   Groups mount from that stable anchor and `marginTop:-clip` hides preceding
 *   rows. Height corrections above the anchor can refine the scrollbar extent
 *   without changing which content is visible.
 *
 * The {@link EntryHeightCache} seeds the global row space and decides how many
 * groups to mount. A post-render `measureElement` pass promotes mounted groups
 * to real heights and persists them. Only the mounted virtual window is
 * measured; a long transcript is never mounted wholesale for calibration.
 *
 * Wrapped in `React.memo` so keystrokes in the input buffer don't trigger a
 * full managed-viewport re-layout.
 */
export const ScrollableHistory = memo(function ScrollableHistory({
  entries,
  toolStream,
  viewportRows,
  controllerRef,
  onScrollInfo,
  maxWidth,
  setSuggestions,
  autonomyMode,
  multiDiffSummaryThreshold,
  todos,
  showModelReasoning,
  showSageMemoryInject,
  layoutStore,
  copiedEntryId,
  onRequestOlderEntries,
}: ScrollableHistoryProps): React.ReactElement {
  const { stdout } = useStdout();
  const resolveViewportWidth = useCallback(() => {
    const raw = stdout?.columns ?? 80;
    return maxWidth ? Math.min(raw, maxWidth) : raw;
  }, [stdout, maxWidth]);
  const [viewportWidth, setViewportWidth] = useState(resolveViewportWidth);
  // The history column shares its row with a one-column scrollbar and its
  // one-column gap. Pass only the remaining width into entry/tail renderers so
  // long assistant/tool-result lines wrap before reaching the track.
  const termWidth = useMemo(
    () => Math.max(1, viewportWidth - SCROLLBAR_HIT_WIDTH),
    [viewportWidth],
  );
  useEffect(() => {
    const handleResize = () => {
      setViewportWidth(resolveViewportWidth());
    };
    stdout?.on('resize', handleResize);
    return () => {
      stdout?.off('resize', handleResize);
    };
  }, [stdout, resolveViewportWidth]);

  const toolTail = toolStream?.text
    ? tailForDisplay(toolStream.text, MAX_STREAM_DISPLAY_CHARS)
    : '';
  const toolTailHeight = toolTail && toolStream ? toolStreamBoxHeight(toolStream.name) : 0;
  const groupedEntries = useMemo(() => groupEntries(entries), [entries]);
  const groupIds = useMemo(() => groupedEntries.map(renderGroupId), [groupedEntries]);
  const groupIdsKey = groupIds.join(',');

  // Seed conservative heights before first paint so even a long resumed
  // transcript is virtualized immediately. Synchronization is keyed by stable
  // group ids because reducer commits often replace `entries` without changing
  // its content and should not repeat the O(n) cache preparation.
  //
  // When a LayoutStore is available (from a resumed session / persisted layout),
  // its measured (non-estimated) heights are preferred over the heuristic
  // estimates — this eliminates the estimate-vs-actual mismatch on the first
  // render cycle.
  const heightCacheRef = useRef<EntryHeightCache | null>(null);
  if (heightCacheRef.current === null) heightCacheRef.current = new EntryHeightCache();
  const heightCache = heightCacheRef.current;
  // Live DOM nodes for the currently-mounted window, keyed by render-group id.
  // A post-render layout effect measures each against its cached (estimated)
  // height and promotes it to a real measurement.
  const entryNodeRefs = useRef(new Map<number, DOMElement>());
  const measuredGroupIdsRef = useRef(new Set<number>());
  // Clickable copy-icon targets in viewport coordinates, rebuilt every render
  // pass from the same measured heights the scroll math uses. Read by the
  // controller's copyAtViewportCell when a left-click lands in the history band.
  const copyHitsRef = useRef<CopyHit[]>([]);
  const liveToolCopyHitRef = useRef<CopyHit | null>(null);
  // Per-card viewport spans for the currently-mounted groups. Rebuilt every
  // render from the same offset/visibleClip math the copy-hit registry uses, so
  // the selection gesture asks the same geometry question as every other
  // viewport-aware system. Uses the full {@link MountedCardSpan} shape so the
  // controller can hand the array straight to `selectionHitAt` without
  // reconstructing a wrapper object on every move event.
  const mountedGroupSpansRef = useRef<readonly MountedCardSpan[]>([]);
  // Compact signature of the last-rendered span geometry, used to invalidate
  // `selectionRef` when entries mutate in place in pinned mode: a new entry
  // appended (or a tool-stream tail growing) re-runs the render without an
  // anchor change, so the controller's recorded drag coords still resolve
  // against stale geometry. A change in this signature between renders clears
  // any committed-but-not-yet-cleared selection so the next right-click
  // doesn't paste text from cards the user can't see there anymore.
  const spansSignatureRef = useRef('');
  // Selection state for drag-to-select-then-right-click-copy. Lives in a ref
  // so mid-gesture updates don't force extra renders — no setState fires in
  // begin/extend/end/commit/clear, and the render tree does not currently
  // read this ref (a visible drag-highlight overlay is a future addition;
  // for now the user discovers the selection by right-clicking to commit).
  // Cleared on every wheel/copy-icon/scrollbar interaction so it never
  // outlives the gesture that created it.
  const selectionRef = useRef<{
    anchor: { row: number; col: number } | null;
    head: { row: number; col: number } | null;
    inProgress: boolean;
  }>({ anchor: null, head: null, inProgress: false });
  const toolStreamRef = useRef(toolStream);
  toolStreamRef.current = toolStream;
  const entriesByIdRef = useRef(new Map<number, HistoryEntry>());
  entriesByIdRef.current = new Map(entries.map((entry) => [entry.id, entry]));
  const preparedGroupIdsRef = useRef<string | null>(null);
  const preparedEstimateWidthRef = useRef<number | null>(null);
  // Key that changes when either the group set or the terminal width changes,
  // triggering a re-seed of the height cache. We deliberately do NOT include
  // `layoutStore.termWidth` here: it is updated INSIDE the guarded block below
  // (via setTermWidth), so including it would make the key change one render
  // later — causing a second seeding pass that discards freshly-measured
  // heights and replaces them with estimates, corrupting the viewport.
  // The reasoning-display flag participates in the key: toggling it changes
  // every thinking entry's rendered height (full block ↔ zero rows), so the
  // cache must re-seed or stale heights become phantom scroll space.
  const reasoningKey = showModelReasoning === false ? '|r0' : '';
  const sageKey = showSageMemoryInject === false ? '|s0' : '';
  const cacheKey =
    (layoutStore ? `${groupIdsKey}|w${termWidth}` : groupIdsKey) + reasoningKey + sageKey;
  if (preparedGroupIdsRef.current !== cacheKey || preparedEstimateWidthRef.current !== termWidth) {
    // `!== null` guards the first render: on mount `preparedEstimateWidthRef`
    // is null so widthChanged stays false. On subsequent renders a real width
    // change clears measured ids so the cache re-seeds at the new dimension.
    const widthChanged =
      preparedEstimateWidthRef.current !== null && preparedEstimateWidthRef.current !== termWidth;
    if (widthChanged) {
      measuredGroupIdsRef.current.clear();
    }
    heightCache.sync(groupIds);
    const retainedIds = new Set(groupIds);
    for (const id of measuredGroupIdsRef.current) {
      if (!retainedIds.has(id)) measuredGroupIdsRef.current.delete(id);
    }

    if (layoutStore) {
      // Prefer persisted (measured) heights; fall back to heuristic estimates
      // for entries not yet in the store.
      layoutStore.setTermWidth(termWidth);
      // Prune stale entries from the store (history retention evicted them).
      layoutStore.retain(new Set(groupIds));
      for (const group of groupedEntries) {
        const id = renderGroupId(group);
        // A thinking entry renders zero rows while reasoning display is off.
        // Record that truth ahead of any stored/estimated height — including
        // over a `measured` snapshot from a reasoning-on era — or the screen
        // and the prefix sums disagree by the entire reasoning text.
        if (
          group.type !== 'tool-group' &&
          group.entry.kind === 'thinking' &&
          showModelReasoning === false
        ) {
          heightCache.record(id, 0);
          continue;
        }
        const stored = layoutStore.get(id);
        if (stored && stored.termWidth === termWidth) {
          // Never replace a live measurement with an older heuristic when a
          // new entry changes the group list in the same terminal width.
          if (stored.kind === 'measured' || !measuredGroupIdsRef.current.has(id)) {
            heightCache.record(id, stored.rows);
          }
          if (stored.kind === 'measured') measuredGroupIdsRef.current.add(id);
        } else {
          // New entry: compute a heuristic estimate and seed the store.
          const estimatedRows = estimateRenderGroupRows(group, termWidth, showSageMemoryInject);
          heightCache.record(id, estimatedRows);
          const kind = group.type === 'tool-group' ? 'tool-group' : group.entry.kind;
          const text =
            group.type === 'tool-group'
              ? group.data.name
              : ((group.entry as { text?: string }).text ?? '');
          layoutStore.set(
            id,
            computeLayout(id, kind, text, termWidth, {
              ...(group.type === 'tool-group' ? { groupCount: group.data.entries.length } : {}),
            }),
          );
        }
      }
    } else {
      // No LayoutStore: fall back to heuristic estimates only. Hidden
      // thinking entries are zero-height on screen; force their cached rows
      // to 0 even when previously measured in a reasoning-on state.
      const hiddenIds = new Set<number>();
      const estimateById = new Map(
        groupedEntries.map((group) => {
          const id = renderGroupId(group);
          const hidden =
            group.type !== 'tool-group' &&
            group.entry.kind === 'thinking' &&
            showModelReasoning === false;
          if (hidden) hiddenIds.add(id);
          return [
            id,
            hidden ? 0 : estimateRenderGroupRows(group, termWidth, showSageMemoryInject),
          ] as const;
        }),
      );
      heightCache.recordMany(
        groupIds
          .filter((id) => hiddenIds.has(id) || !measuredGroupIdsRef.current.has(id))
          .map((id) => [id, estimateById.get(id) ?? 3] as const),
      );
    }

    preparedGroupIdsRef.current = cacheKey;
    preparedEstimateWidthRef.current = termWidth;
  }

  const vp = Math.max(1, viewportRows);

  // ── Scroll state ────────────────────────────────────────────────────
  // Keep the identity of the group at the viewport top. A numeric global row
  // becomes a different piece of content whenever an estimate above it is
  // corrected; an id + local clip keeps the visible content stable.
  const [anchor, setAnchor] = useState<{ id: number; clip: number } | null>(null);
  // Underfill-correction steps for the current scroll position: each step
  // mounts UNDERFILL_BUMP_ROWS more estimated rows. Reset on scroll.
  const [mountBump, setMountBump] = useState(0);
  // Reset mountBump when terminal width changes so the underfill-correction
  // loop re-converges from scratch at the new width instead of retaining a
  // stale counter (possibly already at MAX_UNDERFILL_BUMPS) that prevents
  // the viewport from filling correctly after a resize.
  const prevTermWidthRef = useRef(termWidth);
  if (prevTermWidthRef.current !== termWidth) {
    prevTermWidthRef.current = termWidth;
    setMountBump(0);
  }
  // Reset mountBump when the viewport HEIGHT changes too: a height-resize
  // changes the correction target (viewportRows) under a possibly-saturated
  // counter, and the underfill loop must re-converge against the new height
  // from a clean slate — mirroring the width-change reset above.
  const prevVpRef = useRef(viewportRows);
  if (prevVpRef.current !== viewportRows) {
    prevVpRef.current = viewportRows;
    setMountBump(0);
  }
  // Re-render nudge when a measurement changed a cached height but no other
  // state transition will re-render this memoized component (thumb geometry
  // and mount planning read the cache during render). Value is never read.
  const [, setMeasureTick] = useState(0);

  const geometry: ScrollGeometry = {
    cache: heightCache,
    groupCount: groupedEntries.length,
    viewportRows: vp,
    tailRows: toolTailHeight,
  };

  const groupIndexById = useMemo(() => {
    const indexes = new Map<number, number>();
    groupIds.forEach((id, index) => {
      indexes.set(id, index);
    });
    return indexes;
  }, [groupIds]);

  // Resolve the stable id into this render's group index. If retention evicted
  // the anchor, fall back to the oldest retained group. Clamp a stale clip to
  // the same group's last row instead of advancing to unrelated content.
  let effectiveAnchor: ScrollAnchor | null = null;
  if (anchor !== null && groupedEntries.length > 0 && maxTopRow(geometry) > 0) {
    const index = groupIndexById.get(anchor.id) ?? 0;
    const id = groupIds[index];
    const height = id === undefined ? 1 : (heightCache.getHeight(id) ?? 1);
    effectiveAnchor = {
      index,
      clip: Math.max(0, Math.min(Math.max(0, height - 1), anchor.clip)),
    };
  }
  const scrolled = effectiveAnchor !== null;

  // Latest-value refs for the stable controller callbacks.
  const geometryRef = useRef(geometry);
  geometryRef.current = geometry;
  const effectiveAnchorRef = useRef(effectiveAnchor);
  effectiveAnchorRef.current = effectiveAnchor;
  const groupIdsRef = useRef(groupIds);
  groupIdsRef.current = groupIds;

  const applyAnchor = useCallback((next: ScrollAnchor | null): void => {
    const ids = groupIdsRef.current;
    const nextId = next ? ids[next.index] : undefined;
    const normalized =
      next && nextId !== undefined ? { index: next.index, clip: Math.max(0, next.clip) } : null;
    // Viewport-relative selection coordinates become invalid as soon as the
    // viewport moves. Clear them on every controller scroll path so a later
    // right-click cannot resolve the old rectangle against new card spans.
    selectionRef.current = { anchor: null, head: null, inProgress: false };
    // Raw stdin often batches many trackpad/wheel reports in one chunk. Update
    // the imperative ref immediately so every report advances from the result
    // of the previous one even before React commits a frame.
    effectiveAnchorRef.current = normalized;
    setAnchor(normalized && nextId !== undefined ? { id: nextId, clip: normalized.clip } : null);
    setMountBump(0);
  }, []);

  const controller = useMemo<HistoryScrollController>(
    () => ({
      scrollBy: (deltaUp) => {
        applyAnchor(scrollAnchorBy(geometryRef.current, effectiveAnchorRef.current, deltaUp));
      },
      scrollPage: (dir) => {
        const rows = pageRows(geometryRef.current.viewportRows);
        applyAnchor(
          scrollAnchorBy(
            geometryRef.current,
            effectiveAnchorRef.current,
            dir === 'up' ? rows : -rows,
          ),
        );
      },
      scrollToTop: () => {
        applyAnchor(scrollAnchorToTop(geometryRef.current));
      },
      scrollToBottom: () => {
        applyAnchor(null);
      },
      scrollToTrackCell: (cell) => {
        // The ratio is used once to select a logical anchor. Subsequent height
        // corrections retain that content instead of continuously reapplying
        // the ratio and sliding the viewport to another entry.
        applyAnchor(anchorForTrackCell(geometryRef.current, cell));
      },
      isScrolled: () => effectiveAnchorRef.current !== null,
      hasCopyTargetAt: (row, col) =>
        findCopyHit(copyHitsRef.current, row, col) !== null ||
        findCopyHit(liveToolCopyHitRef.current ? [liveToolCopyHitRef.current] : [], row, col) !==
          null,
      copyAtViewportCell: async (row, col) => {
        const liveHit = findCopyHit(
          liveToolCopyHitRef.current ? [liveToolCopyHitRef.current] : [],
          row,
          col,
        );
        const hit = liveHit ?? findCopyHit(copyHitsRef.current, row, col);
        if (hit === null) return null;
        const payload = resolveCopyPayload(
          hit,
          entriesByIdRef.current,
          toolStreamRef.current?.text,
        );
        if (payload === null) return null;
        return (await writeClipboardText(payload.text)) ? payload.entryId : null;
      },
      beginSelection: (row, col) => {
        // The mouse handler has already filtered to left-press on a non-gutter
        // history-band cell that is NOT a copy-icon hit. We still re-check the
        // gutter here because the gutter column set is the source of truth for
        // any band-click that slipped through. Rows in the entry-row gap (no
        // card at that viewport row) must not start a selection — that would
        // let the user "select" blank padding that resolves to no text.
        // Both early-return branches also clear any prior committed selection:
        // a left-press on padding is the user's explicit signal that the
        // previous drag is over, and leaving the old rectangle alive would let
        // a later right-click commit stale viewport-relative geometry against
        // the current card spans.
        if (isOutOfBand(col, termWidth)) {
          selectionRef.current = { anchor: null, head: null, inProgress: false };
          return;
        }
        const cardHit = selectionHitAt(row, mountedGroupSpansRef.current);
        if (cardHit === null) {
          selectionRef.current = { anchor: null, head: null, inProgress: false };
          return;
        }
        selectionRef.current = {
          anchor: { row, col },
          head: { row, col },
          inProgress: true,
        };
      },
      extendSelection: (row, col) => {
        const cur = selectionRef.current;
        if (cur.anchor === null) return;
        // Once a drag has been released (inProgress=false), further motion
        // events are explicitly a no-op. A stray post-release move event
        // must not shift the head and silently widen the committed range.
        if (cur.inProgress === false) return;
        // Crossing outside the band (rail or below the viewport) cancels the
        // drag — the user pulled outside the card. A stale selection survives
        // only until commit or clear; mid-drag cancellation is the safer
        // default.
        if (isOutOfBand(col, termWidth) || row < 0 || row >= vp) {
          selectionRef.current = { anchor: null, head: null, inProgress: false };
          return;
        }
        selectionRef.current = { ...cur, head: { row, col } };
      },
      endSelection: () => {
        const cur = selectionRef.current;
        if (cur.anchor === null) return;
        // Mark the selection as finalized (no longer in progress) but keep it
        // available until the user right-clicks to commit, presses elsewhere,
        // or starts a new gesture. The next beginSelection replaces the state.
        selectionRef.current = { ...cur, inProgress: false };
      },
      clearSelection: () => {
        const cur = selectionRef.current;
        if (cur.anchor === null && cur.head === null) return;
        selectionRef.current = { anchor: null, head: null, inProgress: false };
      },
      commitSelection: async () => {
        const cur = selectionRef.current;
        if (cur.anchor === null || cur.head === null) return false;
        // A drag that never moved is not a real selection: the user pressed
        // and released on the same cell without dragging. commitSelection
        // must return false in that case so the host doesn't show a "Copied"
        // notice for what was effectively a no-op click.
        if (cur.anchor.row === cur.head.row && cur.anchor.col === cur.head.col) {
          selectionRef.current = { anchor: null, head: null, inProgress: false };
          return false;
        }
        const rect = normalizeSelection(cur.anchor, cur.head, cur.inProgress);
        // Translate viewport cells into per-card slices using the same
        // mounted-group geometry the scrollbar uses.
        const slices = selectionToSlices({
          selection: rect,
          cards: mountedGroupSpansRef.current,
          cardVisibleCols: termWidth,
        });
        const toolGroupsByHeadId = new Map<number, readonly number[]>();
        for (const span of mountedGroupSpansRef.current) {
          if (span.entryIds && span.entryIds.length > 1) {
            toolGroupsByHeadId.set(span.entryId, span.entryIds);
          }
        }
        const text = assembleSelectionText({
          slices,
          entriesById: entriesByIdRef.current,
          ...(toolGroupsByHeadId.size > 0 ? { toolGroupsByHeadId } : {}),
        });
        // Always clear the selection — committing an empty drag should not
        // leave state around. The next render reads the cleared ref.
        selectionRef.current = { anchor: null, head: null, inProgress: false };
        if (text.length === 0) return false;
        // Wrap the write in try/catch: a denied clipboard (locked session,
        // missing write permission, runtime timeout) must not turn into an
        // unhandled rejection in the host. `writeClipboardText` returns
        // `false` on its own for the documented "write failed" cases; this
        // catches the rest (rare exceptions thrown by the underlying IPC).
        try {
          return await writeClipboardText(text);
        } catch {
          return false;
        }
      },
    }),
    [applyAnchor, termWidth, vp],
  );

  useEffect(() => {
    if (!controllerRef) return undefined;
    controllerRef.current = controller;
    return () => {
      // Unconditionally null so the cleanup does not race against a new
      // effect that has already been queued in the same commit phase.
      // The `=== controller` guard in the previous code created a window
      // where a stale controller reference was left alive on re-render.
      controllerRef.current = null;
    };
  }, [controllerRef, controller]);

  // Report scroll-state transitions (drives the "managed" key hint).
  // Use a ref for `onScrollInfo` so the effect does not re-fire when the
  // caller passes an unstable function reference (inline arrow, re-created
  // callback, etc.). Only `scrolled` transitions trigger the notification.
  const lastReportedScrolled = useRef<boolean | null>(null);
  const onScrollInfoRef = useRef(onScrollInfo);
  onScrollInfoRef.current = onScrollInfo;
  // Track archive request state. Refs are safe for cross-cycle state; the
  // planStartIdxRef is updated per-render after the plan computation below.
  const planStartIdxRef = useRef(0);
  const requestOlderFiredRef = useRef(false);
  const onRequestOlderEntriesRef = useRef(onRequestOlderEntries);
  onRequestOlderEntriesRef.current = onRequestOlderEntries;
  useEffect(() => {
    if (lastReportedScrolled.current === scrolled) return;
    lastReportedScrolled.current = scrolled;
    onScrollInfoRef.current?.({ scrolled });
  }, [scrolled]);

  // ── Mount planning ──────────────────────────────────────────────────
  // Each underfill-correction step mounts at least one viewport's worth of
  // extra estimated rows: estimate error is roughly proportional to the
  // planned row budget, so a fixed step heals a 30-row terminal but starves
  // a 150-row one (the blank-band symptom on tall terminals). Scaling to
  // `vp` means even a 4:1 estimate overestimation fills the viewport in 2-3
  // correction cycles rather than exhausting the 8-step cap.
  const bumpStep = Math.max(UNDERFILL_BUMP_ROWS, vp);
  const plan = effectiveAnchor
    ? planFromAnchor(geometry, effectiveAnchor, mountBump * bumpStep)
    : planPinned(geometry, mountBump * bumpStep);
  const renderGroups = groupedEntries.slice(plan.startIdx, plan.endIdx);
  const clip = effectiveAnchor?.clip ?? 0;
  // Track the current mount-plan start index so the scroll-to-top archive
  // check in the useLayoutEffect can read it without a stale closure.
  planStartIdxRef.current = plan.startIdx;

  const totalRows = contentRows(geometry);
  setTuiHistoryMemoryGauges({
    historyRetainedEntries: entries.length,
    historyGroupedEntries: groupedEntries.length,
    historyMountedGroups: renderGroups.length,
    historyMountedEntries: renderGroups.reduce(
      (count, group) => count + (group.type === 'tool-group' ? group.data.entries.length : 1),
      0,
    ),
    historyCachedGroups: heightCache.size,
    historyMeasuredGroups: measuredGroupIdsRef.current.size,
    historyViewportRows: vp,
    historyTotalRows: totalRows,
  });
  const offsetFromBottom = scrolled
    ? Math.max(0, maxTopRow(geometry) - anchorTopRow(geometry, effectiveAnchor))
    : 0;
  // The copy rail occupies the gap column already excluded from `termWidth`.
  // Compute its rows from the same cache snapshot as this render so the visual
  // glyphs and click registry stay aligned without changing card geometry.
  const copyRegistry = buildCopyRegistry({
    renderGroups,
    heightCache,
    scrolled,
    clip,
    tailRows: plan.mountTail ? toolTailHeight : 0,
    viewportRows: vp,
    iconCol: termWidth,
    showModelReasoning,
    liveToolVisible: Boolean(plan.mountTail && toolTail && toolStream),
  });
  copyHitsRef.current = copyRegistry.hits;
  liveToolCopyHitRef.current = copyRegistry.liveHit;
  const copyRailHits = copyRegistry.liveHit
    ? [...copyRegistry.hits, copyRegistry.liveHit]
    : copyRegistry.hits;
  // Mirror the same visibleClip math into per-card spans so beginSelection and
  // commitSelection can answer "what card is row N on?" without re-walking the
  // height cache or re-running buildCopyRegistry.
  const nextSpans = buildMountedCardSpans({
    renderGroups,
    heightCache,
    scrolled,
    clip,
    tailRows: plan.mountTail ? toolTailHeight : 0,
    viewportRows: vp,
    showModelReasoning,
  });
  // If span geometry drifted between renders (new entry appended, tool-stream
  // tail growing, height-cache estimate promoted to measured), any committed
  // selection rect now points at the wrong cards/rows. Clear it so a later
  // right-click cannot paste stale geometry — the user must start a new drag
  // against the current layout.
  const nextSignature = nextSpans
    .map((s) => `${s.entryId}:${s.viewportStartRow}:${s.viewportEndRow}`)
    .join('|');
  if (nextSignature !== spansSignatureRef.current) {
    // Only clear committed (inProgress === false) selections on geometry drift.
    // An active drag (inProgress === true) must survive the estimate→measured
    // height promotion that follows every fresh mount, otherwise the next
    // extendSelection no-ops (anchor null) and commitSelection returns false.
    if (
      selectionRef.current.anchor !== null &&
      !selectionRef.current.inProgress
    ) {
      selectionRef.current = { anchor: null, head: null, inProgress: false };
    }
    spansSignatureRef.current = nextSignature;
  }
  mountedGroupSpansRef.current = nextSpans;

  // ── Post-render measurement ─────────────────────────────────────────
  // Measure the groups actually mounted this frame and replace their cached
  // estimate with Ink's real geometry (persisted via the layout store).
  // `measureElement` returns the yoga box height (excludes margin), so the
  // turn-summary marginBottom is added back to match the rows the group
  // really occupies.
  //
  // Corrections this pass can make:
  // - Anchor clamp: if the top group's height shrank, keep the same group at
  //   the top and clamp its local clip instead of jumping into another entry.
  // - Bottom clamp: if measurements shrank the total below the anchor, re-pin
  //   so the viewport remains full.
  // - Underfill: if the mounted groups' real heights don't cover the
  //   viewport, mount more (bounded by MAX_UNDERFILL_BUMPS per position).
  // - Otherwise, a bare re-render nudge so thumb geometry and future mount
  //   plans see the corrected heights.
  useLayoutEffect(() => {
    let changed = false;
    for (const group of renderGroups) {
      const gid = renderGroupId(group);
      const node = entryNodeRefs.current.get(gid);
      if (!node) {
        // A zero-height/collapsed group may not expose a measurable node. Mark
        // it visited so a later group-list refresh does not overwrite a live
        // cache decision with a heuristic estimate.
        if (!measuredGroupIdsRef.current.has(gid)) {
          measuredGroupIdsRef.current.add(gid);
          changed = true;
        }
        continue;
      }
      const margin = group.type !== 'tool-group' && group.entry.kind === 'turn-summary' ? 1 : 0;
      const actual = measureElement(node).height + margin;
      if (!measuredGroupIdsRef.current.has(gid)) {
        measuredGroupIdsRef.current.add(gid);
        changed = true;
      }
      // Zero is a real measurement (hidden thinking entries render nothing).
      // Skipping it would leave the seeded estimate in the cache forever:
      // phantom rows the wheel scrolls through without the screen moving,
      // and blank bands the underfill correction cannot detect.
      if (actual < 0) continue;
      if (heightCache.getHeight(gid) !== actual) {
        heightCache.record(gid, actual);
        changed = true;
      }
      // Promote an estimate even when it happened to equal the Yoga height.
      // Otherwise the row is exact in memory but remains tagged `estimated`
      // on disk and is needlessly remeasured on resume.
      layoutStore?.markMeasured(gid, actual, termWidth);
    }

    const geom = geometryRef.current;
    const cur = effectiveAnchorRef.current;

    if (cur !== null) {
      if (maxTopRow(geom) <= 0) {
        applyAnchor(null);
        return;
      }
      const anchorId = groupIdsRef.current[cur.index];
      const anchorHeight = anchorId === undefined ? 1 : (heightCache.getHeight(anchorId) ?? 1);
      const normalizedClip = Math.max(0, Math.min(anchorHeight - 1, cur.clip));
      if (normalizedClip !== cur.clip) {
        applyAnchor({ index: cur.index, clip: normalizedClip });
        return;
      }
      const currentTop = heightCache.accumulatedHeight(cur.index) + normalizedClip;
      if (currentTop >= maxTopRow(geom)) {
        applyAnchor(null);
        return;
      }

      // Underfill: mounted rows below the clip must cover the viewport. Use
      // the normalized live anchor rather than the render-scope value so a
      // height correction is reflected immediately.
      const startTop = heightCache.accumulatedHeight(plan.startIdx);
      const mountedRows = heightCache.accumulatedHeight(plan.endIdx) - startTop;
      const visibleBudget = mountedRows - normalizedClip + (plan.mountTail ? geom.tailRows : 0);
      if (
        visibleBudget < geom.viewportRows &&
        plan.endIdx < geom.groupCount &&
        mountBump < MAX_UNDERFILL_BUMPS
      ) {
        setMountBump((bump) => Math.min(MAX_UNDERFILL_BUMPS, bump + 1));
        return;
      }
    } else {
      // Pinned underfill: trailing groups + tail must cover the viewport.
      const mountedRows = heightCache.totalHeight() - heightCache.accumulatedHeight(plan.startIdx);
      if (
        mountedRows + geom.tailRows < geom.viewportRows &&
        plan.startIdx > 0 &&
        mountBump < MAX_UNDERFILL_BUMPS
      ) {
        setMountBump((bump) => Math.min(MAX_UNDERFILL_BUMPS, bump + 1));
        return;
      }
    }

    // Trigger archive page load when the user is scrolled to the oldest
    // loaded group. Runs every render (no-dep useLayoutEffect) so scroll-
    // within-scrolled state is covered — not just scrolled transitions.
    // The `scrolled` guard prevents spurious requests when the mount plan
    // starts at index 0 while pinned (short conversation, all entries fit).
    if (
      scrolled &&
      planStartIdxRef.current === 0 &&
      onRequestOlderEntriesRef.current &&
      !requestOlderFiredRef.current
    ) {
      requestOlderFiredRef.current = true;
      onRequestOlderEntriesRef.current();
    }
    if (planStartIdxRef.current > 0) {
      requestOlderFiredRef.current = false;
    } else if (!scrolled) {
      // Pinned mode can also be at plan.startIdx === 0 (short transcript
      // fits the viewport). Without this `else if`, the flag stays set
      // forever after a fire during a scrolled-to-pinned transition and
      // the older-entries callback never fires again. Reset unconditionally
      // on non-zero OR non-scrolled.
      requestOlderFiredRef.current = false;
    }

    if (changed) setMeasureTick((tick) => tick + 1);
    // NO dependency array — deliberately. A group's rendered height can change
    // while every identity this component could list stays the same: an entry
    // mutated IN PLACE (tool spinner → result, stream tail collapsing into a
    // compact card, a diff box rendering shorter than its placeholder) keeps
    // its group id, so a keyed dep list skips the pass and the height cache
    // goes stale — pinned mode under-mounts (hole above the content) and a
    // scrolled anchor keeps a clip larger than its shrunken group. Measuring
    // is a cheap read of the already-computed yoga layout, the component is
    // memoized so commits are already scoped to real changes, and the
    // `changed` guard stops the tick from looping.
  });

  return (
    <Box flexDirection="row" width={viewportWidth}>
      <Box
        flexDirection="column"
        flexGrow={1}
        height={vp}
        overflowY="hidden"
        justifyContent={scrolled ? 'flex-start' : 'flex-end'}
      >
        <Box flexDirection="column" flexShrink={0} marginTop={scrolled && clip > 0 ? -clip : 0}>
          {/* Mounted groups, with consecutive same-tool calls compacted under
              one header. At scrolled positions the first group is the anchor:
              its clipped rows hide above the viewport via the negative margin.
              At pinned positions flex-end clips the overfill at the top. */}
          {renderGroups.map((group) => {
            const gid = renderGroupId(group);
            const setNode = (node: DOMElement | null): void => {
              if (node) entryNodeRefs.current.set(gid, node);
              else entryNodeRefs.current.delete(gid);
            };
            if (group.type === 'tool-group') {
              return (
                <Box key={`tool-group-${gid}`} ref={setNode} flexShrink={0}>
                  <EntryErrorBoundary label="tool group" resetKey={group.data.entries.length}>
                    <ToolGroup data={group.data} termWidth={termWidth} />
                  </EntryErrorBoundary>
                </Box>
              );
            }
            const { entry } = group;
            const entryEl = (
              <EntryErrorBoundary
                label={entry.kind}
                resetKey={
                  entry.kind === 'tool'
                    ? (entry.output?.length ?? 0)
                    : 'text' in entry
                      ? entry.text.length
                      : 0
                }
              >
                <Entry
                  entry={entry}
                  termWidth={termWidth}
                  termHeight={vp}
                  setSuggestions={setSuggestions}
                  autonomyMode={autonomyMode}
                  multiDiffSummaryThreshold={multiDiffSummaryThreshold}
                  todos={todos}
                  showModelReasoning={showModelReasoning}
                  showSageMemoryInject={showSageMemoryInject}
                />
              </EntryErrorBoundary>
            );
            return (
              <Box
                key={entry.id}
                ref={setNode}
                marginBottom={entry.kind === 'turn-summary' ? 1 : 0}
                flexShrink={0}
              >
                {entryEl}
              </Box>
            );
          })}

          {/* The live tool tail is a fixed-height suffix in the same scroll
              space: mounted whenever the window reaches the newest group, and
              clipped by the viewport like everything else. */}
          {plan.mountTail && toolTail && toolStream ? (
            <ToolStreamBox
              name={toolStream.name}
              text={toolTail}
              startedAt={toolStream.startedAt}
              termWidth={termWidth}
            />
          ) : null}
        </Box>
      </Box>
      <Scrollbar
        rows={vp}
        offset={offsetFromBottom}
        total={totalRows}
        copyHits={copyRailHits}
        copiedEntryId={copiedEntryId}
      />
    </Box>
  );
});

// Re-exported for convenience so app.tsx can import both from one module.
export type { HistoryEntry };
