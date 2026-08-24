/**
 * Wrap-geometry translation tests (v1.1 item M4).
 *
 * Pins three contracts:
 *  1. buildBodyRowMap mirrors the renderer's wrap exactly — segment prefix
 *     sums reconstruct the source line (the wrap-ansi invariant), and a
 *     non-wrapped line is one span with start 0 (v1 reduction).
 *  2. resolveRowCol maps (card row, col) → (source line, offset) with the
 *     documented clamps, and reduces to v1's math when nothing wraps.
 *  3. assembleSelectionText with termWidth recovers the WYSIWYG slice from
 *     wrapped cards (the M4 fix), and without termWidth keeps the v1 naive
 *     fallback byte-for-byte.
 *
 * Wrap expectations are pinned against wrap-ansi@10.0.1 with
 * { trim: false, hard: true } — the exact call ink 7.1.1's wrap-text.js
 * makes — verified empirically:
 *   'aaaaa bbbbb ccccc' @ 11 → ['aaaaa bbbbb', ' ccccc']
 */

import stringWidth from 'string-width';
import { describe, expect, it } from 'vitest';
import {
  type BodyRowSpan,
  buildBodyRowMap,
  INFO_PREFIX,
  resolveRowCol,
  USER_LABEL,
} from '../src/components/history/wrap-geometry.js';
import type { HistoryEntry } from '../src/components/history.js';
import type { SelectionSlice } from '../src/components/scrollable-history.js';
import { assembleSelectionText } from '../src/components/scrollable-history.js';

function assistantEntry(id: number, text: string): HistoryEntry {
  return { id, kind: 'assistant', text };
}

function userEntry(id: number, text: string, pasteContent?: string): HistoryEntry {
  return { id, kind: 'user', text, ...(pasteContent !== undefined ? { pasteContent } : {}) };
}

function infoEntry(id: number, text: string): HistoryEntry {
  return { id, kind: 'info', text };
}

describe('buildBodyRowMap', () => {
  it('maps a non-wrapped line to a single whole-line span (v1 reduction)', () => {
    const map = buildBodyRowMap('assistant', 'alpha bravo charlie', 77);
    expect(map.rows).toEqual<BodyRowSpan[]>([{ line: 0, start: 0, end: 19 }]);
  });

  it('treats markdown headings as source lines — the map is source-based, not render-styled', () => {
    // MarkdownView restyles '# Heading' visually, but the copy contract is
    // deliberately source-based: the map indexes the entry's SOURCE text,
    // so a full-card drag recovers the markdown the model wrote, not the
    // renderer's decoration. This pins that contract explicitly.
    const map = buildBodyRowMap('assistant', '# Heading\nplain line', 77);
    expect(map.rows).toEqual<BodyRowSpan[]>([
      { line: 0, start: 0, end: 9 },
      { line: 1, start: 0, end: 10 },
    ]);
    expect(map.text).toBe('# Heading\nplain line');
  });

  it('splits a wrapped line into prefix-sum spans that reconstruct the source', () => {
    // contentWidth = termWidth − 2 = 11 → ['aaaaa bbbbb', ' ccccc'] (lens 11, 6)
    const map = buildBodyRowMap('assistant', 'aaaaa bbbbb ccccc', 13);
    expect(map.rows).toEqual<BodyRowSpan[]>([
      { line: 0, start: 0, end: 11 },
      { line: 0, start: 11, end: 17 },
    ]);
    const line = (map.text.split('\n') ?? [''])[0] ?? '';
    const rejoined = map.rows.map((s) => line.slice(s.start, s.end)).join('');
    expect(rejoined).toBe(line);
  });

  it('gives empty source lines their own zero-width row', () => {
    const map = buildBodyRowMap('assistant', 'one\n\nthree', 77);
    expect(map.rows).toEqual<BodyRowSpan[]>([
      { line: 0, start: 0, end: 3 },
      { line: 1, start: 0, end: 0 },
      { line: 2, start: 0, end: 5 },
    ]);
  });

  it('numbers rows across a mix of wrapped and non-wrapped lines', () => {
    const map = buildBodyRowMap('assistant', 'one\naaaaa bbbbb ccccc', 13);
    expect(map.rows.map((s) => s.line)).toEqual([0, 1, 1]);
    expect(map.rows[1]).toEqual<BodyRowSpan>({ line: 1, start: 0, end: 11 });
    expect(map.rows[2]).toEqual<BodyRowSpan>({ line: 1, start: 11, end: 17 });
  });
});

describe('resolveRowCol', () => {
  it('reduces to v1 math on non-wrapped text: (row, col) → (line, offset)', () => {
    const map = buildBodyRowMap('assistant', 'alpha\nbravo', 77);
    expect(resolveRowCol(map, 0, 2, false)).toEqual({ line: 0, offset: 2 });
    expect(resolveRowCol(map, 1, 3, true)).toEqual({ line: 1, offset: 4 });
  });

  it('resolves a wrapped second-segment cell to its source offset', () => {
    const map = buildBodyRowMap('assistant', 'aaaaa bbbbb ccccc', 13);
    // Row 1 shows ' ccccc' (source chars 11..17). Col 2 → source offset 13.
    expect(resolveRowCol(map, 1, 2, false)).toEqual({ line: 0, offset: 13 });
    // Inclusive end at the last visible col → segment end.
    expect(resolveRowCol(map, 1, 5, true)).toEqual({ line: 0, offset: 17 });
  });

  it('clamps rows past the last span and columns past the segment', () => {
    const map = buildBodyRowMap('assistant', 'aaaaa bbbbb ccccc', 13);
    // Row 9 clamps to the last span (' ccccc', source 11..17); an inclusive
    // col 0 there means one char into that segment → source offset 12.
    expect(resolveRowCol(map, 9, 0, true)).toEqual({ line: 0, offset: 12 });
    // Col beyond the first segment's length clamps to its end.
    expect(resolveRowCol(map, 0, 99, false)).toEqual({ line: 0, offset: 11 });
  });
});

describe('assembleSelectionText wrap-aware recovery (M4)', () => {
  // Two source lines; line 0 wraps at contentWidth 11 (termWidth 13):
  //   visual row 0 → 'aaaaa bbbbb'   (line 0, chars 0..11)
  //   visual row 1 → ' ccccc'        (line 0, chars 11..17)
  //   visual row 2 → 'second line'   (line 1, no wrap)
  const text = 'aaaaa bbbbb ccccc\nsecond line';
  const entries = new Map<number, HistoryEntry>([[7, assistantEntry(7, text)]]);
  const slice = (
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
  ): SelectionSlice[] => [{ entryId: 7, startRow, startCol, endRow, endCol }];

  it('recovers the WYSIWYG slice from rows that wrap (v1 garbled this)', () => {
    // Drag from visual row 1 col 1 ('ccccc…') through row 2 col 5 ('second').
    expect(
      assembleSelectionText({ slices: slice(1, 1, 2, 5), entriesById: entries, termWidth: 13 }),
    ).toBe('ccccc\nsecond');
  });

  it('copies the full logical line when a drag spans only its wrapped rows', () => {
    expect(
      assembleSelectionText({ slices: slice(0, 0, 1, 5), entriesById: entries, termWidth: 13 }),
    ).toBe('aaaaa bbbbb ccccc');
  });

  it('keeps the v1 naive fallback byte-for-byte when termWidth is omitted', () => {
    // Without termWidth the wrap branch is inactive: v1 maps visual row 1 →
    // source line 1 and slices it from startCol — yielding 'econd line' and
    // dropping the wrapped tail. That garble is exactly what M4 fixes above;
    // this pins the fallback so the fix stays opt-in.
    expect(assembleSelectionText({ slices: slice(1, 1, 2, 5), entriesById: entries })).toBe(
      'econd line',
    );
  });

  it('is identical to v1 output for non-wrapped text', () => {
    const plain = new Map<number, HistoryEntry>([[9, assistantEntry(9, 'alpha bravo charlie')]]);
    const plainSlice: SelectionSlice[] = [
      { entryId: 9, startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
    ];
    const withWidth = assembleSelectionText({
      slices: plainSlice,
      entriesById: plain,
      termWidth: 77,
    });
    const withoutWidth = assembleSelectionText({ slices: plainSlice, entriesById: plain });
    expect(withWidth).toBe('alpha');
    expect(withWidth).toBe(withoutWidth);
  });
});

describe('inline-prefix translation (user label / info icon)', () => {
  it('wraps the user label into row 0 and maps continuation rows to text-local spans', () => {
    // Ground truth (wrap-ansi@10.0.1, trim:false hard:true): contentWidth 11
    // wraps '👤 USER  aaaaa bbbbb ccccc' into ['👤 USER  ', 'aaaaa bbbbb',
    // ' ccccc'] — row 0 is label-only, rows 1-2 are the text, exactly what
    // the renderer's single Text node puts on screen.
    const map = buildBodyRowMap('user', 'aaaaa bbbbb ccccc', 13);
    expect(map.prefixWidth).toBe(9);
    expect(map.rows).toEqual<BodyRowSpan[]>([
      { line: 0, start: 0, end: 0 },
      { line: 0, start: 0, end: 11 },
      { line: 0, start: 11, end: 17 },
    ]);
    // Rejoin invariant: the text-local spans reconstruct the source line.
    const line = map.text.split('\n')[0] ?? '';
    expect(map.rows.map((s) => line.slice(s.start, s.end)).join('')).toBe(line);
  });

  it('wraps the info prefix at the FULL termWidth (unbordered row)', () => {
    // 'ℹ alpha bravo charlie' @ 17 → ['ℹ alpha bravo ', 'charlie']; spans
    // are text-local: the 2-cell icon is subtracted from every row-0 segment.
    const map = buildBodyRowMap('info', 'alpha bravo charlie', 17);
    expect(map.prefixWidth).toBe(2);
    expect(map.rows).toEqual<BodyRowSpan[]>([
      { line: 0, start: 0, end: 12 },
      { line: 0, start: 12, end: 19 },
    ]);
  });

  it('pins the cells === code-units assumption both prefixes rely on', () => {
    // buildBodyRowMap subtracts prefixChars (UTF-16 code units) from row-0
    // segment offsets while resolveRowCol subtracts prefixWidth (terminal
    // cells). The two models coincide ONLY while each prefix char is
    // 1 code unit per cell (👤 is a surrogate pair: 2 units AND 2 cells).
    // A prefix that breaks this (a flag emoji is 4 units but 2 cells)
    // desynchronizes spans vs clamp SILENTLY — the rejoin invariant still
    // passes because both shift by prefixChars. This pin fails loudly.
    expect(stringWidth(USER_LABEL)).toBe(USER_LABEL.length);
    expect(stringWidth(INFO_PREFIX)).toBe(INFO_PREFIX.length);
  });

  it('clamps label clicks to the text start and shifts row-0 columns past the prefix', () => {
    const map = buildBodyRowMap('user', 'alpha bravo charlie', 77);
    // Wide pane, no wrap: row 0 = label cells [0,9) then the text. Clicks ON
    // the label clamp to text offset 0; col 9 is the first text cell.
    expect(resolveRowCol(map, 0, 0, false)).toEqual({ line: 0, offset: 0 });
    expect(resolveRowCol(map, 0, 8, true)).toEqual({ line: 0, offset: 1 });
    expect(resolveRowCol(map, 0, 9, false)).toEqual({ line: 0, offset: 0 });
    expect(resolveRowCol(map, 0, 14, true)).toEqual({ line: 0, offset: 6 });
  });

  it('mirrors Ink on degenerate narrow panes: label-only rows get zero-width spans', () => {
    // contentWidth floors at 1 while the label is 9 cells, so wrap-ansi
    // emits one row per cell (13 rows for label+'hello'). The first 8 rows
    // are prefix-only → zero-width spans; the text rows reconstruct the
    // source. Deliberately mirrors Ink instead of "fixing" the wrap.
    const map = buildBodyRowMap('user', 'hello', 3);
    expect(map.rows).toHaveLength(13);
    expect(map.rows.map((s) => map.text.slice(s.start, s.end)).join('')).toBe('hello');
  });
});

describe('assembleSelectionText inline-prefix recovery', () => {
  it('recovers text-local slices from a user card (label translated)', () => {
    // contentWidth 11: visual row 1 shows 'aaaaa bbbbb' (text chars 0..11).
    // Row 1 carries no label, so col 1 → text char 1 — the drag is fully
    // text-local instead of offset by the 9-cell label.
    const entries = new Map<number, HistoryEntry>([[3, userEntry(3, 'aaaaa bbbbb ccccc')]]);
    const slices: SelectionSlice[] = [
      { entryId: 3, startRow: 1, startCol: 1, endRow: 1, endCol: 5 },
    ];
    expect(assembleSelectionText({ slices, entriesById: entries, termWidth: 13 })).toBe('aaaa ');
  });

  it('translates the info icon prefix on row 0', () => {
    // Full width 17: row 0 spans text chars 0..12 with a 2-cell prefix, so
    // col 2 (first text cell) through col 8 inclusive → chars 0..7.
    const entries = new Map<number, HistoryEntry>([[4, infoEntry(4, 'alpha bravo charlie')]]);
    const slices: SelectionSlice[] = [
      { entryId: 4, startRow: 0, startCol: 2, endRow: 0, endCol: 8 },
    ];
    expect(assembleSelectionText({ slices, entriesById: entries, termWidth: 17 })).toBe('alpha b');
  });

  it('keeps the v1 naive path for user cards with a paste block', () => {
    // Copy base is pasteContent (copy-icon.ts) while the card renders two
    // text regions — the wrap map models one, so such cards are guarded back
    // to v1, which slices the base by raw card row/col.
    const entries = new Map<number, HistoryEntry>([[5, userEntry(5, '', 'pasted text')]]);
    const slices: SelectionSlice[] = [
      { entryId: 5, startRow: 0, startCol: 0, endRow: 0, endCol: 5 },
    ];
    expect(assembleSelectionText({ slices, entriesById: entries, termWidth: 77 })).toBe('pasted');
  });

  it('falls back to v1 raw-JSON recovery for an empty user card (empty render base)', () => {
    // text '' → copyableTextForEntry returns stringifyRaw(entry) (raw JSON).
    // The wrap map's base is empty — nothing to slice — so the assembler
    // must fall through to v1 and slice the JSON fallback instead of
    // silently returning ''. Row 0 of the pretty-printed JSON is '{'.
    const entries = new Map<number, HistoryEntry>([[6, userEntry(6, '')]]);
    const slices: SelectionSlice[] = [
      { entryId: 6, startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
    ];
    expect(assembleSelectionText({ slices, entriesById: entries, termWidth: 77 })).toBe('{');
  });
});
