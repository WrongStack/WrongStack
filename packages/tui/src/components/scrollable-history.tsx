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
  const hits: CopyHit[] = [];
  let offset = 0;
  for (const group of opts.renderGroups) {
    const gid = renderGroupId(group);
    const groupHeight = opts.heightCache.getHeight(gid) ?? 0;
    const startRow = offset - visibleClip;
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
  const cacheKey =
    (layoutStore ? `${groupIdsKey}|w${termWidth}` : groupIdsKey) + reasoningKey;
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
        if (group.type !== 'tool-group' && group.entry.kind === 'thinking' && showModelReasoning === false) {
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
          return [id, hidden ? 0 : estimateRenderGroupRows(group, termWidth)] as const;
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
    }),
    [applyAnchor],
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
