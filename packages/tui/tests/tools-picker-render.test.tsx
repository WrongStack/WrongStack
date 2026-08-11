import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { type ToolPickerItem, ToolsPicker } from '../src/components/tools-picker.js';

function item(overrides: Partial<ToolPickerItem> = {}): ToolPickerItem {
  return {
    name: 'read',
    owner: 'core',
    category: 'filesystem',
    enabled: true,
    exposure: 'direct',
    mutating: false,
    permission: 'auto',
    descMode: 'extend',
    description: 'Read a file before editing it.',
    ...overrides,
  };
}

/** Names visible in the rendered frame, in the order they appear. */
function visibleRowNames(frame: string, candidateNames: string[]): string[] {
  // The picker renders rows top-to-bottom; the first occurrence of each
  // candidate name is the visible row, subsequent matches would be from
  // the focused-row inverse styling and we ignore them.
  const seen = new Set<string>();
  const out: string[] = [];
  const lines = frame.split('\n');
  for (const line of lines) {
    for (const name of candidateNames) {
      if (seen.has(name)) continue;
      if (line.includes(name)) {
        seen.add(name);
        out.push(name);
      }
    }
  }
  return out;
}

describe('ToolsPicker rendering', () => {
  it('keeps disabled tools visible in-place and renders provider exposure', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ToolsPicker, {
        items: [
          item({ name: 'read', category: 'filesystem' }),
          item({
            name: 'write',
            category: 'filesystem',
            enabled: false,
            exposure: 'disabled',
            mutating: true,
            permission: 'confirm',
            description: 'Write file contents.',
          }),
          item({ name: 'grep', category: 'search', exposure: 'lazy' }),
        ],
        selected: 1,
      }),
    );

    const frame = lastFrame() ?? '';
    const readIndex = frame.indexOf('read');
    const writeIndex = frame.indexOf('write');
    const grepIndex = frame.indexOf('grep');
    expect(readIndex).toBeGreaterThanOrEqual(0);
    expect(writeIndex).toBeGreaterThan(readIndex);
    expect(grepIndex).toBeGreaterThan(writeIndex);
    expect(frame).toContain('○ disabled');
    expect(frame).toContain('1 direct / 1 lazy / 1 disabled');
    expect(frame).toContain('Lazy tools stay executable through discovery gateways');
    expect(frame).toContain('Enter re-enables this tool');
    expect(frame).toContain('Write file contents.');
    expect(frame).toMatch(/write\s+Filesystem\s+\[core\]/);
    expect(frame).not.toMatch(/\n\s+Filesystem\s*\n/);
    expect(frame).not.toMatch(/\n\s+Search\s*\n/);
    unmount();
  });

  it('truncates long columns before rendering the next column', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ToolsPicker, {
        items: [
          item({
            name: 'dependency_audit_status_with_extra_suffix',
            category: 'diagnostics-with-a-very-long-label',
            owner: 'dependency-vulnerability-gate-owner-with-extra-suffix',
            permission: 'confirm-with-extra-suffix',
          }),
        ],
        selected: 0,
      }),
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('dependency_audit_status_wit…');
    expect(frame).toContain('Diagnostics-w…');
    expect(frame).toContain('[dependency-vulnera…');
    expect(frame).toContain('confirm…');
    expect(frame).toContain('ro');
    expect(frame).toContain('desc:ex…');
    unmount();
  });

  it('caps filtered matches with overflow indicators (regression: filter bypass)', () => {
    // 24 tools whose name starts with "tool_" so the filter prefix "tool"
    // matches all of them. With filter-mode windowing active, the rendered
    // frame must:
    //   1. Show fewer rows than the full filter set (windowing engaged).
    //   2. Display ↑/↓ overflow indicators so the user knows there is more.
    //   3. Keep the focused row inside the visible window so the user can
    //      confirm what Enter will toggle.
    //   4. Select the middle row so both indicators are visible (the
    //      picker pins to top/bottom when the focused row is at an edge,
    //      which hides the corresponding indicator).
    const items: ToolPickerItem[] = Array.from({ length: 24 }, (_, i) =>
      item({
        name: `tool_${String(i).padStart(2, '0')}`,
        owner: 'core',
        category: 'misc',
        description: `Synthetic tool row ${i}.`,
      }),
    );
    const allNames = items.map((it) => it.name);

    const { lastFrame, unmount } = render(
      React.createElement(ToolsPicker, {
        items,
        selected: 12,
        filter: 'tool',
      }),
    );

    const frame = lastFrame() ?? '';
    const visible = visibleRowNames(frame, allNames);

    // Without windowing, all 24 names would be in the frame. The cap must
    // trim the visible count to at most MAX_PICKER_ITEMS (15) — and on a
    // 24-row ink-testing-library terminal, the chrome-derived height cap
    // (termRows - CHROME_ROWS) is even tighter (9). Both are fine; what
    // matters is the count is below 24.
    expect(visible.length).toBeLessThan(24);
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.length).toBeLessThanOrEqual(15);
    // Filter-mode overflow indicators must be shown.
    expect(frame).toMatch(/↑ \d+ more/);
    expect(frame).toMatch(/↓ \d+ more/);
    // The focused row should appear somewhere in the visible window so the
    // user can confirm what Enter will toggle.
    expect(visible).toContain('tool_12');
    unmount();
  });

  it('windowing centred on selection still works when filtering shows fewer than 15 matches', () => {
    // Six matching tools with selected=2: windowing should leave all six
    // visible (the cap doesn't artificially truncate small filtered lists).
    const items: ToolPickerItem[] = Array.from({ length: 6 }, (_, i) =>
      item({
        name: `pin_${String(i).padStart(2, '0')}`,
        description: `Pin tool ${i}.`,
      }),
    );
    const allNames = items.map((it) => it.name);

    const { lastFrame, unmount } = render(
      React.createElement(ToolsPicker, {
        items,
        selected: 2,
        filter: 'pin',
      }),
    );

    const frame = lastFrame() ?? '';
    const visible = visibleRowNames(frame, allNames);
    expect(visible.length).toBe(6);
    expect(visible).toContain('pin_02');
    // No overflow indicators when the entire filtered set fits.
    expect(frame).not.toMatch(/↑ \d+ more/);
    expect(frame).not.toMatch(/↓ \d+ more/);
    unmount();
  });
});
