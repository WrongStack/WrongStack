import type React from 'react';
import {
  memo,
  type MutableRefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { EntryHeightCache } from '../height-cache.js';
import { computeLayout } from '../layout-engine.js';
import { SCROLLBAR_HIT_WIDTH } from '../hit-test.js';
import { Box, type DOMElement, measureElement, Text, useStdout } from '../ink.js';
import {
  anchorAtTopRow,
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
  const rawTop = Math.round((windowTop / total) * rows);
  const top = Math.max(0, Math.min(rawTop, rows - size));
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
 * Bounded history viewport with anchor-based virtual scrolling.
 *
 * Instead of streaming entries into the terminal's native scrollback via
 * `<Static>`, retained entries render into a fixed-height `overflowY:'hidden'`
 * viewport the app scrolls itself. Wheel, PageUp/PageDown, and Ctrl+U/D scroll
 * it in every mode; full mouse mode additionally enables scrollbar interaction.
 * All paths use the {@link HistoryScrollController} this component owns.
 *
 * Positioning model (Ink-7 verified against real yoga layout):
 * - Pinned (anchor `null`): `justifyContent:'flex-end'` + enough trailing
 *   groups mounted to overfill the viewport. Ink clips the overflow at the
 *   TOP, so the newest output hugs the input line with zero position math.
 * - Scrolled (anchor set): `justifyContent:'flex-start'`; groups mount from
 *   the anchor downward and the inner column gets `marginTop:-clip`, hiding
 *   exactly the anchor rows above the viewport. Ink clips the excess at the
 *   BOTTOM. What is on screen therefore depends ONLY on the anchor and the
 *   real heights of mounted groups — estimated heights of off-window content
 *   cannot move anything. There are no spacer elements to misalign.
 *
 * Height estimates are still kept (in the {@link EntryHeightCache}) but are
 * demoted to two harmless jobs: deciding how many groups to mount (overfill is
 * clipped; underfill self-corrects after measurement) and sizing the scrollbar
 * thumb. A post-render `measureElement` pass promotes every mounted group to
 * its real height and persists it via the layout store.
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
  const groupIndexById = useMemo(() => {
    const map = new Map<number, number>();
    groupIds.forEach((id, index) => {
      map.set(id, index);
    });
    return map;
  }, [groupIds]);
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
  const preparedGroupIdsRef = useRef<string | null>(null);
  const preparedEstimateWidthRef = useRef<number | null>(null);
  // Key that changes when either the group set or the terminal width changes,
  // triggering a re-seed of the height cache. We deliberately do NOT include
  // `layoutStore.termWidth` here: it is updated INSIDE the guarded block below
  // (via setTermWidth), so including it would make the key change one render
  // later — causing a second seeding pass that discards freshly-measured
  // heights and replaces them with estimates, corrupting the viewport.
  const cacheKey = layoutStore
    ? `${groupIdsKey}|w${termWidth}`
    : groupIdsKey;
  if (
    preparedGroupIdsRef.current !== cacheKey ||
    preparedEstimateWidthRef.current !== termWidth
  ) {
    heightCache.sync(groupIds);

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
          // Use the stored layout — it is either a previous measurement or
          // a persisted estimate from a previous session.
          heightCache.record(id, stored.rows);
        } else {
          // New entry: compute a heuristic estimate and seed the store.
          const estimatedRows = estimateRenderGroupRows(group, termWidth);
          heightCache.record(id, estimatedRows);
          const kind = group.type === 'tool-group' ? 'tool-group' : group.entry.kind;
          const text = group.type === 'tool-group' ? group.data.name : (group.entry as { text?: string }).text ?? '';
          layoutStore.set(id, computeLayout(id, kind, text, termWidth, { ...(group.type === 'tool-group' ? { groupCount: group.data.entries.length } : {}) }));
        }
      }
    } else {
      // No LayoutStore: fall back to heuristic estimates only.
      const estimateById = new Map(
        groupedEntries.map((group) => [renderGroupId(group), estimateRenderGroupRows(group, termWidth)]),
      );
      heightCache.recordMany(groupIds.map((id) => [id, estimateById.get(id) ?? 3] as const));
    }

    preparedGroupIdsRef.current = cacheKey;
    preparedEstimateWidthRef.current = termWidth;
  }

  const vp = Math.max(1, viewportRows);

  // ── Scroll state ────────────────────────────────────────────────────
  // The anchor is stored by render-group ID (stable across retention
  // evictions, which shift indexes) plus the rows of that group clipped above
  // the viewport top. `null` = pinned to the newest output.
  const [anchor, setAnchor] = useState<{ id: number; clip: number } | null>(null);
  // Underfill-correction steps for the current anchor position: each step
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

  // Resolve the stored anchor to an index-based one for this frame. A missing
  // id (evicted from the top by retention) degrades to the oldest retained
  // group; an anchor that no longer scrolls (content fits) degrades to pinned.
  const effectiveAnchor: ScrollAnchor | null = useMemo(() => {
    if (anchor === null || groupedEntries.length === 0) return null;
    if (maxTopRow(geometry) <= 0) return null;
    const index = groupIndexById.get(anchor.id);
    if (index === undefined) return { index: 0, clip: 0 };
    return { index, clip: Math.max(0, anchor.clip) };
    // geometry is rebuilt per render from values covered by these deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, groupIndexById, groupedEntries.length, cacheKey, vp, toolTailHeight]);
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
    // Raw stdin often batches many trackpad/wheel reports in one chunk. React
    // does not render between those controller calls, so update the imperative
    // ref immediately; otherwise every event computes from the same stale
    // anchor and an entire gesture collapses to a single scroll step.
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
        applyAnchor(anchorForTrackCell(geometryRef.current, cell));
      },
      isScrolled: () => effectiveAnchorRef.current !== null,
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

  const totalRows = contentRows(geometry);
  const offsetFromBottom = scrolled
    ? Math.max(0, maxTopRow(geometry) - anchorTopRow(geometry, effectiveAnchor))
    : 0;

  // ── Post-render measurement ─────────────────────────────────────────
  // Measure the groups actually mounted this frame and replace their cached
  // estimate with Ink's real geometry (persisted via the layout store).
  // `measureElement` returns the yoga box height (excludes margin), so the
  // turn-summary marginBottom is added back to match the rows the group
  // really occupies.
  //
  // Corrections this pass can make — all local, none can move the viewport:
  // - Anchor normalization: if the anchor group's real height turns out to be
  //   at most `clip` (its estimate was too big), advance the anchor into the
  //   following group(s) so the top of the viewport still shows real content.
  // - Bottom clamp: if measurements shrank the total, keep the viewport full.
  // - Underfill: if the mounted groups' real heights don't cover the
  //   viewport, mount more (bounded by MAX_UNDERFILL_BUMPS per position).
  // - Otherwise, a bare re-render nudge so thumb geometry and future mount
  //   plans see the corrected heights.
  useLayoutEffect(() => {
    let changed = false;
    for (const group of renderGroups) {
      const gid = renderGroupId(group);
      const node = entryNodeRefs.current.get(gid);
      if (!node) continue;
      const margin =
        group.type !== 'tool-group' && group.entry.kind === 'turn-summary' ? 1 : 0;
      const actual = measureElement(node).height + margin;
      if (actual <= 0) continue;
      if (heightCache.getHeight(gid) !== actual) {
        heightCache.record(gid, actual);
        layoutStore?.markMeasured(gid, actual, termWidth);
        changed = true;
      }
    }

    const geom = geometryRef.current;
    const cur = effectiveAnchorRef.current;

    if (cur !== null) {
      // Anchor normalization: keep 0 <= clip < height(anchor group).
      if (maxTopRow(geom) <= 0) {
        applyAnchor(null);
        return;
      }
      let { index, clip: nextClip } = cur;
      let advanced = false;
      let height = heightCache.getHeight(groupIdsRef.current[index] ?? -1) ?? 1;
      while (nextClip >= height) {
        if (index >= geom.groupCount - 1) {
          applyAnchor(null);
          return;
        }
        nextClip -= height;
        index += 1;
        height = heightCache.getHeight(groupIdsRef.current[index] ?? -1) ?? 1;
        advanced = true;
      }
      if (advanced) {
        applyAnchor({ index, clip: nextClip });
        return;
      }
      // Bottom clamp: measurements may have SHRUNK the total so the anchor now
      // sits within a viewport of the end (or past it). Re-clamp so the last
      // rows always fill the viewport instead of leaving a blank bottom.
      const topRow = heightCache.accumulatedHeight(index) + nextClip;
      if (topRow > maxTopRow(geom)) {
        applyAnchor(anchorAtTopRow(geom, topRow));
        return;
      }
      // Underfill: mounted rows below the clip must cover the viewport.
      const startTop = heightCache.accumulatedHeight(plan.startIdx);
      const mountedRows = heightCache.accumulatedHeight(plan.endIdx) - startTop;
      const visibleBudget =
        mountedRows - cur.clip + (plan.mountTail ? geom.tailRows : 0);
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
      const mountedRows =
        heightCache.totalHeight() - heightCache.accumulatedHeight(plan.startIdx);
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
        <Box
          flexDirection="column"
          flexShrink={0}
          marginTop={scrolled && clip > 0 ? -clip : 0}
        >
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
            return (
              <Box
                key={entry.id}
                ref={setNode}
                marginBottom={entry.kind === 'turn-summary' ? 1 : 0}
                flexShrink={0}
              >
                <EntryErrorBoundary
                  label={entry.kind}
                  resetKey={entry.kind === 'tool' ? (entry.output?.length ?? 0) : 'text' in entry ? entry.text.length : 0}
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
      <Scrollbar rows={vp} offset={offsetFromBottom} total={totalRows} />
    </Box>
  );
});

// Re-exported for convenience so app.tsx can import both from one module.
export type { HistoryEntry };
