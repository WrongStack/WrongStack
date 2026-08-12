import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { Text } from '../src/ink.js';
import {
  type UseWindowedPickerOptions,
  useWindowedPicker,
  type WindowedPickerSlice,
} from '../src/hooks/use-windowed-picker.js';

// Probe: render the hook's result as JSON so tests assert on the exact window
// math. The test renderer's stdout reports no rows, so `useTerminalSize`
// falls back to 24 — deterministic for every test here.
function WindowProbe(options: UseWindowedPickerOptions): React.ReactElement {
  const slice = useWindowedPicker(options);
  return React.createElement(Text, null, JSON.stringify(slice));
}

function windowOf(options: UseWindowedPickerOptions): WindowedPickerSlice {
  const view = render(React.createElement(WindowProbe, options));
  const frame = view.lastFrame() ?? '';
  view.unmount();
  return JSON.parse(frame) as WindowedPickerSlice;
}

describe('useWindowedPicker marker/maxRows math', () => {
  it('reserves markerRows in the window (the /theme overflow fix)', () => {
    // 24-row fallback − chrome 4 − shell 6 → 14 visible WITHOUT markers.
    const noMarkers = windowOf({ total: 40, selected: 0, chromeRows: 4 });
    expect(noMarkers.end).toBe(14);

    // Same picker with 2 `… more` marker rows + 1 conditional hint row:
    // the window must shrink by exactly those 3 rows, otherwise the picker
    // renders 3 rows taller than its own budget and overflows.
    const withMarkers = windowOf({ total: 40, selected: 0, chromeRows: 4, markerRows: 3 });
    expect(withMarkers.end).toBe(11);
    expect(withMarkers.hasBelow).toBe(true);
    expect(withMarkers.hasAbove).toBe(false);
  });

  it('maxRows replaces the shellReservedRows guess (measured budget wins)', () => {
    // maxRows = 10 measured by the caller; chrome 4 + markers 3 reserved
    // → 3 options fit. Without maxRows the legacy 24−4−3−6 guess gives 11.
    const measured = windowOf({
      total: 40,
      selected: 39,
      chromeRows: 4,
      markerRows: 3,
      maxRows: 10,
    });
    expect(measured.start).toBe(37);
    expect(measured.end).toBe(40);
    expect(measured.hasAbove).toBe(true);
    expect(measured.hasBelow).toBe(false);
  });

  it('clamps a too-small maxRows to minVisible instead of hiding the focus', () => {
    // maxRows 5 < chrome 4 + markers 3: available clamps to 1, then
    // minVisible (3) wins — the focused row is never hidden.
    const tight = windowOf({
      total: 40,
      selected: 39,
      chromeRows: 4,
      markerRows: 3,
      maxRows: 5,
      minVisible: 3,
    });
    expect(tight.end - tight.start).toBe(3);
    expect(tight.end).toBe(40);
    expect(tight.hasAbove).toBe(true);
  });

  it('a naked list with zero chrome fills its full maxRows budget', () => {
    const naked = windowOf({ total: 8, selected: 0, chromeRows: 0, markerRows: 0, maxRows: 8 });
    expect(naked).toEqual({ start: 0, end: 8, hasAbove: false, hasBelow: false });
  });

  it('an empty list returns an empty window with no markers', () => {
    const empty = windowOf({ total: 0, selected: 0 });
    expect(empty).toEqual({ start: 0, end: 0, hasAbove: false, hasBelow: false });
  });

  it('total smaller than the budget renders everything, top-aligned', () => {
    const short = windowOf({ total: 5, selected: 4, chromeRows: 4, markerRows: 3, maxRows: 24 });
    expect(short).toEqual({ start: 0, end: 5, hasAbove: false, hasBelow: false });
  });
});
