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
import { EntryHeightCache } from '../height-cache.js';
import { SCROLLBAR_HIT_WIDTH } from '../hit-test.js';
import { Box, type DOMElement, measureElement, useStdout } from '../ink.js';
import { computeLayout } from '../layout-engine.js';
import {
  anchorTopRow,
  contentRows,
  maxTopRow,
  planFromAnchor,
  planPinned,
  type ScrollAnchor,
  type ScrollGeometry,
} from '../scroll-anchor.js';
import { setTuiHistoryMemoryGauges } from '../tui-memory-counters.js';
import { EntryErrorBoundary } from './entry-error-boundary.js';
import { buildCopyRegistry } from './history/copy-registry.js';
import {
  estimateRenderGroupRows,
  groupEntries,
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
import { useHistoryController } from './history/use-history-controller.js';
import {
  createSelectionBandStore,
  type SelectionBandStore,
} from './history/selection-band-store.js';

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
  type MountedCardSpan,
  buildMountedCardSpans,
} from './history/scrollbar-geometry.js';
import { Scrollbar } from './history/scrollbar-rail.js';
import type { ScrollableHistoryProps } from './history/scroll-controller-types.js';

/** Minimum extra rows mounted per underfill-correction step. */
const UNDERFILL_BUMP_ROWS = 16;
/** Cap on underfill-correction steps per anchor position (loop guard). */
const MAX_UNDERFILL_BUMPS = 8;

/**
 * Bounded history viewport with stable-anchor virtual scrolling.
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
  const termWidth = useMemo(
    () => Math.max(1, viewportWidth - SCROLLBAR_HIT_WIDTH),
    [viewportWidth],
  );
  useEffect(() => {
    const handleResize = () => {
      setViewportWidth(resolveViewportWidth());
    };
    handleResize();
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

  const heightCacheRef = useRef<EntryHeightCache | null>(null);
  if (heightCacheRef.current === null) heightCacheRef.current = new EntryHeightCache();
  const heightCache = heightCacheRef.current;
  // Instance-scoped highlight-band store: survives re-renders, dies with this
  // component (a history-gen remount gets a fresh store). The controller
  // publishes selection geometry here; the Scrollbar subscribes. No card
  // ever re-renders on drag motion because none subscribe.
  const selectionBandStoreRef = useRef<SelectionBandStore | null>(null);
  if (selectionBandStoreRef.current === null) {
    selectionBandStoreRef.current = createSelectionBandStore();
  }
  const selectionBandStore = selectionBandStoreRef.current;
  const entryNodeRefs = useRef(new Map<number, DOMElement>());
  const measuredGroupIdsRef = useRef(new Set<number>());
  const copyHitsRef = useRef<CopyHit[]>([]);
  const liveToolCopyHitRef = useRef<CopyHit | null>(null);
  const mountedGroupSpansRef = useRef<readonly MountedCardSpan[]>([]);
  const spansSignatureRef = useRef('');
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

  const reasoningKey = showModelReasoning === false ? '|r0' : '';
  const sageKey = showSageMemoryInject === false ? '|s0' : '';
  const cacheKey =
    (layoutStore ? `${groupIdsKey}|w${termWidth}` : groupIdsKey) + reasoningKey + sageKey;
  if (preparedGroupIdsRef.current !== cacheKey || preparedEstimateWidthRef.current !== termWidth) {
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
      layoutStore.setTermWidth(termWidth);
      layoutStore.retain(new Set(groupIds));
      for (const group of groupedEntries) {
        const id = renderGroupId(group);
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
          if (stored.kind === 'measured' || !measuredGroupIdsRef.current.has(id)) {
            heightCache.record(id, stored.rows);
          }
          if (stored.kind === 'measured') measuredGroupIdsRef.current.add(id);
        } else {
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

  const [anchor, setAnchor] = useState<{ id: number; clip: number } | null>(null);
  const [mountBump, setMountBump] = useState(0);

  const prevTermWidthRef = useRef(termWidth);
  if (prevTermWidthRef.current !== termWidth) {
    prevTermWidthRef.current = termWidth;
    setMountBump(0);
  }
  const prevVpRef = useRef(viewportRows);
  if (prevVpRef.current !== viewportRows) {
    prevVpRef.current = viewportRows;
    setMountBump(0);
  }
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

  const { applyAnchor } = useHistoryController({
    geometry,
    effectiveAnchor,
    groupIds,
    termWidth,
    vp,
    copyHitsRef,
    liveToolCopyHitRef,
    mountedGroupSpansRef,
    selectionRef,
    entriesByIdRef,
    toolStreamRef,
    selectionBandStore,
    setAnchor,
    setMountBump,
    controllerRef,
  });

  const lastReportedScrolled = useRef<boolean | null>(null);
  const onScrollInfoRef = useRef(onScrollInfo);
  onScrollInfoRef.current = onScrollInfo;
  const planStartIdxRef = useRef(0);
  const requestOlderFiredRef = useRef(false);
  const onRequestOlderEntriesRef = useRef(onRequestOlderEntries);
  onRequestOlderEntriesRef.current = onRequestOlderEntries;
  useEffect(() => {
    if (lastReportedScrolled.current === scrolled) return;
    lastReportedScrolled.current = scrolled;
    onScrollInfoRef.current?.({ scrolled });
  }, [scrolled]);

  const bumpStep = Math.max(UNDERFILL_BUMP_ROWS, vp);
  const plan = effectiveAnchor
    ? planFromAnchor(geometry, effectiveAnchor, mountBump * bumpStep)
    : planPinned(geometry, mountBump * bumpStep);
  const renderGroups = groupedEntries.slice(plan.startIdx, plan.endIdx);
  const clip = effectiveAnchor?.clip ?? 0;
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

  const nextSpans = buildMountedCardSpans({
    renderGroups,
    heightCache,
    scrolled,
    clip,
    tailRows: plan.mountTail ? toolTailHeight : 0,
    viewportRows: vp,
    showModelReasoning,
  });

  const nextSignature = nextSpans
    .map((s) => `${s.entryId}:${s.viewportStartRow}:${s.viewportEndRow}`)
    .join('|');
  if (nextSignature !== spansSignatureRef.current) {
    if (
      selectionRef.current.anchor !== null &&
      !selectionRef.current.inProgress
    ) {
      selectionRef.current = { anchor: null, head: null, inProgress: false };
    }
    spansSignatureRef.current = nextSignature;
  }
  mountedGroupSpansRef.current = nextSpans;

  useLayoutEffect(() => {
    let changed = false;
    for (const group of renderGroups) {
      const gid = renderGroupId(group);
      const node = entryNodeRefs.current.get(gid);
      if (!node) {
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
      if (actual < 0) continue;
      if (heightCache.getHeight(gid) !== actual) {
        heightCache.record(gid, actual);
        changed = true;
      }
      layoutStore?.markMeasured(gid, actual, termWidth);
    }

    const cur = effectiveAnchor;

    if (cur !== null) {
      if (maxTopRow(geometry) <= 0) {
        applyAnchor(null);
        return;
      }
      const anchorId = groupIds[cur.index];
      const anchorHeight = anchorId === undefined ? 1 : (heightCache.getHeight(anchorId) ?? 1);
      const normalizedClip = Math.max(0, Math.min(anchorHeight - 1, cur.clip));
      if (normalizedClip !== cur.clip) {
        applyAnchor({ index: cur.index, clip: normalizedClip });
        return;
      }
      const currentTop = heightCache.accumulatedHeight(cur.index) + normalizedClip;
      if (currentTop >= maxTopRow(geometry)) {
        applyAnchor(null);
        return;
      }

      const startTop = heightCache.accumulatedHeight(plan.startIdx);
      const mountedRows = heightCache.accumulatedHeight(plan.endIdx) - startTop;
      const visibleBudget = mountedRows - normalizedClip + (plan.mountTail ? geometry.tailRows : 0);
      if (
        visibleBudget < geometry.viewportRows &&
        plan.endIdx < geometry.groupCount &&
        mountBump < MAX_UNDERFILL_BUMPS
      ) {
        setMountBump((bump) => Math.min(MAX_UNDERFILL_BUMPS, bump + 1));
        return;
      }
    } else {
      const mountedRows = heightCache.totalHeight() - heightCache.accumulatedHeight(plan.startIdx);
      if (
        mountedRows + geometry.tailRows < geometry.viewportRows &&
        plan.startIdx > 0 &&
        mountBump < MAX_UNDERFILL_BUMPS
      ) {
        setMountBump((bump) => Math.min(MAX_UNDERFILL_BUMPS, bump + 1));
        return;
      }
    }

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
      requestOlderFiredRef.current = false;
    }

    if (changed) setMeasureTick((tick) => tick + 1);
  });

  return (
    <Box flexDirection="row" width={viewportWidth}>
      <Box
        flexDirection="column"
        width={termWidth}
        flexShrink={0}
        height={vp}
        overflowX="hidden"
        overflowY="hidden"
        justifyContent={scrolled ? 'flex-start' : 'flex-end'}
      >
        <Box flexDirection="column" flexShrink={0} marginTop={scrolled && clip > 0 ? -clip : 0}>
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
        selectionBandStore={selectionBandStore}
      />
    </Box>
  );
});

export type { HistoryEntry };
