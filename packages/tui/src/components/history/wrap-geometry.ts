/**
 * Wrap-aware card-row → source-text translation for drag-selection text
 * recovery (v1.1 item M4).
 *
 * v1's assembler indexed the entry's source lines by the card's VISUAL row,
 * which equals the source line only when no line wraps. Any wrapped line
 * desynchronizes the index and garbles the copied text. This module supplies
 * the exact per-row mapping.
 *
 * The render truth this mirrors (verified against the components):
 *  - `assistant` cards (entry.tsx) render `parseNextSteps(text, true).stripped`
 *    through AssistantBody, wrapped by Ink's Text at
 *    `assistantContentWidth(termWidth)` = termWidth − 2. Ink wraps via
 *    wrap-ansi with `{ trim: false, hard: true }` (ink/build/wrap-text.js).
 *  - `thinking` cards render sanitizeTerminalText(text) at the same width.
 *
 * Origin: card row 0 = body row 0, matching v1's documented origin (one card
 * row per source line when nothing wraps). Any chrome-row offset above the
 * body is a preexisting v1 approximation outside M4's scope — preserved, not
 * altered, so every pinned expectation keeps its exact meaning.
 *
 * The load-bearing invariant (verified empirically against wrap-ansi@10.0.1,
 * the exact version ink 7.1.1 resolves): for each source line,
 * `wrapAnsi(line, w, {trim:false, hard:true}).split('\n').join('') === line`.
 * Segment prefix sums therefore give EXACT source offsets. For a non-wrapped
 * line the single segment spans the whole line with `start = 0`, so every
 * resolve here reduces to v1's math (`offset = col`, end = `col + 1`).
 */

import { parseNextSteps } from '@wrongstack/tools/next-steps';
import wrapAnsi from 'wrap-ansi';
import { sanitizeTerminalText } from '../../terminal-width.js';
import type { HistoryEntry } from './types.js';

/** One wrapped visual row inside a card body: the source line it shows and
 * the half-open [start, end) character range of that line it covers. */
export interface BodyRowSpan {
  line: number;
  start: number;
  end: number;
}

export interface BodyRowMap {
  /** Per-card-row spans, index 0 = card row 0 (v1 origin). */
  rows: readonly BodyRowSpan[];
  /** The exact text the map indexes into — the render base (sanitized; for
   * assistant entries with the next-steps block stripped exactly like the
   * renderer). Slicing this text is WYSIWYG for the wrapped kinds. */
  text: string;
}

/** Kinds whose render path this module mirrors. Everything else uses the
 * v1 naive mapping in assembleSelectionText. */
export function hasWrapMap(kind: HistoryEntry['kind']): boolean {
  return kind === 'assistant' || kind === 'thinking';
}

/** The renderer's content width for bordered text cards. Mirrors
 * `assistantContentWidth` (termWidth − border 1 − paddingLeft 1). */
function textContentWidth(termWidth: number): number {
  return Math.max(1, termWidth - 2);
}

/**
 * Build the card-row → (source line, char range) map for one text card.
 * Pure and deterministic from (kind, text, termWidth).
 */
export function buildBodyRowMap(
  kind: HistoryEntry['kind'],
  rawText: string,
  termWidth: number,
): BodyRowMap {
  const base =
    kind === 'assistant'
      ? sanitizeTerminalText(parseNextSteps(rawText, true).stripped)
      : sanitizeTerminalText(rawText);
  const width = textContentWidth(termWidth);
  const rows: BodyRowSpan[] = [];
  const lines = base.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.length === 0) {
      rows.push({ line: i, start: 0, end: 0 });
      continue;
    }
    const segments = wrapAnsi(line, width, { trim: false, hard: true }).split('\n');
    let offset = 0;
    for (const seg of segments) {
      rows.push({ line: i, start: offset, end: offset + seg.length });
      offset += seg.length;
    }
  }
  return { rows, text: base };
}

/**
 * Resolve the (source line, char offset) a card row + column points at,
 * clamping out-of-range rows to the last body row and columns to the
 * wrapped segment.
 *
 * Column semantics match v1: `col` is a body-local character offset (v1
 * sliced the source line by it directly), so a non-wrapped line resolves to
 * exactly v1's numbers. `atEnd` is set for an inclusive drag endpoint (end
 * of a selection range): the offset then counts one past the column,
 * clamped to the segment's end — mirroring v1's `endCol + 1`.
 */
export function resolveRowCol(
  map: BodyRowMap,
  row: number,
  col: number,
  atEnd: boolean,
): { line: number; offset: number } {
  const last = map.rows.length - 1;
  if (last < 0) return { line: 0, offset: 0 };
  const idx = Math.max(0, Math.min(row, last));
  const span = map.rows[idx] ?? { line: 0, start: 0, end: 0 };
  const segLen = span.end - span.start;
  const within = atEnd
    ? Math.max(0, Math.min(col + 1, segLen))
    : Math.max(0, Math.min(col, segLen));
  return { line: span.line, offset: span.start + within };
}
