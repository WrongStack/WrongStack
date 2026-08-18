import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { ThemePicker } from '../src/components/theme-picker.js';
import { useInput } from '../src/ink.js';
import { THEME_OPTIONS } from '../src/theme.js';
import { waitForFrame } from './helpers/frame-wait.js';
import { renderRealTty, settle } from './helpers/real-tty.js';

describe('ThemePicker', () => {
  it('renders the title, controls, active theme, and hint', () => {
    const view = render(
      React.createElement(ThemePicker, {
        options: THEME_OPTIONS,
        selected: 0,
        activeId: 'catppuccin',
        hint: 'Theme saved',
      }),
    );
    const frame = view.lastFrame() ?? '';

    expect(frame).toContain('TUI Theme');
    expect(frame).toContain('Enter apply');
    expect(frame).toContain('Catppuccin Mocha');
    expect(frame).toContain('[active]');
    expect(frame).toContain('Theme saved');
    view.unmount();
  });

  it('windows a long theme list around the selected row', () => {
    const view = render(
      React.createElement(ThemePicker, {
        options: THEME_OPTIONS,
        selected: THEME_OPTIONS.length - 1,
        activeId: 'tokyo-night',
      }),
    );
    const frame = view.lastFrame() ?? '';

    expect(frame).toContain('more above');
    expect(frame).toContain(THEME_OPTIONS.at(-1)?.name ?? '');
    view.unmount();
  });

  it('renders an empty option list without placeholder artifacts', () => {
    const view = render(
      React.createElement(ThemePicker, {
        options: [],
        selected: 0,
        activeId: 'catppuccin',
      }),
    );
    const frame = view.lastFrame() ?? '';

    expect(frame).toContain('TUI Theme');
    expect(frame).not.toContain('undefined');
    view.unmount();
  });

  it('renders the split preview pane on a wide terminal', async () => {
    // Real Ink/Yoga layout at the declared 100-col × 24-row size — plain
    // ink-testing-library render lays out at ~80 cols regardless of the
    // `columns` prop, which would measure a frame wider than what the picker
    // believes it has.
    const view = renderRealTty(
      React.createElement(ThemePicker, {
        options: THEME_OPTIONS,
        selected: 0,
        activeId: 'catppuccin',
        columns: 100,
        maxRows: 20,
      }),
      { columns: 100, rows: 24 },
    );
    await settle();
    const frame = view.lastFrame();

    // 24-row terminal budget: termRows(24) − status(2) − input(1) − margin(1)
    // = 20 rows. The whole picker must fit: count rendered terminal lines so
    // borders/wrapping can't silently overflow the budget.
    const lineCount = frame.replace(/\s+$/gm, '').split('\n').filter(Boolean).length;
    expect(lineCount).toBeLessThanOrEqual(20);

    // Preview pane: header shows the focused preset's id, then the sample,
    // diff, syntax, status and palette sections all fit within a 20-row
    // budget (15 content rows + header + 2 borders = 18).
    expect(frame).toContain('catppuccin');
    expect(frame).toContain('sample');
    expect(frame).toContain('diff');
    expect(frame).toContain('syntax');
    expect(frame).toContain('palette');
    // List rows in split mode drop the inline description — it lives in the
    // preview now.
    expect(frame).not.toContain('Warm pastel');
    view.unmount();
  });

  it('stays inside the maxRows budget on a short terminal and trims the preview from the bottom', async () => {
    const view = renderRealTty(
      React.createElement(ThemePicker, {
        options: THEME_OPTIONS,
        selected: THEME_OPTIONS.length - 1,
        activeId: 'tokyo-night',
        columns: 100,
        maxRows: 12,
      }),
      { columns: 100, rows: 24 },
    );
    await settle();
    const frame = view.lastFrame();

    // The whole picker box must fit the measured budget: 12 rows for the
    // tallest pane (list or preview). Count rendered terminal lines, not
    // just labels, so borders/wrapping can't silently overflow.
    const lineCount = frame.replace(/\s+$/gm, '').split('\n').filter(Boolean).length;
    expect(lineCount).toBeLessThanOrEqual(12);

    // 12-row budget: 4 chrome + 3 marker slots → 5 visible options, window
    // anchored near the end, so the first preset is hidden behind a marker.
    expect(frame).toContain('more above');
    expect(frame).not.toContain('Catppuccin Mocha');
    // The preview trims to fit: budget 12 − header − borders = 9 content
    // rows → sample (6) + diff (3) fit, syntax/status/palette are dropped.
    expect(frame).toContain('sample');
    expect(frame).toContain('diff');
    expect(frame).not.toContain('syntax');
    expect(frame).not.toContain('palette');
    view.unmount();
  });

  it('fits a 24-row terminal when the status bar wraps to 2 rows (pickerMaxRows = 19)', async () => {
    // Wiring edge case: app-view computes
    // `pickerMaxRows = max(8, termRows − statusBarRows − inputHeight − 1)`.
    // On a 24-row terminal the baseline status chrome measures 2 rows
    // (status bar + key-hint) → budget 20. When the status bar WRAPS to a
    // second line (too many chips), statusBarRows = 3 and the picker budget
    // tightens to 24 − 3 − 1 − 1 = 19. The picker must still fit.
    const view = renderRealTty(
      React.createElement(ThemePicker, {
        options: THEME_OPTIONS,
        selected: THEME_OPTIONS.length - 1,
        activeId: 'tokyo-night',
        columns: 100,
        maxRows: 19,
      }),
      { columns: 100, rows: 24 },
    );
    await settle();
    const frame = view.lastFrame();

    const lineCount = frame.replace(/\s+$/gm, '').split('\n').filter(Boolean).length;
    expect(lineCount).toBeLessThanOrEqual(19);

    // 19-row budget: list window = min(19, PREVIEW_FULL_ROWS 18) → 11
    // visible options with both panes topping out at 18 rows ≤ 19.
    expect(frame).toContain('more above');
    expect(frame).toContain('sample');
    expect(frame).toContain('palette');
    view.unmount();
  });

  it('updates the preview pane as arrow keys move the selection', async () => {
    // The picker itself does not own key handling (usePickerKeys dispatches
    // themePickerMove at the app level) — drive `selected` through a harness
    // that mirrors the reducer's wrap-around movement (composer.ts:
    // `(selected + delta + n) % n`), then assert the preview header follows
    // the focused preset.
    const view = render(
      React.createElement(() => {
        const [selected, setSelected] = React.useState(0);
        useInput((_input, key) => {
          if (key.downArrow) {
            setSelected((s) => (s + 1) % THEME_OPTIONS.length);
          }
          if (key.upArrow) {
            setSelected(
              (s) => (s - 1 + THEME_OPTIONS.length) % THEME_OPTIONS.length,
            );
          }
        });
        return React.createElement(ThemePicker, {
          options: THEME_OPTIONS,
          selected,
          activeId: 'catppuccin',
          columns: 100,
          maxRows: 20,
        });
      }),
    );

    // Ink delivers stdin asynchronously — wait for the committed selection
    // update before reading each frame so the assertions never observe a
    // stale pre-commit render (see helpers/frame-wait.ts).

    // Initial focus: preset 0 → preview header shows `catppuccin`.
    expect(view.lastFrame() ?? '').toContain('catppuccin');
    expect(view.lastFrame() ?? '').not.toContain('tokyo-night');

    // ↓ → preset 1 → the preview header follows to `tokyo-night`.
    view.stdin.write('\u001b[B');
    expect(await waitForFrame(view, (f) => f.includes('tokyo-night'))).toContain('tokyo-night');

    // ↓ → preset 2 → `nord`.
    view.stdin.write('\u001b[B');
    expect(await waitForFrame(view, (f) => f.includes('nord'))).toContain('nord');

    // ↑ back to preset 1.
    view.stdin.write('\u001b[A');
    expect(await waitForFrame(view, (f) => f.includes('tokyo-night'))).toContain('tokyo-night');
    view.unmount();
  });
});
