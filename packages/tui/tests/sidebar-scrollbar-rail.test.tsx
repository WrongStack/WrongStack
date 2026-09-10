import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { SidebarScrollbar } from '../src/components/sidebar-scrollbar.js';
import { stripAnsi } from '../src/terminal-width.js';
import { glyphs } from '../src/ui-glyphs.js';

describe('SidebarScrollbar persistent rail', () => {
  it('renders a dimmed thumb-less track when there is nothing to scroll', () => {
    const view = render(
      React.createElement(SidebarScrollbar, { viewportRows: 4, offset: 0, maxScroll: 0 }),
    );
    const frame = stripAnsi(view.lastFrame() ?? '');
    // The rail no longer disappears when maxScroll is 0 — it draws the
    // reserved column as a quiet track instead.
    expect(frame).not.toBe('');
    expect(frame).toContain(glyphs.cellEmpty);
    expect(frame).not.toContain(glyphs.meter7);
    expect(frame.split('\n')).toHaveLength(4);
    view.unmount();
  });

  it('draws the thumb once content overflows', () => {
    const view = render(
      React.createElement(SidebarScrollbar, { viewportRows: 6, offset: 0, maxScroll: 12 }),
    );
    const frame = stripAnsi(view.lastFrame() ?? '');
    expect(frame).toContain(glyphs.meter7);
    expect(frame).toContain(glyphs.cellEmpty);
    view.unmount();
  });

  it('moves the thumb to the bottom of the track at max offset', () => {
    const view = render(
      React.createElement(SidebarScrollbar, { viewportRows: 6, offset: 12, maxScroll: 12 }),
    );
    const rows = stripAnsi(view.lastFrame() ?? '').split('\n');
    expect(rows[rows.length - 1]).toContain(glyphs.meter7);
    view.unmount();
  });

  it('still renders nothing when there is no room for a track', () => {
    const view = render(
      React.createElement(SidebarScrollbar, { viewportRows: 0, offset: 0, maxScroll: 5 }),
    );
    expect(stripAnsi(view.lastFrame() ?? '')).toBe('');
    view.unmount();
  });

  it('pins the degenerate single-row track: one cell, thumb whenever scrollable', () => {
    // Idle single-row viewport: exactly one dimmed track cell, never a thumb.
    const idle = render(
      React.createElement(SidebarScrollbar, { viewportRows: 1, offset: 0, maxScroll: 0 }),
    );
    const idleFrame = stripAnsi(idle.lastFrame() ?? '');
    expect(idleFrame.split('\n')).toHaveLength(1);
    expect(idleFrame).toContain(glyphs.cellEmpty);
    expect(idleFrame).not.toContain(glyphs.meter7);
    idle.unmount();

    // Scrollable single-row viewport: the thumb math degenerates to a
    // full-height thumb (round(viewport²/content) clamps 0 → 1 row), so the
    // lone cell is `▉` at every offset.
    const scrolled = render(
      React.createElement(SidebarScrollbar, { viewportRows: 1, offset: 5, maxScroll: 5 }),
    );
    const scrolledFrame = stripAnsi(scrolled.lastFrame() ?? '');
    expect(scrolledFrame.split('\n')).toHaveLength(1);
    expect(scrolledFrame).toContain(glyphs.meter7);
    scrolled.unmount();
  });
});
