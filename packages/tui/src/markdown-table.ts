import { expectDefined } from '@wrongstack/core/utils';
import {
  breakTerminalLigatures,
  displayWidth,
  sanitizeTerminalText,
  splitDisplay,
  truncateDisplay,
} from './terminal-width.js';

/**
 * Scan a body of prose for GitHub-flavoured markdown tables and replace
 * each one with a Unicode box-drawing rendering that fits the terminal
 * width. Cells that overflow their column wrap over multiple lines.
 *
 * Non-table prose passes through unchanged.
 *
 * Input shape (rest of the doc may surround it):
 *   | Header A | Header B |
 *   |----------|---------:|
 *   | a 1      |       42 |
 *   | a 2      |        7 |
 *
 * Output shape:
 *   ┌──────────┬──────────┐
 *   │ Header A │ Header B │
 *   ├──────────┼──────────┤
 *   │ a 1      │       42 │
 *   │ a 2      │        7 │
 *   └──────────┴──────────┘
 */
export function renderMarkdownTables(text: string, maxWidth: number): string {
  const safeText = sanitizeTerminalText(text);
  if (!safeText.includes('|')) return safeText; // fast path
  const lines = safeText.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const end = detectTable(lines, i);
    if (end > i) {
      out.push(renderTable(lines.slice(i, end), Math.max(1, maxWidth)));
      i = end;
    } else {
      out.push(lines[i] ?? '');
      i++;
    }
  }
  return out.join('\n');
}

type Align = 'left' | 'right' | 'center';

const ROW_RE = /^\s*\|.*\|\s*$/;
const SEP_RE = /^\s*\|[\s\-:|]+\|\s*$/;

export function detectTable(lines: string[], start: number): number {
  if (start + 1 >= lines.length) return start;
  if (!ROW_RE.test(lines[start] ?? '')) return start;
  const sep = lines[start + 1] ?? '';
  // Need at least one dash somewhere — distinguishes the separator from
  // a regular row that happens to contain colons/spaces only.
  if (!SEP_RE.test(sep) || !/-/.test(sep)) return start;
  let end = start + 2;
  while (end < lines.length && ROW_RE.test(lines[end] ?? '')) end++;
  return end;
}

function parseCells(line: string): string[] {
  // Strip the outer pipes, then split on remaining pipes. Pipes inside a
  // cell would need escaping with `\|`; we honour that minimally.
  const inner = line.trim().replace(/^\||\|$/g, '');
  const parts: string[] = [];
  let buf = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '\\' && inner[i + 1] === '|') {
      buf += '|';
      i++;
      continue;
    }
    if (ch === '|') {
      parts.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  parts.push(buf);
  return parts.map((c) => c.trim());
}

function parseAlign(sep: string): Align {
  const t = sep.trim();
  const left = t.startsWith(':');
  const right = t.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  return 'left';
}

/**
 * Extract visual widths from a separator row (e.g., "|------|--------|").
 * Counts dash characters as the minimum width for each column.
 * Returns null for cells that don't look like valid separators.
 */
function parseSeparatorWidths(sepCells: string[]): (number | null)[] {
  return sepCells.map((cell) => {
    const trimmed = cell.trim();
    // Must be dashes only (possibly with colons for alignment).
    const dashes = trimmed.replace(/:/g, '');
    if (/^-+$/.test(dashes)) return dashes.length;
    return null;
  });
}

export function renderTable(tableLines: string[], maxWidth: number): string {
  tableLines = sanitizeTerminalText(tableLines.join('\n')).split('\n');
  const header = parseCells(tableLines[0] ?? '');
  const sepCells = parseCells(tableLines[1] ?? '');
  const cols = header.length;
  const aligns: Align[] = [];
  for (let c = 0; c < cols; c++) {
    aligns.push(parseAlign(sepCells[c] ?? ''));
  }
  const dataRows = tableLines.slice(2).map(parseCells);
  // Normalise short rows by padding with empty cells. Cells beyond the
  // header width — produced by an unescaped `|` in content like
  // `Promise<string|Null>` — fold back into the last column (rejoined with
  // the pipe that split them) so no cell text is silently dropped.
  for (const row of dataRows) {
    if (cols > 0 && row.length > cols) {
      const overflow = row.slice(cols - 1).join('|');
      row.length = cols - 1;
      row.push(overflow);
    }
    while (row.length < cols) row.push('');
    row.length = cols;
  }

  // A box table has irreducible per-column chrome. Once even the minimum
  // readable cells cannot fit, render every row as stacked key/value lines.
  // This preserves all cell content without letting a forest of `│` borders
  // cross the viewport/scrollbar boundary.
  if (maxWidth < cols * (MIN_COL_WIDTH + 3) + 1) {
    return renderStackedRows(header, dataRows, Math.max(1, maxWidth));
  }

  // Parse separator widths to use as minimum column widths.
  const sepWidths = parseSeparatorWidths(sepCells);
  const widths = computeWidths([header, ...dataRows], cols, maxWidth, sepWidths);

  const lines: string[] = [];
  lines.push(border('┌', '┬', '┐', widths));
  lines.push(...renderRow(header, widths, aligns));
  lines.push(border('├', '┼', '┤', widths));
  for (const row of dataRows) {
    lines.push(...renderRow(row, widths, aligns));
  }
  lines.push(border('└', '┴', '┘', widths));
  return lines.join('\n');
}

function computeWidths(
  allRows: string[][],
  cols: number,
  maxWidth: number,
  sepWidths?: (number | null)[] | undefined,
): number[] {
  // Each column adds `│ … ` of overhead (2 padding + 1 separator); the
  // very first column also gets an opening `│`. Net overhead = 3*cols + 1.
  const overhead = 3 * cols + 1;
  const avail = Math.max(cols * MIN_COL_WIDTH, maxWidth - overhead);
  const natural = new Array<number>(cols).fill(0);
  for (const row of allRows) {
    for (let c = 0; c < cols; c++) {
      const cell = row[c] ?? '';
      // Use visible width (stripped markers) so **bold** contributes 4, not 8.
      // Only measure total content width — wrapCell will hard-break long words
      // when the column shrinks below a word's length. This lets narrow terminals
      // still render wide tables by wrapping cells across multiple rows.
      const stripped = stripInlineMarkers(cell);
      const total = strWidth(stripped);
      natural[c] = Math.max(expectDefined(natural[c]), total);
    }
  }
  // Apply separator widths as minimums (markdown separator defines column widths).
  if (sepWidths) {
    for (let c = 0; c < cols && c < sepWidths.length; c++) {
      const sepW = sepWidths[c];
      if (sepW != null) {
        natural[c] = Math.max(expectDefined(natural[c]), sepW);
      }
    }
  }
  const sumNatural = natural.reduce((s, n) => s + n, 0);
  if (sumNatural <= avail) return natural;
  // Need to shrink. Repeatedly steal a char from the widest column above
  // MIN_COL_WIDTH until we fit. Columns can shrink below word boundaries —
  // wrapCell handles hard-breaking mid-word when forced.
  const widths = natural.slice();
  let sum = sumNatural;
  while (sum > avail) {
    let maxIdx = -1;
    let maxVal = MIN_COL_WIDTH;
    for (let i = 0; i < cols; i++) {
      const w = expectDefined(widths[i]);
      if (w > maxVal) {
        maxVal = w;
        maxIdx = i;
      }
    }
    if (maxIdx < 0) break; // every column is at MIN_COL_WIDTH; give up
    widths[maxIdx] = (widths[maxIdx] ?? 0) - 1;
    sum--;
  }
  return widths;
}

const MIN_COL_WIDTH = 4;

function renderStackedRows(header: string[], rows: string[][], maxWidth: number): string {
  const rendered: string[] = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    if (rowIndex > 0) rendered.push('─'.repeat(maxWidth));
    const row = rows[rowIndex] ?? [];
    for (let column = 0; column < header.length; column++) {
      const label = stripInlineMarkers(header[column] ?? `Column ${column + 1}`);
      const value = stripInlineMarkers(row[column] ?? '');
      const text = breakLigatures(`${label}: ${value}`);
      rendered.push(...wrapCell(text, maxWidth).map((line) => line.trimEnd()));
    }
  }
  return rendered.join('\n');
}

/** Same width implementation used by Ink's own Yoga measurement/output path. */
export const strWidth = displayWidth;

/** Backward-compatible table export; ligature handling now lives centrally. */
const breakLigatures = breakTerminalLigatures;

function border(left: string, mid: string, right: string, widths: number[]): string {
  return left + widths.map((w) => '─'.repeat(w + 2)).join(mid) + right;
}

// ─── Inline markdown in table cells ─────────────────────────────────────────

/**
 * Strip inline formatting markers from text for width calculation.
 * Removes `**`, `*`, `` ` ``, `~~` markers so `strWidth` measures only
 * the visible text, not the markup characters.
 */
function stripInlineMarkers(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1') // **bold**
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '$1') // *italic*
    .replace(/`(.+?)`/g, '$1') // `code`
    .replace(/~~(.+?)~~/g, '$1'); // ~~strike~~
}

function renderRow(cells: string[], widths: number[], aligns: Align[]): string[] {
  // Keep table geometry ANSI-free. Styling markers are removed from the
  // rendered cell rather than converted to escape sequences that can be split
  // during hard-wrap and interpreted as terminal cursor/control bytes.
  const safe = cells.map((cell) => breakLigatures(stripInlineMarkers(cell)));
  const wrapped = safe.map((c, i) => wrapCell(c, widths[i] ?? MIN_COL_WIDTH));
  const height = Math.max(1, ...wrapped.map((w) => w.length));
  const out: string[] = [];
  for (let line = 0; line < height; line++) {
    const parts: string[] = [];
    for (let c = 0; c < widths.length; c++) {
      const w = widths[c] ?? MIN_COL_WIDTH;
      const text = wrapped[c]?.[line] ?? '';
      parts.push(padCell(text, w, aligns[c] ?? 'left'));
    }
    out.push('│ ' + parts.join(' │ ') + ' │');
  }
  return out;
}

function wrapCell(text: string, width: number): string[] {
  if (strWidth(text) <= width) return [text];
  const out: string[] = [];
  // Split on whitespace, keep grouping until we'd overflow.
  const words = text.split(/(\s+)/);
  let cur = '';
  let curWidth = 0;
  for (const word of words) {
    if (!word) continue;
    const wordWidth = strWidth(word);
    if (curWidth + wordWidth <= width) {
      cur += word;
      curWidth += wordWidth;
      continue;
    }
    if (cur) {
      out.push(padVisual(cur, width));
      cur = '';
      curWidth = 0;
    }
    if (wordWidth > width) {
      // Hard-break a word longer than the column — slice by visual width.
      let rest = word;
      let restWidth = wordWidth;
      while (restWidth > width) {
        // Collect characters until we reach `width` visual columns.
        const [collected, remaining] = splitDisplay(rest, width);
        if (collected === '') break; // single grapheme wider than the column
        out.push(padVisual(collected, width));
        rest = remaining;
        restWidth = strWidth(rest);
      }
      cur = rest;
      curWidth = strWidth(rest);
    } else if (!/^\s+$/.test(word)) {
      cur = word;
      curWidth = wordWidth;
    }
  }
  if (cur) out.push(padVisual(cur, width));
  return out.length === 0 ? [''] : out;
}

/** Pad a string to a target visual width using spaces. */
function padVisual(text: string, targetWidth: number): string {
  const w = strWidth(text);
  if (w >= targetWidth) return truncateDisplay(text, targetWidth, '');
  return text + ' '.repeat(targetWidth - w);
}

function padCell(text: string, width: number, align: Align): string {
  const visualLen = strWidth(text);
  // Pad (or truncate) text so its visual width equals `width`.
  // This matches how `border` creates `─`.repeat(width + 2) dashes,
  // which gives a visual content width of `width` columns.
  let displayText = text;
  if (visualLen > width) displayText = truncateDisplay(text, width, '');
  const pad = width - strWidth(displayText);
  if (align === 'right') return ' '.repeat(pad) + displayText;
  if (align === 'center') {
    const l = Math.floor(pad / 2);
    return ' '.repeat(l) + displayText + ' '.repeat(pad - l);
  }
  return displayText + ' '.repeat(pad);
}
