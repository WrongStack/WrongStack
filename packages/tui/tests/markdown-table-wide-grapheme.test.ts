import { describe, expect, it } from 'vitest';
import { renderMarkdownTables } from '../src/markdown-table.js';
import { displayWidth } from '../src/terminal-width.js';

/**
 * Regression: `wrapCell`'s hard-break loop spun forever when a single
 * grapheme (CJK/emoji) was wider than the wrap width — `splitDisplay`
 * returns `['', rest]` and nothing progressed. Reachable via the stacked
 * key/value path at narrow budgets (e.g. `renderMarkdownTables(text, 1)`).
 */
describe('renderMarkdownTables wide-grapheme cells', () => {
  it('terminates when a stacked cell grapheme is wider than the column', () => {
    const out = renderMarkdownTables('| 名前 | x |\n|---|---|\n| 世界 | 1 |', 1);
    expect(typeof out).toBe('string');
    for (const line of out.split('\n')) {
      expect(displayWidth(line)).toBeLessThanOrEqual(1);
    }
  });

  it('terminates for emoji cells at width 1', () => {
    const out = renderMarkdownTables('| 👍 |\n|---|\n| x |', 1);
    expect(typeof out).toBe('string');
    for (const line of out.split('\n')) {
      expect(displayWidth(line)).toBeLessThanOrEqual(1);
    }
  });

  it('keeps benign narrow (stacked) output byte-identical', () => {
    expect(renderMarkdownTables('| a | b |\n|---|---|\n| 1 | 2 |', 1)).toBe('a\n:\n1\nb\n:\n2');
  });

  it('keeps benign wide (box) output byte-identical', () => {
    expect(renderMarkdownTables('| a | b |\n|---|---|\n| 1 | 2 |', 40)).toBe(
      '┌─────┬─────┐\n│ a   │ b   │\n├─────┼─────┤\n│ 1   │ 2   │\n└─────┴─────┘',
    );
  });

  it('keeps box-table border alignment with wide characters', () => {
    const lines = renderMarkdownTables('| 名前 | x |\n|---|---|\n| 世界 | 1 |', 40).split('\n');
    expect(new Set(lines.map((line) => displayWidth(line))).size).toBe(1);
    expect(lines).toHaveLength(5);
  });
});
