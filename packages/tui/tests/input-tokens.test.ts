import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_TOKEN_SRC,
  deleteTokenBackward,
  inputIndexAtRowCol,
  layoutInputRows,
  PROTOCOL_TOKEN_SRC,
  splitChips,
  tokenLengthForward,
  tokenSpanAt,
} from '../src/input-tokens.js';

const rowText = (row: { ch: string }[]) => row.map((c) => c.ch).join('');

describe('deleteTokenBackward', () => {
  it('deletes a whole pasted chip ending at the cursor', () => {
    const buffer = 'hi [pasted #1, 12 lines]';
    const res = deleteTokenBackward(buffer, buffer.length);
    expect(res).toEqual({ buffer: 'hi ', cursor: 3 });
  });

  it('deletes a chip in the MIDDLE of the line (cursor just past it)', () => {
    const buffer = 'a [file:src/x.ts] b';
    const cursor = 'a [file:src/x.ts]'.length; // right after the chip
    const res = deleteTokenBackward(buffer, cursor);
    expect(res).toEqual({ buffer: 'a  b', cursor: 2 });
  });

  it('deletes a legacy `[file #1]` chip', () => {
    const buffer = 'see [file #1]';
    const res = deleteTokenBackward(buffer, buffer.length);
    expect(res).toEqual({ buffer: 'see ', cursor: 4 });
  });

  it('deletes a file chip with an absolute / nested / spaced path', () => {
    for (const tok of [
      '[file:d:/Codebox/PROJECTS/WrongStack/packages/tui/src/app.tsx]',
      '[file:packages/core/src/agent.ts]',
      '[file:my folder/a.ts]',
    ]) {
      const buffer = `hi ${tok}`;
      const res = deleteTokenBackward(buffer, buffer.length);
      expect(res).toEqual({ buffer: 'hi ', cursor: 3 });
    }
  });

  it('returns null when no chip ends at the cursor (plain char delete)', () => {
    expect(deleteTokenBackward('hello', 5)).toBeNull();
    // Cursor inside a chip — not a clean end boundary.
    const buffer = '[pasted #1, 5 lines]';
    expect(deleteTokenBackward(buffer, buffer.length - 1)).toBeNull();
  });
});

describe('tokenLengthForward', () => {
  it('returns the chip length when a chip starts at the cursor', () => {
    const buffer = 'x [image #2, PNG] y';
    const cursor = 'x '.length;
    expect(tokenLengthForward(buffer, cursor)).toBe('[image #2, PNG]'.length);
  });

  it('returns 0 when no chip starts at the cursor', () => {
    expect(tokenLengthForward('plain text', 0)).toBe(0);
  });
});

describe('tokenSpanAt', () => {
  it('returns the whole chip span when cursor is inside or at chip boundaries', () => {
    const chip = '[pasted #3, 10 lines]';
    const buffer = `before ${chip} after`;
    const start = 'before '.length;
    const end = start + chip.length;
    expect(tokenSpanAt(buffer, start)).toEqual({ start, end });
    expect(tokenSpanAt(buffer, start + 5)).toEqual({ start, end });
    expect(tokenSpanAt(buffer, end)).toEqual({ start, end });
  });

  it('returns null outside a chip', () => {
    expect(tokenSpanAt('before [file:a.ts] after', 0)).toBeNull();
  });
});

describe('splitChips', () => {
  it('splits plain text + chips into ordered spans', () => {
    const spans = splitChips('hello [pasted #1, 3 lines] world [file:a.ts]');
    expect(spans).toEqual([
      { text: 'hello ', chip: false },
      { text: '[pasted #1, 3 lines]', chip: true },
      { text: ' world ', chip: false },
      { text: '[file:a.ts]', chip: true },
    ]);
  });

  it('returns a single plain span when there are no chips', () => {
    expect(splitChips('just words')).toEqual([{ text: 'just words', chip: false }]);
  });

  it('returns an empty array for empty input', () => {
    expect(splitChips('')).toEqual([]);
  });

  it('treats [VIBE] as a chip for editing without classifying it as an attachment', () => {
    expect(splitChips('[VIBE] butona basınca sepet artsın')).toEqual([
      { text: '[VIBE]', chip: true },
      { text: ' butona basınca sepet artsın', chip: false },
    ]);
    expect(new RegExp(ATTACHMENT_TOKEN_SRC).test('[VIBE] sepet')).toBe(false);
    expect(new RegExp(PROTOCOL_TOKEN_SRC, 'i').test('[vibe] sepet')).toBe(true);
  });
});

describe('layoutInputRows', () => {
  const PROMPT = '› ';

  it('lays an empty buffer onto one row: prompt + cursor cell', () => {
    const rows = layoutInputRows(PROMPT, '', 0, 80);
    expect(rows).toHaveLength(1);
    expect(rowText(rows[0]!)).toBe('›  '); // prompt "› " + a virtual cursor space
    const cursorCells = rows.flat().filter((c) => c.cursor);
    expect(cursorCells).toHaveLength(1);
    expect(rows[0]!.slice(0, 2).every((c) => c.prompt)).toBe(true);
  });

  it('keeps a short line on a single row with the cursor in place', () => {
    const rows = layoutInputRows(PROMPT, 'hello', 2, 80);
    expect(rows).toHaveLength(1);
    expect(rowText(rows[0]!)).toBe('› hello');
    const cur = rows[0]!.find((c) => c.cursor)!;
    expect(cur.ch).toBe('l'); // value[2]
  });

  it('grows to the exact number of wrapped rows', () => {
    // width 10: "› " (2) + 25 chars = 27 cells → ceil(27/10) = 3 rows.
    const rows = layoutInputRows(PROMPT, 'x'.repeat(25), 25, 10);
    expect(rows.length).toBe(3);
    expect(rows[0]!.length).toBe(10);
    expect(rows[1]!.length).toBe(10);
    // cursor at end → trailing virtual cell on the last row.
    expect(rows.flat().filter((c) => c.cursor)).toHaveLength(1);
    expect(rows.at(-1)!.at(-1)!.cursor).toBe(true);
  });

  it('splits explicit newlines onto their own rows', () => {
    const rows = layoutInputRows(PROMPT, 'a\nb\nc', 5, 80);
    expect(rows.map(rowText)).toEqual(['› a', 'b', 'c ']); // cursor space on last
  });

  it('marks chip cells inside an inline token', () => {
    const value = 'hi [file:a.ts]';
    const rows = layoutInputRows(PROMPT, value, 0, 80);
    const chipChars = rows
      .flat()
      .filter((c) => c.chip)
      .map((c) => c.ch)
      .join('');
    expect(chipChars).toBe('[file:a.ts]');
  });

  it('never produces a row wider than the width', () => {
    const rows = layoutInputRows(PROMPT, 'abcdefghijklmnop', 3, 6);
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(6);
  });
});

describe('inputIndexAtRowCol (click → cursor index)', () => {
  const PROMPT = '› '; // length 2 — value starts at column 2 on row 0

  it('maps a click on a value column to the buffer index before that char', () => {
    // row 0: cols 0='›' 1=' ' 2='h'(0) 3='e'(1) 4='l'(2) 5='l'(3) 6='o'(4)
    expect(inputIndexAtRowCol(PROMPT, 'hello', 80, 0, 4)).toBe(2);
    expect(inputIndexAtRowCol(PROMPT, 'hello', 80, 0, 2)).toBe(0);
  });

  it('clicking the prompt lands at the start of the buffer', () => {
    expect(inputIndexAtRowCol(PROMPT, 'hello', 80, 0, 0)).toBe(0);
    expect(inputIndexAtRowCol(PROMPT, 'hello', 80, 0, 1)).toBe(0);
  });

  it('clicking past the last character lands just after it', () => {
    expect(inputIndexAtRowCol(PROMPT, 'hello', 80, 0, 99)).toBe(5);
  });

  it('clicking below all rows lands at the end of the buffer', () => {
    expect(inputIndexAtRowCol(PROMPT, 'hello', 80, 5, 0)).toBe(5);
  });

  it('handles an empty buffer (only the prompt row)', () => {
    expect(inputIndexAtRowCol(PROMPT, '', 80, 0, 0)).toBe(0);
    expect(inputIndexAtRowCol(PROMPT, '', 80, 0, 9)).toBe(0);
  });

  it('maps clicks across explicit newlines to the right line', () => {
    // "ab\ncd": row0 = "› ab" (a=0,b=1), row1 = "cd" (c=3,d=4)
    expect(inputIndexAtRowCol(PROMPT, 'ab\ncd', 80, 0, 2)).toBe(0); // 'a'
    expect(inputIndexAtRowCol(PROMPT, 'ab\ncd', 80, 0, 99)).toBe(2); // end of line 1 (before \n)
    expect(inputIndexAtRowCol(PROMPT, 'ab\ncd', 80, 1, 0)).toBe(3); // 'c'
    expect(inputIndexAtRowCol(PROMPT, 'ab\ncd', 80, 1, 99)).toBe(5); // end
  });

  it('places the caret on a blank line between newlines', () => {
    // "a\n\nb": row1 is the empty line; clicking it → index right after first \n
    expect(inputIndexAtRowCol(PROMPT, 'a\n\nb', 80, 1, 0)).toBe(2);
  });

  it('follows soft-wrapped rows (width-bounded, no newline)', () => {
    // width 6: row0 = "› abcd" (a..d = 0..3), row1 = "efgh" (e..h = 4..7)
    expect(inputIndexAtRowCol(PROMPT, 'abcdefgh', 6, 0, 5)).toBe(3); // 'd'
    expect(inputIndexAtRowCol(PROMPT, 'abcdefgh', 6, 1, 0)).toBe(4); // 'e'
    expect(inputIndexAtRowCol(PROMPT, 'abcdefgh', 6, 1, 99)).toBe(8); // end
  });
});
