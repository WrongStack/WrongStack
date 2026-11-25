import { describe, expect, it } from 'vitest';
import { historyViewportRows, hitRegion, statusBarLineRow } from '../src/hit-test.js';

describe('hit-test non-finite coordinate guards', () => {
  it('rejects NaN coordinates and layout dimensions cleanly', () => {
    const layout = { termRows: 40, termCols: 120, viewportRows: 30 };
    expect(hitRegion(layout, 10, 5)).toEqual({ kind: 'history', row: 4 });
    expect(hitRegion(layout, Number.NaN, 5)).toBeNull();
    expect(hitRegion(layout, 10, Number.NaN)).toBeNull();
    expect(hitRegion({ termRows: Number.NaN, termCols: 120, viewportRows: 30 }, 10, 5)).toBeNull();
    expect(historyViewportRows(Number.NaN, 5)).toBe(1);
    expect(historyViewportRows(40, Number.NaN)).toBe(40);
    expect(
      statusBarLineRow({
        termRows: 40,
        statusBarHeight: 3,
        belowHeight: 0,
        headerRows: 1,
        line: Number.NaN,
      }),
    ).toBeNull();
  });
});
