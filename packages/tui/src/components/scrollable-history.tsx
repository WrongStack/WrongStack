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
  anchorAtTopRow,
  contentRows,
  maxTopRow,
  pageRows,
  planFromAnchor,
  planPinned,
  type ScrollAnchor,
  type ScrollGeometry,
} from '../scroll-anchor.js';
import { theme } from '../theme.js';
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

/** Build the live tool-stream header hit, accounting for ToolStreamBox's top margin. */
export function liveToolStreamCopyHit(opts: {
  visible: boolean;
  mountedRows: number;
  visibleClip: number;
  viewportRows: number;
  iconCol: number;
}): CopyHit | null {
  const headerRow = opts.mountedRows - opts.visibleClip + 1;
  if (!opts.visible || headerRow < 0 || headerRow >= opts.viewportRows) return null;
  return {
    entryId: LIVE_TOOL_STREAM_COPY_ID,
    startRow: headerRow,
    endRow: headerRow + 1,
    iconCol: opts.iconCol,
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
 * Right-edge scrollbar for the managed viewport. A 1-column track with a thumb
 * sized and positioned from the scroll offset, total height, and viewport rows.
 * Always reserves its column so toggling scrollability does not reflow content.
 */
function Scrollbar({
  rows,
  offset,
  total,
}: {
  rows: number;
  offset: number;
  total: number;
}): React.ReactElement {
  const { top: thumbTop, size: thumbSize, scrollable } = scrollbarThumb(rows, offset, total);
  const cells: string[] = [];
  for (let i = 0; i < rows; i++) {
    cells.push(i >= thumbTop && i < thumbTop + thumbSize ? '█' : '│');
  }
  return (
    <Box flexDirection="column" marginLeft={1} flexShrink={0}>
      {cells.map((c, i) => (
        <Text
          key={i}
          {...(scrollable ? { color: theme.accent } : {})}
          dimColor={!scrollable || c === '│'}
        >
          {c}
        </Text>
      ))}
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
 * One authoritative position for every scroll input.
 *
 * `topRow` is the absolute row at the viewport top. `null` is follow mode
 * (pinned to the newest output). A track gesture also keeps its normalized
 * ratio so late height measurements cannot move the thumb away from the
 * vertical point the user selected.
 */
interface ScrollPosition {
  topRow: number | null;
  trackRatio: number | null;
}

function resolvedTopRow(geometry: ScrollGeometry, position: ScrollPosition): number {
  const max = maxTopRow(geometry);
  if (position.topRow === null) return max;
  const requested =
    position.trackRatio === null
      ? position.topRow
      : Math.round(Math.max(0, Math.min(1, position.trackRatio)) * max);
  return Math.max(0, Math.min(max, Math.round(requested)));
}

/**
 * Bounded history viewport with absolute-row virtual scrolling.
 *
 * Instead of streaming entries into the terminal's native scrollback via
 * `<Static>`, retained entries render into a fixed-height `overflowY:'hidden'`
 * viewport the app scrolls itself. Wheel, PageUp/PageDown, and Ctrl+U/D scroll
 * it in every mode; full mouse mode additionally enables scrollbar interaction.
 * All paths use the {@link HistoryScrollController} this component owns.
 *
 * Positioning model (Ink-7 verified against real yoga layout):
 * - Pinned (`topRow:null`): `justifyContent:'flex-end'` + enough trailing
 *   groups mounted to overfill the viewport. Ink clips the overflow at the
 *   TOP, so the newest output hugs the input line with zero position math.
 * - Scrolled: wheel, page keys, and scrollbar gestures all update the same
 *   absolute content-row coordinate. That coordinate is translated to a
 *   render anchor for the current frame; groups mount from it downward and
 *   `marginTop:-clip` hides the preceding rows. Height corrections therefore
 *   re-resolve one coordinate instead of independently mutating an entry
 *   anchor, an offset, and a scrollbar ratio.
 *
 * The {@link EntryHeightCache} seeds the global row space and decides how many
 * groups to mount. A post-render `measureElement` pass promotes mounted groups
 * to real heights, persists them, and re-resolves the same absolute position
 * (or the same normalized track position) against the corrected total.
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
  layoutStore,
  copiedEntryId,
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
  const toolStreamRef = useRef(toolStream);
  toolStreamRef.current = toolStream;
  const entriesByIdRef = useRef(new Map<number, HistoryEntry>());
  entriesByIdRef.current = new Map(entries.map((entry) => [entry.id, entry]));
  // Exact global row-to-entry mapping is impossible while arbitrary markdown
  // groups still have heuristic heights. Once per terminal width, mount the
  // retained transcript inside the clipped viewport, measure it in one Yoga
  // pass, then return to a bounded virtual window.
  const calibratedWidthRef = useRef<number | null>(null);
  const preparedGroupIdsRef = useRef<string | null>(null);
  const preparedEstimateWidthRef = useRef<number | null>(null);
  // Key that changes when either the group set or the terminal width changes,
  // triggering a re-seed of the height cache. We deliberately do NOT include
  // `layoutStore.termWidth` here: it is updated INSIDE the guarded block below
  // (via setTermWidth), so including it would make the key change one render
  // later — causing a second seeding pass that discards freshly-measured
  // heights and replaces them with estimates, corrupting the viewport.
  const cacheKey = layoutStore ? `${groupIdsKey}|w${termWidth}` : groupIdsKey;
  if (preparedGroupIdsRef.current !== cacheKey || preparedEstimateWidthRef.current !== termWidth) {
    // `!== null` guards the first render: on mount `preparedEstimateWidthRef`
    // is null so widthChanged stays false, preserving the initial calibration
    // state. On subsequent renders a real width change clears the measured ids
    // and calibrated width so the cache re-seeds cleanly at the new dimension.
    const widthChanged =
      preparedEstimateWidthRef.current !== null && preparedEstimateWidthRef.current !== termWidth;
    if (widthChanged) {
      measuredGroupIdsRef.current.clear();
      calibratedWidthRef.current = null;
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
          const estimatedRows = estimateRenderGroupRows(group, termWidth);
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
      // No LayoutStore: fall back to heuristic estimates only.
      const estimateById = new Map(
        groupedEntries.map((group) => [
          renderGroupId(group),
          estimateRenderGroupRows(group, termWidth),
        ]),
      );
      heightCache.recordMany(
        groupIds
          .filter((id) => !measuredGroupIdsRef.current.has(id))
          .map((id) => [id, estimateById.get(id) ?? 3] as const),
      );
    }

    if (groupIds.length > 0 && groupIds.every((id) => measuredGroupIdsRef.current.has(id))) {
      calibratedWidthRef.current = termWidth;
    }
    preparedGroupIdsRef.current = cacheKey;
    preparedEstimateWidthRef.current = termWidth;
  }

  const vp = Math.max(1, viewportRows);

  // ── Scroll state ────────────────────────────────────────────────────
  // Keep one absolute top-row coordinate for wheel, page keys, and track
  // interaction. This is intentionally not stored as an entry ID: changing a
  // height estimate must not silently redefine what "row 400" means.
  const [position, setPosition] = useState<ScrollPosition>({
    topRow: null,
    trackRatio: null,
  });
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

  const topRow = resolvedTopRow(geometry, position);
  // Do not memoize this translation: post-render measurement mutates the
  // height cache in place and the measurement tick must re-run the prefix-sum
  // lookup even when every React identity is unchanged.
  const effectiveAnchor: ScrollAnchor | null =
    position.topRow === null ? null : anchorAtTopRow(geometry, topRow);
  const scrolled = effectiveAnchor !== null;

  // Latest-value refs for the stable controller callbacks.
  const geometryRef = useRef(geometry);
  geometryRef.current = geometry;
  const positionRef = useRef(position);
  positionRef.current = position;

  const applyPosition = useCallback(
    (requestedTopRow: number | null, trackRatio: number | null = null): void => {
      const geom = geometryRef.current;
      const max = maxTopRow(geom);
      const normalizedRatio = trackRatio === null ? null : Math.max(0, Math.min(1, trackRatio));
      const computedTop =
        requestedTopRow === null
          ? max
          : normalizedRatio === null
            ? Math.max(0, Math.min(max, Math.round(requestedTopRow)))
            : Math.round(normalizedRatio * max); // normalizedRatio ∈ [0,1] (clamped above)
      const next: ScrollPosition =
        max <= 0 || requestedTopRow === null || computedTop >= max
          ? { topRow: null, trackRatio: null }
          : { topRow: computedTop, trackRatio: normalizedRatio };
      // Raw stdin often batches many trackpad/wheel reports in one chunk. React
      // does not render between those controller calls, so update the imperative
      // ref immediately; otherwise every event computes from the same stale
      // coordinate and an entire gesture collapses to a single scroll step.
      positionRef.current = next;
      setPosition(next);
      setMountBump(0);
    },
    [],
  );

  const controller = useMemo<HistoryScrollController>(
    () => ({
      scrollBy: (deltaUp) => {
        const geom = geometryRef.current;
        const currentTop = resolvedTopRow(geom, positionRef.current);
        applyPosition(currentTop - deltaUp);
      },
      scrollPage: (dir) => {
        const geom = geometryRef.current;
        const rows = pageRows(geom.viewportRows);
        const currentTop = resolvedTopRow(geom, positionRef.current);
        applyPosition(currentTop + (dir === 'up' ? -rows : rows));
      },
      scrollToTop: () => {
        applyPosition(0);
      },
      scrollToBottom: () => {
        applyPosition(null);
      },
      scrollToTrackCell: (cell) => {
        const geom = geometryRef.current;
        const rows = Math.max(1, geom.viewportRows);
        const clampedCell = Math.max(0, Math.min(rows - 1, cell));
        const ratio = clampedCell / Math.max(1, rows - 1);
        applyPosition(Math.round(ratio * maxTopRow(geom)), ratio);
      },
      isScrolled: () => {
        const geom = geometryRef.current;
        return (
          positionRef.current.topRow !== null &&
          resolvedTopRow(geom, positionRef.current) < maxTopRow(geom)
        );
      },
      hasCopyTargetAt: (row, col) =>
        findCopyHit(copyHitsRef.current, row, col) !== null ||
        findCopyHit(
          liveToolCopyHitRef.current ? [liveToolCopyHitRef.current] : [],
          row,
          col,
        ) !== null,
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
    }),
    [applyPosition],
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
  const calibrating = groupedEntries.length > 0 && calibratedWidthRef.current !== termWidth;
  const plan = calibrating
    ? { startIdx: 0, endIdx: groupedEntries.length, mountTail: true }
    : effectiveAnchor
      ? planFromAnchor(geometry, effectiveAnchor, mountBump * bumpStep)
      : planPinned(geometry, mountBump * bumpStep);
  const renderGroups = groupedEntries.slice(plan.startIdx, plan.endIdx);
  // Calibration mounts from content row zero, so when scrolled its clip is
  // the full absolute top-row coordinate. When pinned (calibrating && !scrolled)
  // clip falls through to 0 — flex-end clips the overfill at the top. Normal
  // virtual frames mount from the anchor group and clip only inside that group.
  const clip = calibrating && scrolled ? topRow : (effectiveAnchor?.clip ?? 0);

  const totalRows = contentRows(geometry);
  const offsetFromBottom = scrolled ? Math.max(0, maxTopRow(geometry) - topRow) : 0;

  // ── Post-render measurement ─────────────────────────────────────────
  // Measure the groups actually mounted this frame and replace their cached
  // estimate with Ink's real geometry (persisted via the layout store).
  // `measureElement` returns the yoga box height (excludes margin), so the
  // turn-summary marginBottom is added back to match the rows the group
  // really occupies.
  //
  // Corrections this pass can make:
  // - Bottom clamp: if measurements shrank the total below the absolute
  //   coordinate, re-pin so the viewport remains full.
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
        // The DOM ref never resolved for this group (e.g. a zero-height or
        // collapsed group). It still counts as "measured" so the calibration
        // convergence condition (line 564-572) can be satisfied — without this
        // a missing node permanently blocks calibration and forces
        // full-transcript mount on every render at that width.
        if (!measuredGroupIdsRef.current.has(gid)) {
          measuredGroupIdsRef.current.add(gid);
          changed = true;
        }
        continue;
      }
      const margin = group.type !== 'tool-group' && group.entry.kind === 'turn-summary' ? 1 : 0;
      const actual = measureElement(node).height + margin;
      // Empty/collapsed groups render at height 0 but MUST still count as
      // measured: without this, the calibration convergence condition
      // (`every group is in measuredGroupIdsRef`) is impossible to satisfy and
      // the component permanently mounts the entire retained transcript on
      // every render at that width.
      if (!measuredGroupIdsRef.current.has(gid)) {
        measuredGroupIdsRef.current.add(gid);
        changed = true;
      }
      if (actual <= 0) continue;
      if (heightCache.getHeight(gid) !== actual) {
        heightCache.record(gid, actual);
        layoutStore?.markMeasured(gid, actual, termWidth);
        changed = true;
      }
    }

    // Rebuild the copy-icon click registry from the measured heights. Groups
    // render top-to-bottom, then the viewport hides either the scrolled anchor
    // clip or the top overflow from pinned flex-end clipping. A group's viewport
    // start row is its cumulative content offset minus that visible clip.
    // Every retained card gets a target; a compact tool group uses its first
    // entry id as the success-feedback id and also records every member id so
    // the complete grouped box can be copied in order. The icon sits on the
    // box's first visible row at the right edge of the content column.
    {
      const hits: CopyHit[] = [];
      const mountedGroupRows = renderGroups.reduce(
        (rows, group) => rows + (heightCache.getHeight(renderGroupId(group)) ?? 0),
        0,
      );
      const visibleClip = copyRegistryVisibleClip({
        scrolled,
        clip,
        mountedRows: mountedGroupRows,
        tailRows: plan.mountTail ? toolTailHeight : 0,
        viewportRows: vp,
      });
      let offset = 0; // content-space rows consumed by earlier mounted groups
      // The icon renders at the right edge of the content column. `termWidth`
      // is the content width (viewportWidth minus the SCROLLBAR_HIT_WIDTH
      // gutter), so the icon's 0-based left column is termWidth - COPY_ICON_WIDTH.
      //
      // INVARIANT: iconCol is relative to the history band's left edge. The
      // interactive mount (the only one whose clicks reach copyAtViewportCell via
      // app-key-handler's hitRegion) always renders the band flush at terminal
      // column 0, so this equals the absolute terminal column. The maxWidth /
      // right-panel isolated renderer is display-only and never routes clicks
      // here — if that ever changes, the click's absolute x must be translated by
      // the band's left offset before lookup.
      const iconCol = Math.max(0, termWidth - COPY_ICON_WIDTH);
      // No room to carve out an icon gutter without collapsing the content
      // column — skip the whole registry (matches the render-side guard).
      const iconFits = termWidth > COPY_ICON_WIDTH;
      for (const group of renderGroups) {
        const gid = renderGroupId(group);
        const groupHeight = heightCache.getHeight(gid) ?? 0;
        // Content-space start row of this group; advance the cumulative offset
        // for the next group before any early-continue below.
        const startRow = offset - visibleClip;
        offset += groupHeight;
        if (!iconFits) continue;
        const groupEntryIds =
          group.type === 'tool-group'
            ? group.data.entries.map((entry) => entry.id)
            : isCopyableEntry(group.entry) &&
                !(group.entry.kind === 'thinking' && showModelReasoning === false)
              ? [group.entry.id]
              : [];
        const entryId = groupEntryIds[0];
        if (entryId === undefined) continue;
        // The icon is painted on exactly the card's first row (the row
        // container aligns children to flex-start). When that row is scrolled
        // above the viewport top (startRow < 0) the icon is off-screen, so
        // register no target — otherwise a click at the top-right edge would
        // match a card whose icon the user cannot see. Skip cards whose first
        // row is at/below the viewport bottom. The hit spans only that single
        // row: [startRow, startRow + 1).
        if (startRow < 0 || startRow >= vp) continue;
        hits.push({
          entryId,
          ...(groupEntryIds.length > 1 ? { entryIds: groupEntryIds } : {}),
          startRow,
          endRow: startRow + 1,
          iconCol,
        });
      }
      copyHitsRef.current = hits;
      liveToolCopyHitRef.current = liveToolStreamCopyHit({
        visible: Boolean(iconFits && plan.mountTail && toolTail && toolStream),
        mountedRows: mountedGroupRows,
        visibleClip,
        viewportRows: vp,
        iconCol,
      });
    }

    if (
      calibrating &&
      renderGroups.length === groupedEntries.length &&
      groupedEntries.every((group) => measuredGroupIdsRef.current.has(renderGroupId(group)))
    ) {
      calibratedWidthRef.current = termWidth;
      changed = true;
    }

    const geom = geometryRef.current;
    const currentPosition = positionRef.current;
    const currentTop = resolvedTopRow(geom, currentPosition);
    const cur = currentPosition.topRow === null ? null : anchorAtTopRow(geom, currentTop);

    // Rounding a near-bottom track ratio, or a total-height correction, can
    // land exactly on the newest legal row. Treat that as real follow mode;
    // otherwise the next appended entry would unexpectedly un-pin the view.
    if (
      currentPosition.topRow !== null &&
      (maxTopRow(geom) <= 0 || currentTop >= maxTopRow(geom))
    ) {
      applyPosition(null);
      return;
    }

    if (cur !== null) {
      // Underfill: mounted rows below the clip must cover the viewport. Use
      // `cur.clip` (re-resolved from the post-measurement prefix sums) rather
      // than the render-scope `clip` so a height correction that shifts the
      // anchor index/clip is reflected immediately; the render-scope value can
      // be one correction stale and would nudge the bump counter by one.
      const startTop = heightCache.accumulatedHeight(plan.startIdx);
      const mountedRows = heightCache.accumulatedHeight(plan.endIdx) - startTop;
      const visibleBudget = mountedRows - cur.clip + (plan.mountTail ? geom.tailRows : 0);
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
              const entryId = group.data.entries[0]?.id;
              const copyable = entryId !== undefined && termWidth > COPY_ICON_WIDTH;
              const groupWidth = copyable ? termWidth - COPY_ICON_WIDTH : termWidth;
              return (
                <Box
                  key={`tool-group-${gid}`}
                  ref={setNode}
                  flexShrink={0}
                  flexDirection="row"
                  alignItems="flex-start"
                >
                  <Box flexGrow={1} flexShrink={1}>
                    <EntryErrorBoundary label="tool group" resetKey={group.data.entries.length}>
                      <ToolGroup data={group.data} termWidth={groupWidth} />
                    </EntryErrorBoundary>
                  </Box>
                  {copyable ? (
                    <Box width={COPY_ICON_WIDTH} flexShrink={0}>
                      <Text color={copiedEntryId === entryId ? theme.success : theme.textMuted}>
                        {COPY_ICON}
                      </Text>
                    </Box>
                  ) : null}
                </Box>
              );
            }
            const { entry } = group;
            // Copyable conversational and tool cards render a click-to-copy
            // icon in a 1-column gutter on the right. The Entry is narrowed by
            // the icon width so total height stays unchanged and the icon lands
            // on the exact column recorded by the copy hit registry. Only show
            // it when the content column still has at least one cell.
            const copyable =
              isCopyableEntry(entry) &&
              !(entry.kind === 'thinking' && showModelReasoning === false) &&
              termWidth > COPY_ICON_WIDTH;
            const entryWidth = copyable ? termWidth - COPY_ICON_WIDTH : termWidth;
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
                  termWidth={entryWidth}
                  termHeight={vp}
                  setSuggestions={setSuggestions}
                  autonomyMode={autonomyMode}
                  multiDiffSummaryThreshold={multiDiffSummaryThreshold}
                  todos={todos}
                  showModelReasoning={showModelReasoning}
                />
              </EntryErrorBoundary>
            );
            return (
              <Box
                key={entry.id}
                ref={setNode}
                marginBottom={entry.kind === 'turn-summary' ? 1 : 0}
                flexShrink={0}
                flexDirection="row"
                alignItems="flex-start"
              >
                <Box flexGrow={1} flexShrink={1}>
                  {entryEl}
                </Box>
                {copyable ? (
                  <Box width={COPY_ICON_WIDTH} flexShrink={0}>
                    {/* Flash this card's icon in the success color for the brief
                        window the host keeps copiedEntryId set on it, so the
                        clicked card gives visual feedback beside the status-line
                        "Copied" notice. Otherwise it stays quietly muted. */}
                    <Text color={copiedEntryId === entry.id ? theme.success : theme.textMuted}>
                      {COPY_ICON}
                    </Text>
                  </Box>
                ) : null}
              </Box>
            );
          })}

          {/* The live tool tail is a fixed-height suffix in the same scroll
              space: mounted whenever the window reaches the newest group, and
              clipped by the viewport like everything else. */}
          {plan.mountTail && toolTail && toolStream ? (
            <Box flexDirection="row" alignItems="flex-start" flexShrink={0}>
              <Box flexGrow={1} flexShrink={1}>
                <ToolStreamBox
                  name={toolStream.name}
                  text={toolTail}
                  startedAt={toolStream.startedAt}
                  termWidth={Math.max(1, termWidth - COPY_ICON_WIDTH)}
                />
              </Box>
              <Box width={COPY_ICON_WIDTH} flexShrink={0} marginTop={1}>
                <Text
                  color={
                    copiedEntryId === LIVE_TOOL_STREAM_COPY_ID ? theme.success : theme.textMuted
                  }
                >
                  {COPY_ICON}
                </Text>
              </Box>
            </Box>
          ) : null}
        </Box>
      </Box>
      <Scrollbar rows={vp} offset={offsetFromBottom} total={totalRows} />
    </Box>
  );
});

// Re-exported for convenience so app.tsx can import both from one module.
export type { HistoryEntry };
