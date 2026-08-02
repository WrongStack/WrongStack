import { describe, expect, it } from 'vitest';
import {
  historyViewportRows,
  hitRegion,
  isHistoryScrollTarget,
  type MouseLayout,
  SCROLLBAR_HIT_WIDTH,
  statusBarLineRow,
} from '../src/hit-test.js';

// A 80x24 terminal with a 20-row history viewport (4-row bottom region).
const layout: MouseLayout = { termRows: 24, termCols: 80, viewportRows: 20 };

describe('historyViewportRows', () => {
  it('reserves the measured bottom region for the composer and status bar', () => {
    expect(historyViewportRows(24, 7)).toBe(17);
  });

  it('keeps at least one history row on short terminals', () => {
    expect(historyViewportRows(6, 9)).toBe(1);
  });
});

describe('hitRegion', () => {
  it('returns null for points outside the terminal', () => {
    expect(hitRegion(layout, 0, 5)).toBeNull();
    expect(hitRegion(layout, 5, 0)).toBeNull();
    expect(hitRegion(layout, 81, 5)).toBeNull();
    expect(hitRegion(layout, 5, 25)).toBeNull();
  });

  it('maps a click inside the viewport (away from the right edge) to history', () => {
    expect(hitRegion(layout, 1, 1)).toEqual({ kind: 'history', row: 0 });
    expect(hitRegion(layout, 40, 10)).toEqual({ kind: 'history', row: 9 });
    // Last history row of the viewport.
    expect(hitRegion(layout, 40, 20)).toEqual({ kind: 'history', row: 19 });
  });

  it('maps the right-edge columns of the viewport to the scrollbar track', () => {
    // Last column (the track itself) and the forgiving column beside it.
    expect(hitRegion(layout, 80, 1)).toEqual({ kind: 'scrollbar', cell: 0 });
    expect(hitRegion(layout, 79, 7)).toEqual({ kind: 'scrollbar', cell: 6 });
    // The cell is the 0-based track row = y-1, so it survives scrollOffset math.
    expect(hitRegion(layout, 80, 20)).toEqual({ kind: 'scrollbar', cell: 19 });
  });

  it('honors SCROLLBAR_HIT_WIDTH at the boundary', () => {
    // termCols - SCROLLBAR_HIT_WIDTH = 77 → column 77 is still history, 78 is bar.
    expect(hitRegion(layout, 77, 5)).toEqual({ kind: 'history', row: 4 });
    expect(hitRegion(layout, 78, 5)).toEqual({ kind: 'scrollbar', cell: 4 });
    expect(SCROLLBAR_HIT_WIDTH).toBe(3);
  });

  it('maps clicks below the viewport to the bottom region (0-based)', () => {
    expect(hitRegion(layout, 1, 21)).toEqual({ kind: 'bottom', row: 0 });
    expect(hitRegion(layout, 40, 24)).toEqual({ kind: 'bottom', row: 3 });
    // The right-edge rule does NOT apply below the viewport — it's bottom there.
    expect(hitRegion(layout, 80, 22)).toEqual({ kind: 'bottom', row: 1 });
  });

  it('treats a full-screen viewport (no bottom region) as all history/scrollbar', () => {
    const full: MouseLayout = { termRows: 10, termCols: 40, viewportRows: 10 };
    expect(hitRegion(full, 5, 10)).toEqual({ kind: 'history', row: 9 });
    expect(hitRegion(full, 40, 10)).toEqual({ kind: 'scrollbar', cell: 9 });
  });
});

describe('isHistoryScrollTarget', () => {
  it('accepts history and scrollbar wheel coordinates only', () => {
    expect(isHistoryScrollTarget(layout, 40, 10)).toBe(true);
    expect(isHistoryScrollTarget(layout, 80, 10)).toBe(true);
    expect(isHistoryScrollTarget(layout, 40, 21)).toBe(false);
    expect(isHistoryScrollTarget(layout, 80, 24)).toBe(false);
  });

  it('rejects coordinates outside the terminal', () => {
    expect(isHistoryScrollTarget(layout, 0, 10)).toBe(false);
    expect(isHistoryScrollTarget(layout, 40, 25)).toBe(false);
  });
});

describe('statusBarLineRow', () => {
  // 24-row terminal, status bar = 1 border + 3 content lines = 4 rows, nothing
  // below it. So the band occupies rows 21..24: border=21, line1=22, line2=23,
  // line3=24.
  const base = { termRows: 24, statusBarHeight: 4, belowHeight: 0, headerRows: 1 };

  it('places content lines after the border, bottom-anchored', () => {
    expect(statusBarLineRow({ ...base, line: 0 })).toBe(22); // line 1 (model/autonomy)
    expect(statusBarLineRow({ ...base, line: 1 })).toBe(23); // line 2 (session context)
    expect(statusBarLineRow({ ...base, line: 2 })).toBe(24); // line 3 (todos)
  });

  it('shifts the band up by the height of panels below the status bar', () => {
    // A 6-row panel below (e.g. FleetPanel) pushes the band to rows 15..18.
    const withBelow = { ...base, belowHeight: 6 };
    expect(statusBarLineRow({ ...withBelow, line: 0 })).toBe(16);
    expect(statusBarLineRow({ ...withBelow, line: 2 })).toBe(18);
  });

  it('returns null for a content line outside the measured band', () => {
    // Only 3 content lines (indices 0..2) exist.
    expect(statusBarLineRow({ ...base, line: 3 })).toBeNull();
    expect(statusBarLineRow({ ...base, line: -1 })).toBeNull();
  });

  it('handles a 4th fleet-detail line when the band is taller', () => {
    const tall = { termRows: 24, statusBarHeight: 5, belowHeight: 0, headerRows: 1 };
    expect(statusBarLineRow({ ...tall, line: 3 })).toBe(24); // line 4 exists
  });
});
