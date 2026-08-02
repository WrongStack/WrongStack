import type React from 'react';
import {
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
import { Box, type DOMElement, measureElement, useStdout } from '../ink.js';
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
import { setTuiHistoryMemoryGauges } from '../tui-memory-counters.js';
import { EntryErrorBoundary } from './entry-error-boundary.js';
import {
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
  MAX_STREAM_DISPLAY_CHARS,
  ToolStreamBox,
  tailForDisplay,
  toolStreamBoxHeight,
} from './history.js';

// ── Re-exports from extracted modules ────────────────────────────────────
export type {
  HistoryScrollController,
  ScrollableHistoryProps,
} from './history/scroll-controller-types.js';
export {
  type CopyHit,
  LIVE_TOOL_STREAM_COPY_ID,
  SELECTION_COPY_ID,
  findCopyHit,
  resolveCopyPayload,
  copyRegistryVisibleClip,
  liveToolStreamCopyHit,
} from './history/copy-geometry.js';
export {
  type SelectionRect,
  type SelectionSlice,
  normalizeSelection,
  isOutOfBand,
  selectionToSlices,
  assembleSelectionText,
} from './history/selection-helpers.js';
export {
  type MountedCardSpan,
  scrollbarThumb,
  scrollOffsetForTrackRow,
  buildMountedCardSpans,
  selectionHitAt,
} from './history/scrollbar-geometry.js';
export { Scrollbar } from './history/scrollbar-rail.js';

// ── Internal imports from extracted modules ──────────────────────────────
import type { CopyHit } from './history/copy-geometry.js';
import {
  findCopyHit,
  resolveCopyPayload,
  copyRegistryVisibleClip,
  liveToolStreamCopyHit,
} from './history/copy-geometry.js';
import {
  normalizeSelection,
  isOutOfBand,
  selectionToSlices,
  assembleSelectionText,
} from './history/selection-helpers.js';
import {
  type MountedCardSpan,
  buildMountedCardSpans,
  selectionHitAt,
} from './history/scrollbar-geometry.js';
import { Scrollbar } from './history/scrollbar-rail.js';
import type { HistoryScrollController, ScrollableHistoryProps } from './history/scroll-controller-types.js';

// ── Internal: copy-hit registry builder ──────────────────────────────────

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
