/**
 * Drag-selection helpers — pure functions for viewport-cell selection and
 * clipboard text assembly.
 *
 * Extracted from scrollable-history.tsx.
 *
 * Copy contract (block-based): a drag never slices text. The selection
 * rectangle only decides WHICH blocks it touches; every touched block is
 * copied in its entirety, in top-to-bottom viewport order, joined with the
 * `\n---\n` card boundary. A "block" is one mounted render group: a single
 * card, or a compact tool group whose call + result members expand together
 * as one block.
 */
import { copyableTextForEntries, copyableTextForEntry } from './copy-icon.js';
import type { HistoryEntry } from './types.js';

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
 * Ordered ids of the head entries whose visible rows the selection touches.
 * A block counts as touched when the selection rectangle overlaps ANY of its
 * viewport rows — even a single row — which is what makes the copy
 * block-based: partial vertical contact yields the whole block.
 *
 * `cards` are the mounted spans in document order (as produced by
 * `buildMountedCardSpans`), so the returned ids follow the same top-to-bottom
 * order the blocks appear in on screen, regardless of drag direction
 * (`normalizeSelection` has already ordered the rect).
 */
export function selectionTouchedEntryIds(opts: {
  selection: SelectionRect;
  cards: ReadonlyArray<{
    entryId: number;
    /** 0-based viewport row of the card's first visible row. */
    viewportStartRow: number;
    /** 0-based viewport row just past the card's last visible row. */
    viewportEndRow: number;
  }>;
}): number[] {
  const { selection, cards } = opts;
  const ids: number[] = [];
  for (const card of cards) {
    const visTop = Math.max(selection.topLeft.row, card.viewportStartRow);
    const visBot = Math.min(selection.bottomRight.row, card.viewportEndRow - 1);
    if (visTop > visBot) continue;
    ids.push(card.entryId);
  }
  return ids;
}

/**
 * Build the clipboard payload for a block-based selection: every touched
 * head id contributes its block's FULL copyable text, in the order given
 * (the assembler never reorders or slices).
 *
 * `toolGroupsByHeadId` lets a multi-member tool-group expand as ONE block:
 * when the head id maps to member ids, the block copies via
 * `copyableTextForEntries` (raw ordered JSON of every member, matching the
 * existing copy-icon contract). A single-entry head falls through to
 * `copyableTextForEntry`.
 *
 * Multiple touched blocks are joined with `\n---\n` so the user can see
 * where one card ends and the next begins. Unknown ids (entries no longer
 * retained) and blocks that resolve to empty text are skipped; a selection
 * that resolves to no text returns `""` so the caller can fall through
 * silently.
 */
export function assembleSelectionText(opts: {
  entryIds: readonly number[];
  entriesById: ReadonlyMap<number, HistoryEntry>;
  toolGroupsByHeadId?: ReadonlyMap<number, readonly number[]> | undefined;
}): string {
  const { entryIds, entriesById, toolGroupsByHeadId } = opts;
  const segments: string[] = [];
  for (const entryId of entryIds) {
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
    const text =
      entries.length === 1
        ? copyableTextForEntry(entries[0] as HistoryEntry)
        : copyableTextForEntries(entries);
    if (text.length === 0) continue;
    segments.push(text);
  }
  if (segments.length === 0) return '';
  const separator = segments.length > 1 ? '\n---\n' : '\n';
  return segments.join(separator);
}
