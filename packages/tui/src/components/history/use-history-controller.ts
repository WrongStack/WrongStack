import { useCallback, useEffect, useMemo, useRef } from 'react';
import { writeClipboardText } from '../../clipboard.js';
import {
  anchorForTrackCell,
  pageRows,
  type ScrollAnchor,
  type ScrollGeometry,
  scrollAnchorBy,
  scrollAnchorToTop,
} from '../../scroll-anchor.js';
import { MESSAGE_PANEL_CHROME_WIDTH } from './assistant.js';
import type { CopyHit } from './copy-geometry.js';
import { findCopyHit, resolveCopyPayload } from './copy-geometry.js';
import type { HistoryScrollController } from './scroll-controller-types.js';
import type { MountedCardSpan } from './scrollbar-geometry.js';
import { selectionHitAt } from './scrollbar-geometry.js';
import { bandFromSelection, type SelectionBandStore } from './selection-band-store.js';
import {
  assembleSelectionText,
  isOutOfBand,
  normalizeSelection,
  selectionToSlices,
} from './selection-helpers.js';
import type { HistoryEntry } from './types.js';

export interface UseHistoryControllerOptions {
  geometry: ScrollGeometry;
  effectiveAnchor: ScrollAnchor | null;
  groupIds: readonly number[];
  termWidth: number;
  vp: number;
  copyHitsRef: { current: CopyHit[] };
  liveToolCopyHitRef: { current: CopyHit | null };
  mountedGroupSpansRef: { current: readonly MountedCardSpan[] };
  selectionRef: {
    current: {
      anchor: { row: number; col: number } | null;
      head: { row: number; col: number } | null;
      inProgress: boolean;
    };
  };
  entriesByIdRef: { current: Map<number, HistoryEntry> };
  toolStreamRef: { current: { name: string; text: string; startedAt: number } | null | undefined };
  /** External store for the drag-selection highlight band. The controller
   * publishes selection geometry here so the rail leaf can re-render on
   * drag motion WITHOUT any history card re-rendering. */
  selectionBandStore?: SelectionBandStore | undefined;
  setAnchor: (anchor: { id: number; clip: number } | null) => void;
  setMountBump: (bump: number) => void;
  controllerRef?: { current: HistoryScrollController | null } | undefined;
}

export function useHistoryController(opts: UseHistoryControllerOptions): {
  controller: HistoryScrollController;
  applyAnchor: (next: ScrollAnchor | null) => void;
  effectiveAnchorRef: { current: ScrollAnchor | null };
  geometryRef: { current: ScrollGeometry };
  groupIdsRef: { current: readonly number[] };
} {
  const {
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
  } = opts;

  const geometryRef = useRef(geometry);
  geometryRef.current = geometry;
  const effectiveAnchorRef = useRef(effectiveAnchor);
  effectiveAnchorRef.current = effectiveAnchor;
  const groupIdsRef = useRef(groupIds);
  groupIdsRef.current = groupIds;

  const publishBand = useCallback((): void => {
    const cur = selectionRef.current;
    selectionBandStore?.publish(
      cur.anchor !== null && cur.head !== null && cur.inProgress
        ? bandFromSelection(cur.anchor, cur.head)
        : null,
    );
  }, [selectionBandStore, selectionRef]);

  // ── Gutter translation (v1.1 M3) ──────────────────────────────────────
  // Slice columns are contractually body-local, but the mouse handler passes
  // history-band columns; a press on a bordered card's border/padding column
  // would otherwise masquerade as text column 0..1 and skew every later
  // offset. The controller owns the card-kind knowledge (via the mounted
  // spans + entry map), so the translation lives here: gutter columns clamp
  // to the text start — the standard editor behavior where a margin click
  // selects from the line's first character.
  const gutterWidthForEntry = (entryId: number | undefined): number => {
    if (entryId === undefined) return 0;
    const entry = entriesByIdRef.current.get(entryId);
    if (!entry) return 0;
    // Only kinds whose render shape is verified this session carry the
    // bordered-panel gutter (entry.tsx: borderStyle single + paddingLeft 1,
    // i.e. MESSAGE_PANEL_CHROME_WIDTH). Tool groups and the remaining kinds
    // pass the raw column through unchanged.
    return entry.kind === 'assistant' || entry.kind === 'thinking' || entry.kind === 'user'
      ? MESSAGE_PANEL_CHROME_WIDTH
      : 0;
  };

  /** Translate a history-band column to card-body-local coordinates for the
   * card occupying `row`. Gutter columns clamp to 0 (text start); rows that
   * are not on a card (blank gaps) pass the column through unchanged. */
  const toBodyLocalCol = (row: number, col: number): number => {
    const hit = selectionHitAt(row, mountedGroupSpansRef.current);
    const gutter = gutterWidthForEntry(hit?.entryId);
    return gutter === 0 ? col : Math.max(0, col - gutter);
  };

  const applyAnchor = useCallback(
    (next: ScrollAnchor | null): void => {
      const ids = groupIdsRef.current;
      const nextId = next ? ids[next.index] : undefined;
      const normalized =
        next && nextId !== undefined ? { index: next.index, clip: Math.max(0, next.clip) } : null;
      selectionRef.current = { anchor: null, head: null, inProgress: false };
      publishBand();
      effectiveAnchorRef.current = normalized;
      setAnchor(normalized && nextId !== undefined ? { id: nextId, clip: normalized.clip } : null);
      setMountBump(0);
    },
    [selectionRef, publishBand, setAnchor, setMountBump],
  );

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
        if (isOutOfBand(col, termWidth)) {
          selectionRef.current = { anchor: null, head: null, inProgress: false };
          publishBand();
          return;
        }
        const cardHit = selectionHitAt(row, mountedGroupSpansRef.current);
        if (cardHit === null) {
          selectionRef.current = { anchor: null, head: null, inProgress: false };
          publishBand();
          return;
        }
        const bodyCol = toBodyLocalCol(row, col);
        selectionRef.current = {
          anchor: { row, col: bodyCol },
          head: { row, col: bodyCol },
          inProgress: true,
        };
        publishBand();
      },
      extendSelection: (row, col) => {
        const cur = selectionRef.current;
        if (cur.anchor === null) return;
        if (cur.inProgress === false) return;
        if (isOutOfBand(col, termWidth) || row < 0 || row >= vp) {
          selectionRef.current = { anchor: null, head: null, inProgress: false };
          publishBand();
          return;
        }
        selectionRef.current = { ...cur, head: { row, col: toBodyLocalCol(row, col) } };
        publishBand();
      },
      endSelection: () => {
        // Superseded by release-commits-copy: the release path goes straight
        // to hasSelection/commitSelection. Retained only if a caller still
        // needs the intermediate "ended but not committed" state.
        const cur = selectionRef.current;
        if (cur.anchor === null) return;
        selectionRef.current = { ...cur, inProgress: false };
        publishBand();
      },
      hasSelection: () => selectionRef.current.anchor !== null,
      clearSelection: () => {
        const cur = selectionRef.current;
        if (cur.anchor === null && cur.head === null) return;
        selectionRef.current = { anchor: null, head: null, inProgress: false };
        publishBand();
      },
      commitSelection: async () => {
        const cur = selectionRef.current;
        if (cur.anchor === null || cur.head === null) return false;
        if (cur.anchor.row === cur.head.row && cur.anchor.col === cur.head.col) {
          selectionRef.current = { anchor: null, head: null, inProgress: false };
          publishBand();
          return false;
        }
        const rect = normalizeSelection(cur.anchor, cur.head, cur.inProgress);
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
          // Wrap-aware row→line translation (v1.1 M4): termWidth is the same
          // render width the card geometry was built with.
          termWidth,
          ...(toolGroupsByHeadId.size > 0 ? { toolGroupsByHeadId } : {}),
        });
        selectionRef.current = { anchor: null, head: null, inProgress: false };
        publishBand();
        if (text.length === 0) return false;
        try {
          return await writeClipboardText(text);
        } catch {
          return false;
        }
      },
    }),
    [
      applyAnchor,
      publishBand,
      termWidth,
      vp,
      copyHitsRef,
      liveToolCopyHitRef,
      mountedGroupSpansRef,
      selectionRef,
      entriesByIdRef,
      toolStreamRef,
    ],
  );

  useEffect(() => {
    if (!controllerRef) return undefined;
    controllerRef.current = controller;
    return () => {
      controllerRef.current = null;
    };
  }, [controllerRef, controller]);

  return {
    controller,
    applyAnchor,
    effectiveAnchorRef,
    geometryRef,
    groupIdsRef,
  };
}
