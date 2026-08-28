/**
 * Mouse hit-testing for the full-mouse-mode TUI layout.
 *
 * Ink exposes no absolute terminal coordinates, but the mouse-mode layout is
 * deterministic top-down: the chat history occupies the first `viewportRows`
 * rows of the terminal (its managed scrollbar is the last column of that band),
 * and everything below it (rows viewportRows+1 .. termRows) is the bottom region
 * — input, pickers, confirm prompt, status bar, panels. That is enough to map a
 * 1-based SGR mouse report (x,y) onto a coarse region without any DOM measuring.
 *
 * Finer resolution inside the bottom region (which status-bar line, which
 * confirm button) is layered on top by the consumers using their own measured
 * offsets + the co-located column-span helpers; this primitive only owns the
 * top-level row/column geometry so it stays pure and unit-testable.
 */

/** Mouse-mode layout geometry. All values are 1-based to match SGR reports. */
export interface MouseLayout {
  /** Live terminal row count. */
  termRows: number;
  /** Live terminal column count. */
  termCols: number;
  /** Rows the history viewport occupies, from the top of the screen. */
  viewportRows: number;
}

type HitRegion =
  /** The copy/scroll rail; `cell` is the 0-based row on the track. */
  | { kind: 'scrollbar'; cell: number }
  /** Inside the history viewport; `row` is 0-based from the viewport top. */
  | { kind: 'history'; row: number }
  /** Below the history viewport; `row` is 0-based from the bottom-region top. */
  | { kind: 'bottom'; row: number };

/**
 * Columns at the right edge of the history viewport reserved for the copy/scroll
 * rail. Copy icons use the first column, a blank gap separates them from the
 * scrollbar track in the last column.
 */
export const SCROLLBAR_HIT_WIDTH = 3;

/** Rows available to managed history after reserving the measured bottom UI. */
export function historyViewportRows(termRows: number, bottomHeight: number): number {
  return Math.max(1, Math.floor(termRows) - Math.max(0, Math.floor(bottomHeight)));
}

/**
 * Map a 1-based terminal (x,y) onto a layout region, or null when the point is
 * outside the terminal. Pure — no side effects, no DOM access.
 */
export function hitRegion(layout: MouseLayout, x: number, y: number): HitRegion | null {
  const { termRows, termCols, viewportRows } = layout;
  if (y < 1 || y > termRows || x < 1 || x > termCols) return null;
  if (y <= viewportRows) {
    if (x > termCols - SCROLLBAR_HIT_WIDTH) return { kind: 'scrollbar', cell: y - 1 };
    return { kind: 'history', row: y - 1 };
  }
  return { kind: 'bottom', row: y - viewportRows - 1 };
}

/** True when a wheel event belongs to the managed history viewport. */
export function isHistoryScrollTarget(layout: MouseLayout, x: number, y: number): boolean {
  const region = hitRegion(layout, x, y);
  return region?.kind === 'history' || region?.kind === 'scrollbar';
}

/**
 * 1-based absolute terminal row of a status-bar content line.
 *
 * The status bar is bottom-anchored above whatever panels render below it, so
 * its band starts at `termRows - belowHeight - statusBarHeight + 1`. Its first
 * `headerRows` rows are non-content (the single top border), so content line
 * `line` (0-based: line 1 = 0) sits `headerRows + line` rows into the band.
 *
 * `statusBarHeight` and `belowHeight` are live `measureElement` heights of the
 * status-bar wrapper and the below-status-bar panel region. Returns null when
 * the requested content line doesn't exist in the measured band.
 */
export function statusBarLineRow(opts: {
  termRows: number;
  /** Measured status-bar height, including its top border row. */
  statusBarHeight: number;
  /** Measured height of everything rendered below the status bar (0 if none). */
  belowHeight: number;
  /** Non-content rows at the top of the status bar (the border). */
  headerRows: number;
  /** 0-based content line index (line 1 = 0, line 2 = 1, …). */
  line: number;
}): number | null {
  const contentLines = opts.statusBarHeight - opts.headerRows;
  if (opts.line < 0 || opts.line >= contentLines) return null;
  const bandTop = opts.termRows - opts.belowHeight - opts.statusBarHeight + 1;
  return bandTop + opts.headerRows + opts.line;
}
