/**
 * Pure input-editing helpers for the TUI prompt.
 *
 * Word-boundary semantics, word-jump targets, and word-deletion helpers
 * used by Ctrl+Left/Right/Backspace/Delete/W. These are buffer-pure — they
 * take a string and a cursor index and return a number or a new buffer;
 * no React, no refs, no side effects. This makes them trivial to test
 * (see tests/input-editing-baseline.test.ts).
 *
 * Chip-awareness (attachment tokens like `[pasted #N]`, `[file:path]`,
 * `[image #N]`) is preserved: a chip is treated as a single atomic word
 * so Ctrl+Backspace on one deletes the whole chip, not a single character.
 *
 * Word-boundary policy (Adım 4 of the TUI input refactor):
 *   Separators are whitespace and most ASCII punctuation, EXCEPT the
 *   underscore, which counts as a word character. Rationale:
 *     - Paths (`src/foo/bar.ts`) break at `/` and `.` so Ctrl+Backspace
 *       deletes one segment, not the whole path.
 *     - Kebab-case (`--foo-bar`) breaks at `-`, matching CLI flag habits.
 *     - Snake_case (`my_var_name`) stays ONE word so a single Ctrl+
 *       Backspace deletes the whole identifier, matching how identifiers
 *       read in code.
 *   Underscore is the lone punctuation char kept as a word character; if
 *   your editing flow prefers it as a separator, narrow `WORD_SEPARATORS`.
 */

import { tokenSpanAt } from './input-tokens.js';

/**
 * Characters that act as word boundaries. Whitespace is handled by the
 * `\s` branch; punctuation is listed explicitly so we can carve out
 * exceptions (currently: `_` is intentionally absent → word char).
 *
 * Kept as a single string + Set lookup for O(1) per-character checks.
 */
const WORD_SEPARATORS = new Set<string>(
  (
    // dashes
    '-' +
    // path / namespace separators
    '/\\' +
    // sentence / clause punctuation
    '.,;:!?…' +
    // brackets and parens
    '()[]{}<>' +
    // quotes
    "\"'`" +
    // math / sigils
    '+=*^%|~' +
    // shell / ref punctuation
    '@#$&' +
    // other typographic separators
    '·•—–'
  ).split(''),
);

/**
 * Is `ch` a word separator? `undefined` (cursor at a boundary / out of
 * range) is treated as a separator so the walk loops terminate cleanly.
 * Whitespace matches `\s`; everything else must be in WORD_SEPARATORS.
 */
export function isInputWordSeparator(ch: string | undefined): boolean {
  if (ch === undefined) return true;
  if (/\s/.test(ch)) return true;
  return WORD_SEPARATORS.has(ch);
}

/**
 * Index of the start of the word immediately before `cursor` — the jump
 * target for Ctrl+Left and the delete-start for Ctrl+Backspace / Ctrl+W.
 *
 * If the cursor sits inside or just after an attachment chip, returns the
 * chip's start index (whole-chip jump). Otherwise walks left over trailing
 * separators, then over the preceding word run.
 */
export function previousInputWordStart(buffer: string, cursor: number): number {
  let i = Math.max(0, Math.min(cursor, buffer.length));
  const chipAtCursor = tokenSpanAt(buffer, i);
  if (chipAtCursor && i > chipAtCursor.start) return chipAtCursor.start;
  while (i > 0 && isInputWordSeparator(buffer[i - 1])) i--;
  const chipBeforeCursor = tokenSpanAt(buffer, i);
  if (chipBeforeCursor && i === chipBeforeCursor.end) return chipBeforeCursor.start;
  while (i > 0 && !isInputWordSeparator(buffer[i - 1])) {
    const chip = tokenSpanAt(buffer, i - 1);
    if (chip) {
      i = chip.start;
      continue;
    }
    i--;
  }
  return i;
}

/**
 * Index of the start of the word immediately after `cursor` — the jump
 * target for Ctrl+Right. If the cursor is inside a chip, jumps past it.
 * Skips any trailing separators so the cursor lands ON the next word,
 * not in the gap.
 */
export function nextInputWordStart(buffer: string, cursor: number): number {
  let i = Math.max(0, Math.min(cursor, buffer.length));
  const chipAtCursor = tokenSpanAt(buffer, i);
  if (chipAtCursor && i < chipAtCursor.end) i = chipAtCursor.end;
  else
    while (i < buffer.length && !isInputWordSeparator(buffer[i])) {
      const chip = tokenSpanAt(buffer, i);
      if (chip) {
        i = chip.end;
        continue;
      }
      i++;
    }
  while (i < buffer.length && isInputWordSeparator(buffer[i])) i++;
  return i;
}

/**
 * Result of a word-delete operation: the new buffer and where the cursor
 * should land in it. `null` means there is nothing to delete (cursor at
 * the relevant boundary).
 */
interface WordDeleteResult {
  buffer: string;
  cursor: number;
}

/**
 * Delete the word immediately before the cursor. Used by Ctrl+Backspace
 * and Ctrl+W (identical behaviour — Ctrl+W is the Unix shell convention,
 * Ctrl+Backspace is the GUI convention; both delete one word back).
 *
 * Chip-aware: if the cursor sits inside an attachment chip, the whole chip
 * is removed. If the chip ends exactly at the cursor, the whole chip is
 * removed. Otherwise the previous word run (per `isInputWordSeparator`)
 * is removed along with any trailing separators.
 */
export function deleteWordBackward(buffer: string, cursor: number): WordDeleteResult | null {
  if (cursor === 0) return null;
  const chip = tokenSpanAt(buffer, cursor);
  const deleteStart =
    chip && cursor > chip.start && cursor < chip.end
      ? chip.start
      : previousInputWordStart(buffer, cursor);
  const deleteEnd = chip && cursor > chip.start && cursor < chip.end ? chip.end : cursor;
  if (deleteStart === deleteEnd) return null;
  return {
    buffer: buffer.slice(0, deleteStart) + buffer.slice(deleteEnd),
    cursor: deleteStart,
  };
}

/**
 * Delete the word immediately after the cursor. Used by Ctrl+Delete.
 *
 * Chip-aware: if the cursor sits inside a chip, the whole chip is removed.
 * If a chip starts at the cursor, that chip is removed. Otherwise the
 * following word run is removed.
 */
export function deleteWordForward(buffer: string, cursor: number): WordDeleteResult | null {
  if (cursor >= buffer.length) return null;
  const chip = tokenSpanAt(buffer, cursor);
  const deleteStart = chip && cursor > chip.start && cursor < chip.end ? chip.start : cursor;
  const deleteEnd =
    chip && cursor > chip.start && cursor < chip.end ? chip.end : nextInputWordStart(buffer, cursor);
  if (deleteStart === deleteEnd) return null;
  return {
    buffer: buffer.slice(0, deleteStart) + buffer.slice(deleteEnd),
    cursor: deleteStart,
  };
}
