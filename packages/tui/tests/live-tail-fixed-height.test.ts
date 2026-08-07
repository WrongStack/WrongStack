import { describe, expect, it } from 'vitest';
import { streamBoxRows } from '../src/components/history.js';
import { displayWidth } from '../src/terminal-width.js';

// Regression: the live tool-stream box must render at a
// CONSTANT height regardless of how much text is streaming. A region that grows
// row-by-row at the bottom of the terminal scrolls the screen on every update,
// and in inline mode each scroll leaks the top row into
// permanent scrollback — the bug where "◆ bash ⏱ …" and the input prompt get
// re-stamped into history dozens of times per turn.

describe('streamBoxRows (constant-height tool stream)', () => {
  it('always returns exactly maxLines rows regardless of input length', () => {
    for (const text of [
      '',
      'one',
      'a\nb\nc',
      Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n'),
    ]) {
      expect(streamBoxRows(text, 8, 100)).toHaveLength(8);
    }
  });

  it('bottom-pins content: short input pads blank rows on top', () => {
    const rows = streamBoxRows('x\ny', 8, 100);
    expect(rows.slice(0, 6).every((r) => r.text === '')).toBe(true);
    expect(rows[6]!.text).toBe('x');
    expect(rows[7]!.text).toBe('y');
  });

  it('overflow shows a "more above" marker as the first row and keeps height fixed', () => {
    const text = Array.from({ length: 20 }, (_, i) => `L${i}`).join('\n');
    const rows = streamBoxRows(text, 8, 100);
    expect(rows).toHaveLength(8);
    expect(rows[0]!.italic).toBe(true);
    expect(rows[0]!.text).toContain('more line');
    // Last 7 source lines are shown after the marker.
    expect(rows[7]!.text).toBe('L19');
  });

  it('truncates lines wider than contentWidth (no wrap)', () => {
    const rows = streamBoxRows('y'.repeat(200), 8, 40);
    const content = rows.find((r) => r.text.includes('y'))!;
    expect(content.text.length).toBeLessThanOrEqual(40);
    expect(content.text.endsWith('…')).toBe(true);
  });

  it('normalizes tabs and terminal cursor controls before measuring live output', () => {
    const rows = streamBoxRows('PASS\twide\x1b[40Cspill\r\nnext', 3, 20);
    expect(rows.map((row) => row.text)).toEqual(['', 'PASS  widespill', 'next']);
    expect(rows.every((row) => displayWidth(row.text) <= 20)).toBe(true);
    expect(rows.map((row) => row.text).join('\n')).not.toMatch(/[\t\r\x1b]/);
  });

  it('supports the write-create 3-line scrolling preview', () => {
    const rows = streamBoxRows('one\ntwo\nthree\nfour', 3, 100);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ italic: true });
    expect(rows.map((r) => r.text)).toEqual(['  … 1 more line above', 'three', 'four']);
  });
});
