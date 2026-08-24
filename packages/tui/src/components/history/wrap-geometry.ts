/**
 * Wrap-aware card-row → source-text translation for drag-selection text
 * recovery (v1.1 item M4).
 *
 * v1's assembler indexed the entry's source lines by the card's VISUAL row,
 * which equals the source line only when no line wraps. Any wrapped line
 * desynchronizes the index and garbles the copied text. This module supplies
 * the per-row mapping against the entry's SOURCE text (sanitized, with the
 * assistant next-steps block stripped exactly like the renderer).
 *
 * Exactness boundary: the mapping is EXACT for plain prose and thinking text
 * — MarkdownView renders those lines as-is and Ink wraps them with the same
 * wrap-ansi call mirrored below. For assistant text containing markdown
 * STRUCTURE (headings, lists, tables, fenced code), MarkdownView restyles
 * the render (heading styles, bullet glyphs, table layout), so the visual
 * rows can diverge from this source-text map. The copy semantics are
 * deliberately source-based in that case: a drag recovers what the model
 * wrote, not the renderer's decoration. Visual-row alignment for
 * heavily-structured markdown is approximate and documented as such.
 *
 * The render truth this mirrors (verified against the components):
 *  - `assistant` cards (entry.tsx) render `parseNextSteps(text, true).stripped`
 *    through AssistantBody → MarkdownView, wrapped by Ink's Text at
 *    `assistantContentWidth(termWidth)` = termWidth − 2. Ink wraps via
 *    wrap-ansi with `{ trim: false, hard: true }` (ink/build/wrap-text.js).
 *    The markdown transform above applies only to structured spans; plain
 *    prose lines pass through unwrapped-by-markdown and are exact here.
 *  - `thinking` cards render sanitizeTerminalText(text) at the same width
 *    with no markdown transform — exact.
 *  - `user` cards render the `'👤 USER  '` label inline before the text in
 *    the same bordered Text (entry.tsx), so row 0 = label cells then text;
 *    wrapped continuation rows start at the text. `pasteContent` renders as
 *    a second block (`'  ↳ '` preview) after a newline; the copy base is
 *    `pasteContent || text` (copy-icon.ts), so a card with BOTH blocks shows
 *    two text regions while the base holds one — those keep the v1 naive
 *    mapping (assembler-side residual, documented here).
 *  - `info` cards are unbordered plain Text: the `'ℹ '` icon inline before
 *    the text, wrapped at the FULL termWidth (no panel gutter).
 *
 * Inline-prefix translation: the label/icon cells are chrome, not copyable
 * text. buildBodyRowMap wraps `prefix + first line` together — the renderer
 * concatenates them into one Text node before Ink wraps it, so the wrap
 * boundaries are only correct when the prefix participates in the wrap — and
 * records the prefix width in terminal cells (string-width, the project's
 * measurer; 👤 is a surrogate pair — 2 code units AND 2 cells — so both
 * shipped prefixes happen to have prefixWidth === prefix.length). resolveRowCol
 * shifts row-0 columns past it, clamping prefix clicks to the text start:
 * the same margin-click semantics M3 gives the card gutter. The clamp works
 * in CELLS while segment ranges are in CHARACTERS — exact when the body's
 * characters are single-cell, the same standing M4 approximation that
 * already governs text content. Narrow panes where the label alone exceeds
 * the content width produce label-only rows (zero-width spans) — that
 * mirrors Ink's render exactly and is deliberately preserved: any divergence
 * between the map and the renderer breaks WYSIWYG slicing.
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
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import { sanitizeTerminalText } from '../../terminal-width.js';
import { MESSAGE_PANEL_CHROME_WIDTH } from './assistant.js';
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
  /** Terminal CELLS of inline chrome rendered before the first text
   * character on row 0 (user label / info icon). 0 for prefix-less kinds. */
  prefixWidth: number;
}

/** Inline label the renderer places before a user card's text
 * (entry.tsx: `<Text bold>👤 USER  </Text>` then the text, one Text node).
 * Exported so entry.tsx consumes the single source (p3) — drift between the
 * render and this constant silently mis-offsets user-card selection. */
export const USER_LABEL = '👤 USER  ';

/** Inline icon the renderer places before an info card's text
 * (entry.tsx: `<Text>ℹ </Text>` then the text, one Text node). */
export const INFO_PREFIX = 'ℹ ';

/** Kinds whose render path this module mirrors. Everything else uses the
 * v1 naive mapping in assembleSelectionText. Declared as a type predicate
 * (taking the entry, not the kind) so call sites narrow the HistoryEntry
 * union — every member kind carries `text`, the others may not. The
 * assembler additionally restricts user cards to the no-pasteContent shape
 * (see selection-helpers): a card with a paste block renders two text
 * regions but the copy base holds one, so those stay on the v1 path. */
export function hasWrapMap(
  entry: HistoryEntry,
): entry is Extract<HistoryEntry, { kind: 'assistant' | 'thinking' | 'user' | 'info' }> {
  return (
    entry.kind === 'assistant' ||
    entry.kind === 'thinking' ||
    entry.kind === 'user' ||
    entry.kind === 'info'
  );
}

/** The renderer's content width for bordered text cards — the shared
 * chrome constant (border 1 + paddingLeft 1) from assistant.tsx. */
function textContentWidth(termWidth: number): number {
  return Math.max(1, termWidth - MESSAGE_PANEL_CHROME_WIDTH);
}

/** The renderer's content width for unbordered rows: info cards render in
 * a bare Text with no panel gutter, so text wraps at the full termWidth.
 * Coupled to entry.tsx's info render — adding chrome there must change this
 * exactly as a bordered-card change must change MESSAGE_PANEL_CHROME_WIDTH. */
function infoContentWidth(termWidth: number): number {
  return Math.max(1, termWidth);
}

/**
 * Build the card-row → (source line, char range) map for one text card.
 * Pure and deterministic from (kind, text, termWidth).
 *
 * For prefixed kinds (user label, info icon) line 0 is wrapped AS the
 * renderer sees it — `prefix + line` in one Text node — so wrap boundaries
 * match the visual rows; each segment is then translated back to
 * text-local character coordinates (the prefix chars subtracted, clamped).
 */
export function buildBodyRowMap(
  kind: HistoryEntry['kind'],
  rawText: string,
  termWidth: number,
): BodyRowMap {
  const prefix = kind === 'user' ? USER_LABEL : kind === 'info' ? INFO_PREFIX : '';
  const prefixChars = prefix.length;
  const prefixWidth = stringWidth(prefix);
  const base = sanitizeTerminalText(
    kind === 'assistant' ? parseNextSteps(rawText, true).stripped : rawText,
  );
  const width = kind === 'info' ? infoContentWidth(termWidth) : textContentWidth(termWidth);
  const rows: BodyRowSpan[] = [];
  const lines = base.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.length === 0) {
      rows.push({ line: i, start: 0, end: 0 });
      continue;
    }
    // The prefix rides only line 0's wrap; later lines are pure text and
    // must NOT have prefixChars subtracted (multiline user/info spans were
    // truncated to their first prefixChars chars before this — a second
    // source line 'second line' mapped to a 2-char span).
    const sub = i === 0 ? prefixChars : 0;
    const wrapped = i === 0 && prefixChars > 0 ? prefix + line : line;
    const segments = wrapAnsi(wrapped, width, { trim: false, hard: true }).split('\n');
    let offset = 0;
    for (const seg of segments) {
      rows.push({
        line: i,
        start: Math.max(0, offset - sub),
        end: Math.max(0, offset + seg.length - sub),
      });
      offset += seg.length;
    }
  }
  return { rows, text: base, prefixWidth };
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
  // Row 0 hosts the inline prefix (user label / info icon): body-local
  // cells [0, prefixWidth) are chrome, not text. Shift the column past it,
  // clamping label clicks to the text start — the same margin-click
  // semantics M3 applies to the card gutter. Cell→char translation is
  // exact for single-cell text (the standing M4 approximation).
  //
  // Caller contract: `col` is CONTENT-AREA-local — the controller has
  // already subtracted MESSAGE_PANEL_CHROME_WIDTH for bordered kinds — and
  // the prefix occupies the FIRST prefixWidth cells of that content area
  // (the label is flush left; entry.tsx adds no indent). If the renderer
  // ever indents the label or the chrome constant widens, this clamp and
  // the controller's gutter translation must be revisited together.
  const textCol = idx === 0 && map.prefixWidth > 0 ? Math.max(0, col - map.prefixWidth) : col;
  const segLen = span.end - span.start;
  const within = atEnd
    ? Math.max(0, Math.min(textCol + 1, segLen))
    : Math.max(0, Math.min(textCol, segLen));
  return { line: span.line, offset: span.start + within };
}
