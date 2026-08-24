/**
 * Drag-selection helpers — pure functions for viewport-cell selection and
 * clipboard text assembly.
 *
 * Extracted from scrollable-history.tsx.
 */
import { copyableTextForEntries, copyableTextForEntry } from './copy-icon.js';
import type { HistoryEntry } from './types.js';
import { buildBodyRowMap, resolveRowCol } from './wrap-geometry.js';

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
    const visTop = Math.max(selection.topLeft.row, card.viewportStartRow);
    const visBot = Math.min(selection.bottomRight.row, card.viewportEndRow - 1);
    if (visTop > visBot) continue;
    const entryStartRow = visTop - card.viewportStartRow;
    const entryEndRow = visBot - card.viewportStartRow;
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
  toolGroupsByHeadId?: ReadonlyMap<number, readonly number[]> | undefined;
  /**
   * Render width used to build the wrap-aware row→line translation for
   * assistant/thinking cards (v1.1 M4). When omitted, wrapped kinds fall
   * back to the v1 naive mapping below — callers that cannot know the
   * width keep their existing behavior.
   */
  termWidth?: number | undefined;
}): string {
  const { slices, entriesById, toolGroupsByHeadId, termWidth } = opts;
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
    if (entries.length > 1) {
      segments.push(fullText);
      continue;
    }
    // Wrap-aware path (v1.1 M4): for kinds this translation mirrors, resolve
    // the slice's row/col anchors against the same wrap geometry the renderer
    // produced, then slice the render base (map.text). For non-wrapped text
    // every line is one segment with start 0, so the resolved anchors equal
    // v1's numbers exactly. Without termWidth (or for other kinds) the v1
    // naive loop below keeps its existing behavior.
    const single = entries[0] as HistoryEntry;
    if (termWidth !== undefined && (single.kind === 'assistant' || single.kind === 'thinking')) {
      const map = buildBodyRowMap(single.kind, single.text, termWidth);
      const lines = map.text.split('\n');
      for (const slice of entrySlices) {
        const a = resolveRowCol(map, slice.startRow, slice.startCol, false);
        const b = resolveRowCol(map, slice.endRow, slice.endCol, true);
        if (b.line < a.line) continue;
        const collected: string[] = [];
        for (let ln = a.line; ln <= b.line && ln < lines.length; ln++) {
          const line = lines[ln] ?? '';
          if (ln === a.line && ln === b.line) {
            const start = Math.max(0, Math.min(line.length, a.offset));
            const end = Math.max(start, Math.min(line.length, b.offset));
            if (end > start) collected.push(line.slice(start, end));
          } else if (ln === a.line) {
            const start = Math.max(0, Math.min(line.length, a.offset));
            if (start < line.length) collected.push(line.slice(start));
          } else if (ln === b.line) {
            const end = Math.max(0, Math.min(line.length, b.offset));
            if (end > 0) collected.push(line.slice(0, end));
          } else {
            collected.push(line);
          }
        }
        const seg = collected.join('\n');
        if (seg.length > 0) segments.push(seg);
      }
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
  const separator = byEntry.size > 1 || toolGroupCount > 0 ? '\n---\n' : '\n';
  return segments.join(separator);
}
