import { describe, expect, it } from 'vitest';
import { SidebarPanelFrame } from '../src/components/sidebar-panel-frame.js';
import { displayWidth } from '../src/terminal-width.js';
import { theme } from '../src/theme.js';
import { glyphs } from '../src/ui-glyphs.js';
import { renderRealTty } from './helpers/real-tty.js';

/**
 * Narrow-rail polish for the routed sidebar panel frame: the status pill is
 * the panel's live-state signal, so on narrow rails it must not share its
 * row with decorative chrome (flanking `─` dashes, footer `◆` ornament).
 */

function frameLines(view: { lines(): string[] }, width: number): string[] {
  const lines = view.lines().filter((line) => line.trim() !== '');
  for (const line of lines) {
    expect(displayWidth(line.trimEnd()), line).toBeLessThanOrEqual(width);
  }
  return lines;
}

describe('SidebarPanelFrame narrow-rail polish', () => {
  it('gives the status pill the full narrow body without decorative dashes', () => {
    const width = 16;
    const view = renderRealTty(
      <SidebarPanelFrame
        accent={theme.monitor.fleet}
        icon={glyphs.fleet}
        title="AGENT SWARM"
        width={width}
        kicker="quiet kicker note"
        pillLabel="3 LIVE"
        pillColor={theme.success}
        footer="move hint"
      />,
      { columns: 40, rows: 12 },
    );
    try {
      const lines = frameLines(view, width);
      // Status value readable: the pill label survives at full length.
      const pillLine = lines.find((line) => line.includes('3 LIVE'));
      expect(pillLine, lines.join('\n')).toBeDefined();
      // No decorative crowding: the pill row carries no flanking `─` rule,
      // and the pill starts at the rail edge instead of after a dash+gap.
      expect(pillLine!.includes(glyphs.dividerDash), pillLine).toBe(false);
      expect(pillLine!.trim().startsWith(glyphs.pillLeft), pillLine).toBe(true);
      // Title and footer data preserved on the narrow rail.
      expect(lines.some((line) => line.includes('AGENT SWARM'))).toBe(true);
      const footerLine = lines.find((line) => line.includes('move hint'));
      expect(footerLine).toBeDefined();
      // Footer ornament is quiet chrome: dropped on narrow rails.
      expect(footerLine!.includes(glyphs.dividerDiamond), footerLine).toBe(false);
      // Kicker stays hidden on narrow rails (existing contract).
      expect(lines.some((line) => line.includes('quiet kicker note'))).toBe(false);
    } finally {
      view.unmount();
    }
  });

  it('keeps the pill, kicker, and footer ornament on roomy rails', () => {
    const width = 30;
    const view = renderRealTty(
      <SidebarPanelFrame
        accent={theme.monitor.fleet}
        icon={glyphs.fleet}
        title="AGENT SWARM"
        width={width}
        kicker="quiet kicker note"
        pillLabel="3 LIVE"
        pillColor={theme.success}
        footer="move hint"
      />,
      { columns: 60, rows: 12 },
    );
    try {
      const lines = frameLines(view, width);
      // Pill rides the title row's right edge (no separate status row).
      expect(lines.some((line) => line.includes('AGENT SWARM') && line.includes('3 LIVE'))).toBe(
        true,
      );
      // Kicker and footer ornament stay on rails that can afford them.
      expect(lines.some((line) => line.includes('quiet kicker note'))).toBe(true);
      const footerLine = lines.find((line) => line.includes('move hint'));
      expect(footerLine).toBeDefined();
      expect(footerLine!.includes(`${glyphs.dividerDiamond} `), footerLine).toBe(true);
    } finally {
      view.unmount();
    }
  });
});
