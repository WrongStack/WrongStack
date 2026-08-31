import { describe, expect, it } from 'vitest';
import {
  breakTerminalLigatures,
  displayWidth,
  frameRule,
  frameRuleParts,
  padDisplayEnd,
  sanitizeTerminalText,
  stripAnsi,
  truncateDisplay,
} from '../src/terminal-width.js';

describe('terminal column helpers', () => {
  it('measures ANSI, combining marks, CJK, emoji clusters, and Nerd Font PUA glyphs', () => {
    expect(displayWidth('\x1b[31mred\x1b[0m')).toBe(3);
    expect(displayWidth('e\u0301')).toBe(1);
    expect(displayWidth('界')).toBe(2);
    expect(displayWidth('👨‍👩‍👧‍👦')).toBe(2);
    expect(displayWidth('')).toBe(1);
    expect(displayWidth('❤️')).toBe(2);
    expect(displayWidth('\u200b')).toBe(0);
  });

  it('truncates and pads by display columns instead of UTF-16 length', () => {
    expect(truncateDisplay('ab界cd', 5)).toBe('ab界…');
    expect(displayWidth(truncateDisplay('hello world', 6))).toBe(6);
    expect(displayWidth(padDisplayEnd('界', 5))).toBe(5);
    expect(truncateDisplay('a👨‍👩‍👧‍👦b', 3)).toBe('a…');
  });

  it('keeps ligature-prone ASCII pairs as separate terminal cells', () => {
    const safe = breakTerminalLigatures('a->b x=>y p!=q');
    expect(safe).toBe('a- >b x= >y p! =q');
    expect(displayWidth(safe)).toBe(displayWidth('a->b x=>y p!=q') + 3);
  });

  it('normalizes terminal controls without mutating printable text', () => {
    const raw = 'PASS\tcolumn a->b\x1b[40Cspill\r\nnext\x1b]0;owned\x07line\x07';
    const safe = sanitizeTerminalText(raw);
    expect(safe).toBe('PASS  column a->bspill\nnextline');
    expect(safe).not.toMatch(/[\t\r\x1b\x07]/);
  });

  it('builds exact-width labeled frame rails', () => {
    const top = frameRule(48, '◆ ASK WRONGSTACK', 'READY', 'top');
    const bottom = frameRule(48, 'Enter send · / commands', '', 'bottom');
    expect(displayWidth(top)).toBe(48);
    expect(displayWidth(bottom)).toBe(48);
    expect(stripAnsi(top)).toMatch(/^╭─ ◆ ASK WRONGSTACK .* READY ─╮$/);
    expect(bottom).toMatch(/^╰─ Enter send · \/ commands .*╯$/);
  });

  it('keeps frame rails at exactly `width` columns when labels max their budgets', () => {
    // Regression: the fill used to clamp to zero once the 62%/30% label
    // budgets plus their `─ `/` ─` bookends exceeded the available space,
    // silently overflowing the rule past `width`. Labels must yield instead.
    const longLeft = 'L'.repeat(60);
    const longRight = 'R'.repeat(40);
    for (const width of [6, 10, 16, 24, 32, 40, 48, 64, 80]) {
      expect(displayWidth(frameRule(width, longLeft, longRight, 'top'))).toBe(width);
    }
  });

  it('keeps frameRuleParts head + reserved + tail === width for long labels', () => {
    // Regression: each combo is renderable (reserved <= width - 9) but the
    // old unclamped 62% label budget pushed the prefix past the slot's room.
    const longLeft = 'L'.repeat(60);
    for (const [width, reserved] of [
      [24, 4],
      [32, 7],
      [40, 11],
      [48, 20],
      [64, 20],
    ] as const) {
      const { head, tail } = frameRuleParts(width, longLeft, reserved, 'top');
      expect(displayWidth(head) + reserved + displayWidth(tail)).toBe(width);
    }
  });

  it('degrades frame rails to bare corners below the minimum labeled width', () => {
    for (const width of [1, 2, 3, 5]) {
      expect(displayWidth(frameRule(width, 'toolong', 'alsotoolong', 'top'))).toBeLessThanOrEqual(
        width,
      );
      const parts = frameRuleParts(width, 'toolong', 20, 'top');
      expect(displayWidth(parts.head) + displayWidth(parts.tail)).toBeLessThanOrEqual(width);
    }
  });

  it('splits a top rail into head/tail that reserve an exact-width chip slot', () => {
    // Invariant: head + reserved-gap + tail === full width, for any reserve.
    for (const width of [48, 60, 80, 120]) {
      for (const reserved of [4, 7, 11, 20]) {
        const { head, tail } = frameRuleParts(width, '◆ ASK WRONGSTACK', reserved, 'top');
        expect(displayWidth(head) + reserved + displayWidth(tail)).toBe(width);
        expect(stripAnsi(head)).toMatch(/^╭─ ◆ ASK WRONGSTACK /);
        expect(stripAnsi(tail)).toBe(' ─╮');
      }
    }
  });

  it('reserve width is independent of the chip content that fills it', () => {
    // idle ("idle" = 4 cols) vs a wider working word must not change geometry —
    // the caller pads the chip to the reserved width, so head/tail are stable.
    const narrow = frameRuleParts(80, '◆ ASK WRONGSTACK', 4, 'top');
    const wide = frameRuleParts(80, '◆ ASK WRONGSTACK', 16, 'top');
    expect(displayWidth(narrow.head) + 4 + displayWidth(narrow.tail)).toBe(80);
    expect(displayWidth(wide.head) + 16 + displayWidth(wide.tail)).toBe(80);
    // Wider reserve ⇒ shorter fill ⇒ shorter head.
    expect(displayWidth(wide.head)).toBeLessThan(displayWidth(narrow.head));
  });

  it('emits a bottom rail with the mirrored corners', () => {
    const { head, tail } = frameRuleParts(48, 'title', 6, 'bottom');
    expect(stripAnsi(head).startsWith('╰')).toBe(true);
    expect(stripAnsi(tail)).toBe(' ─╯');
  });

  it('degrades without a reserved slot like frameRule with an empty right label', () => {
    const { head, tail } = frameRuleParts(48, '◆ ASK WRONGSTACK', 0, 'top');
    expect(displayWidth(head) + displayWidth(tail)).toBe(48);
    expect(stripAnsi(tail)).toBe('╮');
  });
});
