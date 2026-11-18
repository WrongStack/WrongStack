import { describe, expect, it } from 'vitest';
import { SidebarSectionHeader } from '../src/components/sidebar-panel-frame.js';
import { displayWidth } from '../src/terminal-width.js';
import { renderRealTty } from './helpers/real-tty.js';

/** The header promises exactly one row of exactly `innerWidth` columns. */
describe('SidebarSectionHeader on a narrow card', () => {
  it.each([12, 14, 16, 20, 30])('keeps a long label on one row at %i columns', (width) => {
    const view = renderRealTty(
      <SidebarSectionHeader
        glyph="▦"
        label="SYSTEM VITALS"
        color="cyan"
        badge="HEALTHY"
        innerWidth={width}
        pill
      />,
      { columns: 40, rows: 6 },
    );
    try {
      const rows = view.lines().filter((line) => line.trim() !== '');
      expect(rows).toHaveLength(1);
      expect(displayWidth(rows[0]!.trimEnd())).toBeLessThanOrEqual(width);
      expect(rows[0]).toContain('SYSTEM');
    } finally {
      view.unmount();
    }
  });

  it('never glues a lone leader dot to the label', () => {
    const label = 'PROMPT CACHE';
    // Rail, node and label take 16 columns; one column is left over.
    const view = renderRealTty(
      <SidebarSectionHeader glyph="◔" label={label} color="cyan" innerWidth={17} />,
      { columns: 40, rows: 4 },
    );
    try {
      expect(view.lines()[0]).not.toContain(`${label}·`);
    } finally {
      view.unmount();
    }
  });
});
