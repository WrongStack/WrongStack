/**
 * Inline chip token grammar, shared by the editable input for chip rendering
 * and whole-token cursor deletion. Attachment shapes stay in sync with the
 * AttachmentStore placeholder regex in @wrongstack/core:
 *   - seq-keyed  `[pasted|image|file #N …]`  (a cosmetic suffix after the seq,
 *     e.g. `, 123 lines`, is tolerated; legacy `[file #N]` is included)
 *   - path-keyed `[file:<path>]`
 * `[VIBE]` is a protocol chip: it renders and deletes as a token, but it is
 * not an attachment and must stay in the prompt sent to the refiner/agent.
 */
/** Attachment placeholders only. Protocol tags must not be stripped as chips. */
export const ATTACHMENT_TOKEN_SRC =
  '\\[(?:pasted|image|file) #\\d+[^\\]]*\\]|\\[file:[^\\]]+\\]';
/** Protocol trigger rendered as a chip but kept in the prompt text. */
export const PROTOCOL_TOKEN_SRC = '\\[VIBE\\]';
export const INLINE_TOKEN_SRC = `${ATTACHMENT_TOKEN_SRC}|${PROTOCOL_TOKEN_SRC}`;

const AT_END = new RegExp(`(?:${INLINE_TOKEN_SRC})$`, 'i');
const AT_START = new RegExp(`^(?:${INLINE_TOKEN_SRC})`, 'i');
const GLOBAL = new RegExp(INLINE_TOKEN_SRC, 'gi');

/**
 * If a whole chip ends immediately before `cursor`, return the buffer and
 * cursor with that chip removed (so one backspace deletes the entire token,
 * anywhere in the line). Returns null when there's no chip there — the caller
 * falls back to a single-character delete.
 */
export function deleteTokenBackward(
  buffer: string,
  cursor: number,
): { buffer: string; cursor: number } | null {
  const m = buffer.slice(0, cursor).match(AT_END);
  if (!m) return null;
  const start = cursor - m[0].length;
  return { buffer: buffer.slice(0, start) + buffer.slice(cursor), cursor: start };
}

/**
 * Length of a chip that starts exactly at `cursor`, or 0 if none — lets a
 * forward delete drop the whole token in one keystroke.
 */
export function tokenLengthForward(buffer: string, cursor: number): number {
  const m = buffer.slice(cursor).match(AT_START);
  return m ? m[0].length : 0;
}

export function tokenSpanAt(buffer: string, cursor: number): { start: number; end: number } | null {
  const clamped = Math.max(0, Math.min(cursor, buffer.length));
  for (const m of buffer.matchAll(GLOBAL)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (clamped >= start && clamped <= end) return { start, end };
  }
  return null;
}

interface ChipSpan {
  text: string;
  /** True for an attachment chip token, false for a plain run. */
  chip: boolean;
}

/** Split a string into chip / plain spans for styled rendering. */
export function splitChips(text: string): ChipSpan[] {
  if (!text) return [];
  const spans: ChipSpan[] = [];
  let last = 0;
  for (const m of text.matchAll(GLOBAL)) {
    const idx = m.index ?? 0;
    if (idx > last) spans.push({ text: text.slice(last, idx), chip: false });
    spans.push({ text: m[0], chip: true });
    last = idx + m[0].length;
  }
  if (last < text.length) spans.push({ text: text.slice(last), chip: false });
  return spans;
}

/** One rendered cell of the input row. Exactly one of chip/prompt/cursor may be true. */
export interface InputCell {
  ch: string;
  /** Inside an attachment chip token. */
  chip: boolean;
  /** Part of the leading prompt (e.g. "› "). */
  prompt: boolean;
  /** The single cursor cell (rendered inverse). */
  cursor: boolean;
}

/**
 * Lay out `prompt + value` into wrapped rows of at most `width` columns, so the
 * input area can grow to exactly the number of visual lines its content needs.
 * Char-wrap (not word-wrap) keeps every cell index aligned with the buffer, so
 * the cursor lands on the right row/column. A cursor at end-of-buffer gets a
 * virtual trailing space cell (which may spill onto a fresh row, exactly like a
 * terminal). Newlines in `value` start a new row.
 */
export function layoutInputRows(
  prompt: string,
  value: string,
  cursor: number,
  width: number,
): InputCell[][] {
  const w = Math.max(1, Math.floor(width));
  // Mark which value-character offsets fall inside a chip token.
  const chipAt = new Array<boolean>(value.length).fill(false);
  let off = 0;
  for (const span of splitChips(value)) {
    if (span.chip) for (let i = 0; i < span.text.length; i++) chipAt[off + i] = true;
    off += span.text.length;
  }
  const cursorIdx = prompt.length + Math.max(0, Math.min(cursor, value.length));
  const cells: InputCell[] = [];
  for (let i = 0; i < prompt.length; i++) {
    cells.push({ ch: prompt[i] as string, chip: false, prompt: true, cursor: false });
  }
  for (let i = 0; i < value.length; i++) {
    cells.push({ ch: value[i] as string, chip: chipAt[i] === true, prompt: false, cursor: false });
  }
  if (cursorIdx >= cells.length) {
    cells.push({ ch: ' ', chip: false, prompt: false, cursor: true });
  } else {
    (cells[cursorIdx] as InputCell).cursor = true;
  }
  // Wrap into rows: break on explicit '\n' (consumed) or when a row fills `w`.
  const rows: InputCell[][] = [];
  let row: InputCell[] = [];
  for (const cell of cells) {
    if (cell.ch === '\n') {
      rows.push(row);
      row = [];
      continue;
    }
    row.push(cell);
    if (row.length >= w) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length > 0 || rows.length === 0) rows.push(row);
  return rows;
}

/**
 * Inverse of {@link layoutInputRows}: given a pointer at visual
 * `(row, col)` (both 0-based; col is the column WITHIN the input area, i.e. the
 * prompt occupies the first columns of row 0), return the buffer cursor index
 * to place the caret. Mirrors layoutInputRows' wrapping exactly so the mapping
 * matches what's on screen. Clicking the prompt → start of buffer; clicking
 * past a row's last character → just after it; clicking below all rows → end of
 * buffer. Exported for the TUI input-click handler and unit tests.
 */
export function inputIndexAtRowCol(
  prompt: string,
  value: string,
  width: number,
  row: number,
  col: number,
): number {
  const w = Math.max(1, Math.floor(width));
  // Flat cells: prompt (buf = -1) then value (buf = its index). Newlines are
  // consumed as row breaks, exactly like layoutInputRows.
  const flat: Array<{ ch: string; buf: number }> = [];
  for (let i = 0; i < prompt.length; i++) flat.push({ ch: prompt[i] as string, buf: -1 });
  for (let i = 0; i < value.length; i++) flat.push({ ch: value[i] as string, buf: i });

  const rows: Array<{ buf: number }[]> = [];
  const starts: number[] = []; // value index where each row's content begins
  let cur: Array<{ buf: number }> = [];
  let curStart = 0;
  for (const cell of flat) {
    if (cell.ch === '\n') {
      rows.push(cur);
      starts.push(curStart);
      cur = [];
      curStart = cell.buf + 1; // content after the newline
      continue;
    }
    if (cur.length === 0 && cell.buf >= 0) curStart = cell.buf;
    cur.push({ buf: cell.buf });
    if (cur.length >= w) {
      rows.push(cur);
      starts.push(curStart);
      cur = [];
      curStart = -1; // set by the next pushed cell (or stays for a trailing newline)
    }
  }
  if (cur.length > 0 || rows.length === 0) {
    rows.push(cur);
    starts.push(curStart);
  }

  const clamp = (n: number) => Math.max(0, Math.min(value.length, n));
  if (row < 0) return 0;
  if (row >= rows.length) return value.length;
  const r = rows[row] as { buf: number }[];
  const c = Math.max(0, col);
  if (c < r.length) {
    const b = (r[c] as { buf: number }).buf;
    return b < 0 ? 0 : clamp(b); // prompt cell → start of value
  }
  // Past the last visible cell: place after the row's last value char…
  for (let k = r.length - 1; k >= 0; k--) {
    const b = (r[k] as { buf: number }).buf;
    if (b >= 0) return clamp(b + 1);
  }
  // …or, for an empty / prompt-only row, at the row's start offset.
  const start = starts[row];
  return clamp(start !== undefined && start >= 0 ? start : value.length);
}
