import { describe, expect, it } from 'vitest';
import { renderMarkdownTables, strWidth } from '../src/markdown-table.js';

describe('strWidth', () => {
  it('returns correct widths for emoji', () => {
    expect(strWidth('✅')).toBe(2);
    expect(strWidth('❌')).toBe(2);
  });

  it('returns correct widths for CJK', () => {
    expect(strWidth('名前')).toBe(4);
    expect(strWidth('田中')).toBe(4);
  });

  it('returns correct widths for ASCII', () => {
    expect(strWidth('Status')).toBe(6);
    expect(strWidth('Name')).toBe(4);
  });
});

describe('renderMarkdownTables', () => {
  it('passes through prose with no tables unchanged', () => {
    const text = 'Just a paragraph.\n\nAnother one with a | pipe but not a table.';
    expect(renderMarkdownTables(text, 80)).toBe(text);
  });

  it('renders a simple table with Unicode box-drawing chars', () => {
    const input = [
      '| Header A | Header B |',
      '|----------|----------|',
      '| a 1      | b 1      |',
      '| a 2      | b 2      |',
    ].join('\n');
    const out = renderMarkdownTables(input, 80);
    const lines = out.split('\n');
    // Top, header, separator, two rows, bottom = 6 lines
    expect(lines).toHaveLength(6);
    expect(lines[0]).toMatch(/^┌─+┬─+┐$/);
    expect(lines[1]).toContain('Header A');
    expect(lines[1]).toContain('Header B');
    expect(lines[2]).toMatch(/^├─+┼─+┤$/);
    expect(lines[3]).toContain('a 1');
    expect(lines[4]).toContain('a 2');
    expect(lines[5]).toMatch(/^└─+┴─+┘$/);
  });

  it('preserves surrounding prose around the table', () => {
    const input = ['before', '', '| A | B |', '|---|---|', '| 1 | 2 |', '', 'after'].join('\n');
    const out = renderMarkdownTables(input, 80);
    expect(out.startsWith('before\n\n┌')).toBe(true);
    expect(out.endsWith('┘\n\nafter')).toBe(true);
  });

  it('honours alignment markers (left, right, center)', () => {
    const input = ['| L | C | R |', '|:--|:-:|--:|', '| 1 | 2 | 3 |'].join('\n');
    const out = renderMarkdownTables(input, 80);
    // Strip ANSI escape codes so regex assertions only see visible text.
    const stripAnsi = (s: string) => s.replace(/\x1B\[\d*m/g, '');
    const row = stripAnsi(out.split('\n').find((l) => l.includes('1'))!);
    // Right column ends with the digit + ` │` (no trailing spaces).
    expect(row).toMatch(/\s3 │$/);
    expect(row).toMatch(/^│ 1\s/);
  });

  it('wraps long cell contents over multiple lines, keeping borders aligned', () => {
    const long = 'this is a fairly long cell content that should wrap';
    const input = ['| short | wide |', '|-------|------|', `| a     | ${long} |`].join('\n');
    const out = renderMarkdownTables(input, 40);
    const lines = out.split('\n');
    // Border lines all the same visual width (use strWidth, not .length,
    // because ANSI escape codes add string bytes but zero visual width).
    const widths = new Set(lines.map((l) => strWidth(l)));
    expect(widths.size).toBe(1);
    // The wide cell must have produced at least one additional row line.
    const dataLines = lines.filter((l) => l.startsWith('│ '));
    expect(dataLines.length).toBeGreaterThan(2);
  });

  it('does not treat a non-separator pipe line as a table', () => {
    // Header followed by something that isn't a separator → keep as prose.
    const input = '| A | B |\n| not a separator | also not |';
    const out = renderMarkdownTables(input, 80);
    expect(out).toBe(input);
  });

  it('handles tables narrower than terminal width without padding to fill', () => {
    const input = '| A | B |\n|---|---|\n| 1 | 2 |';
    const out = renderMarkdownTables(input, 200);
    // The table should be much narrower than 200.
    const first = out.split('\n')[0]!;
    expect([...first].length).toBeLessThan(40);
  });

  it('keeps table borders aligned when cells contain emoji', () => {
    // Emoji like ✅ are single code points but modern emoji render as
    // double-width in most terminals. Without proper width handling,
    // borders would misalign because text.length != visual width.
    const input = [
      '| Status | Name |',
      '|--------|------|',
      '| ✅     | Alice |',
      '| ❌     | Bob   |',
    ].join('\n');
    const out = renderMarkdownTables(input, 60);
    const lines = out.split('\n');
    // All lines must have the same visual width (not string length, which
    // undercounts emoji/CJK since they occupy 2 terminal columns per code point).
    const widths = new Set(lines.map((l) => strWidth(l)));
    expect(widths.size).toBe(1);
    // Borders must use proper box-drawing characters.
    expect(lines[0]).toMatch(/^┌─+┬─+┐$/); // top border
    expect(lines[2]).toMatch(/^├─+┼─+┤$/); // header separator
    expect(lines[5]).toMatch(/^└─+┴─+┘$/); // bottom border
  });

  it('handles CJK characters (double-width) without border misalignment', () => {
    // CJK characters are double-width in terminals.
    const input = [
      '| Name | Status |',
      '|------|--------|',
      '| 名前 | ✅    |',
      '| 山本 | ❌    |',
    ].join('\n');
    const out = renderMarkdownTables(input, 60);
    const lines = out.split('\n');
    // Debug: print lines and widths
    console.log('CJK test output:');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      console.log(`  [${i}] "${line}" visual=${strWidth(line)}`);
    }
    // All lines must have the same visual width.
    const widths = new Set(lines.map((l) => strWidth(l)));
    expect(widths.size).toBe(1);
  });

  it('emoji column width matches header width', () => {
    // The emoji column should be as wide as the header column, not just wide enough for the emoji.
    const input = ['| Status |', '|--------|', '| ✅     |'].join('\n');
    const out = renderMarkdownTables(input, 60);
    const lines = out.split('\n');
    console.log('Emoji single column:');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      console.log(`  [${i}] "${line}" visual=${strWidth(line)}`);
    }
    // All lines must have the same visual width.
    const widths = new Set(lines.map((l) => strWidth(l)));
    expect(widths.size).toBe(1);
  });

  it('handles emoji in wrapped cells correctly', () => {
    // A long cell with emoji should wrap at the right visual position.
    const input = [
      '| Item | Description |',
      '|------|-------------|',
      '| 1    | This is a very long description with emoji 🚀 that should wrap |',
    ].join('\n');
    const out = renderMarkdownTables(input, 50);
    const lines = out.split('\n');
    // All lines must have the same visual width (strWidth, not string length).
    const widths = new Set(lines.map((l) => strWidth(l)));
    expect(widths.size).toBe(1);
  });

  it('prevents -> ligature from misaligning table borders', () => {
    // Use a measured separator rather than a zero-width code point: Ink's
    // output grid allocates a cell even for U+200B while Yoga does not.
    const input = [
      '| Pattern  | Value |',
      '|----------|-------|',
      '| arrow    | a->b  |',
      '| fat      | x=>y  |',
    ].join('\n');
    const out = renderMarkdownTables(input, 60);
    const lines = out.split('\n');
    // Every line (borders + data) must have identical visual width.
    const widths = new Set(lines.map((l) => strWidth(l)));
    expect(widths.size).toBe(1);
    // The cell containing a->b must have a measured space breaking the ligature.
    const arrowRow = lines.find((l) => l.includes('a') && l.includes('b'))!;
    expect(arrowRow).toContain('- >');
  });

  it('prevents arrow chain ligatures in cells', () => {
    const input = ['| Chain |', '|-------|', '| a->b=>c |'].join('\n');
    const out = renderMarkdownTables(input, 60);
    expect(out).not.toContain('a->b');
    expect(out).not.toContain('b=>c');
    expect(out).toContain('a- >b=');
    expect(out).toContain('>c');
  });

  it('normalizes tabs and terminal controls before laying out table cells', () => {
    const input = [
      '| Status | Value |',
      '|--------|-------|',
      '| PASS\tNOW | a->b\x1b[40Cspill |',
    ].join('\n');
    const out = renderMarkdownTables(input, 40);
    expect(out).not.toMatch(/[\t\r\x1b]/);
    expect(out).toContain('PASS  NOW');
    expect(out).not.toContain('a->b');
    expect(out).toContain('a-');
    expect(out).toContain('>bspill');
    expect(new Set(out.split('\n').map(strWidth)).size).toBe(1);
  });

  it('falls back to bounded stacked rows when column chrome cannot fit', () => {
    const input = [
      '| A | B | C | D | E | F |',
      '|---|---|---|---|---|---|',
      '| one | two | three | four | five | six |',
    ].join('\n');
    const out = renderMarkdownTables(input, 24);
    expect(out).toContain('A: one');
    expect(out).toContain('F: six');
    expect(out).not.toContain('│');
    expect(out.split('\n').every((line) => strWidth(line) <= 24)).toBe(true);
  });

  it('renders an escaped \\| in a cell as a literal pipe', () => {
    const input = [
      '| Method | Returns |',
      '|--------|---------|',
      '| getUser | `Promise<string\\|null>` |',
    ].join('\n');
    const out = renderMarkdownTables(input, 80);
    expect(out).toContain('Promise<string|null>');
    // Still a two-column box table.
    expect(out.split('\n')[0]).toMatch(/^┌─+┬─+┐$/);
  });

  it('folds cells split by an unescaped | into the last column instead of dropping them', () => {
    // A raw pipe in a type notation splits the row into 3 cells for a
    // 2-column table; the overflow must rejoin the last column, not vanish.
    const input = [
      '| Method | Returns |',
      '|--------|---------|',
      '| deleteUser | Promise<string|Null> |',
    ].join('\n');
    const out = renderMarkdownTables(input, 80);
    expect(out).toContain('Promise<string|Null>');
    // The GFM cell-split boundary is unchanged: still exactly two columns.
    expect(out.split('\n')[0]).toMatch(/^┌─+┬─+┐$/);
    const dataRows = out.split('\n').filter((l) => l.startsWith('│ deleteUser'));
    expect(dataRows).toHaveLength(1);
  });

  it('rejoins multiple overflow fragments with their pipes in the last column', () => {
    const input = ['| fn | sig |', '|----|----|', '| g | A|B|C |'].join('\n');
    const out = renderMarkdownTables(input, 80);
    expect(out).toContain('A|B|C');
  });
});
