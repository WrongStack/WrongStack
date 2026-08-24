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

import { describe, expect, it } from 'vitest';
import type { HistoryEntry } from '../src/components/history.js';
import { assembleSelectionText } from '../src/components/scrollable-history.js';
import {
  buildBodyRowMap,
  resolveRowCol,
  type BodyRowSpan,
} from '../src/components/history/wrap-geometry.js';
import type { SelectionSlice } from '../src/components/scrollable-history.js';

function assistantEntry(id: number, text: string): HistoryEntry {
  return { id, kind: 'assistant', text };
}

describe('buildBodyRowMap', () => {
  it('maps a non-wrapped line to a single whole-line span (v1 reduction)', () => {
    const map = buildBodyRowMap('assistant', 'alpha bravo charlie', 77);
    expect(map.rows).toEqual<BodyRowSpan[]>([{ line: 0, start: 0, end: 19 }]);
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
  const slice = (startRow: number, startCol: number, endRow: number, endCol: number): SelectionSlice[] => [
    { entryId: 7, startRow, startCol, endRow, endCol },
  ];

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
