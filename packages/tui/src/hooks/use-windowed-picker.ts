/**
 * One shared viewport-windowing rule for the pickers that overlay the chat
 * history (theme / autonomy / design / resume).
 *
 * Before this hook, every picker rendered every option as a static
 * `<Box flexDirection="column">`. That was fine for autonomy's 5 options but
 * started overflowing as soon as `/theme` carried 15 presets and `/resume`
 * could list 30+ sessions. The pickers live inside the scrollable chat
 * viewport — they share its row budget — so windowing has to be driven off
 * `useTerminalSize` and per-picker chrome, not a hardcoded count.
 *
 * The hook returns the inclusive `start` and exclusive `end` of the visible
 * slice plus `hasAbove` / `hasBelow` indicators the caller can render as
 * `…` markers. When the caller moves `selected`, the next call re-centers
 * the viewport on the new index — no imperative scroll needed.
 */

import { useTerminalSize } from './use-terminal-size.js';

export interface UseWindowedPickerOptions {
  /** Total option count. */
  readonly total: number;
  /** Currently focused option index. The window re-centers on this. */
  readonly selected: number;
  /** Rows each option consumes (resume-picker entries take 3 lines). */
  readonly rowSpan?: number | undefined;
  /**
   * Rows the picker itself reserves around the list — top/bottom border,
   * header, hint, padding. Defaults to 4 which matches the current
   * `borderStyle="round"` + 2-line header pattern. Pass 0 for a naked list.
   *
   * This is a WORST-CASE reservation: the picker passes the maximum rows its
   * chrome can reach (including the `… more above/below` markers via
   * `markerRows`), so the window never overflows whether or not those
   * conditional rows actually render.
   */
  readonly chromeRows?: number | undefined;
  /**
   * Rows the conditional `… more above/below` marker lines consume when they
   * render. NOT part of `chromeRows` — a picker that shows both markers on a
   * 40-option list is 2 rows taller than its header+border chrome, and a
   * window sized against `chromeRows` alone overflows by exactly that many
   * rows. Pass the maximum marker count (2, plus 1 if a conditional hint row
   * exists) so the math reserves them up front.
   */
  readonly markerRows?: number | undefined;
  /**
   * Rows the surrounding app shell reserves — input bar + status bar + the
   * scrollable history's own chrome. Defaults to 6, which covers the input
   * bar (1), status bar (1), and a 4-row safety margin for header / hint /
   * padding. Bump this if your caller knows it needs more breathing room.
   *
   * Ignored when `maxRows` is provided — callers that can MEASURE the real
   * layout (e.g. app-view measuring the status bar + input heights) should
   * pass `maxRows` and drop this guess entirely.
   */
  readonly shellReservedRows?: number | undefined;
  /**
   * Exact row budget for the whole picker box, when the caller can measure
   * it (status bar + input + margins). Replaces the
   * `rows - shellReservedRows` guess: the window becomes
   * `floor((maxRows - chromeRows - markerRows) / rowSpan)` clamped to
   * `[minVisible, total]`. This is what makes the theme picker fit on a
   * 24-row terminal even when the input bar or status bar grows.
   */
  readonly maxRows?: number | undefined;
  /** Minimum visible options even on a tiny terminal. Defaults to 3. */
  readonly minVisible?: number | undefined;
}

export interface WindowedPickerSlice {
  /** Inclusive start index of the visible window. */
  readonly start: number;
  /** Exclusive end index of the visible window. */
  readonly end: number;
  /** True when at least one option is hidden above `start`. */
  readonly hasAbove: boolean;
  /** True when at least one option is hidden below `end - 1`. */
  readonly hasBelow: boolean;
}

/**
 * Compute a windowed slice of a picker list. Pure given the inputs — the only
 * "reactive" part is `useTerminalSize` so the window re-flows when the user
 * resizes their terminal while a picker is open.
 *
 * Behavior contract:
 *   - Visible count is `floor((available - chrome - markers) / rowSpan)`
 *     where `available` is either `maxRows` (measured) or
 *     `rows - shellReservedRows` (guessed), clamped to `[minVisible, total]`.
 *     A 1-row terminal always shows at least `minVisible` options even if
 *     that overflows — better to bleed than to hide the focused row.
 *   - The window stays centered on `selected` once the picker is past the
 *     first page; on the first page it stays top-aligned so the user sees
 *     the list start. `selected < 0 || selected >= total` is treated as no
 *     focus and the window anchors to index 0.
 *   - Empty / single-option lists always render `[0, total)` with both
 *     `hasAbove` and `hasBelow` false.
 *   - `maxRows` wins over `shellReservedRows`; when both are absent the
 *     legacy `rows - shellReservedRows` guess applies (backwards compatible).
 */
export function useWindowedPicker({
  total,
  selected,
  rowSpan = 1,
  chromeRows = 4,
  markerRows = 0,
  shellReservedRows = 6,
  maxRows,
  minVisible = 3,
}: UseWindowedPickerOptions): WindowedPickerSlice {
  const { rows } = useTerminalSize();

  // No options at all → empty window, no markers. The picker should also
  // short-circuit its body, but returning a consistent shape keeps the
  // callers' slice() calls safe.
  if (total <= 0) {
    return { start: 0, end: 0, hasAbove: false, hasBelow: false };
  }

  // Available rows for the list itself. Prefer the caller's measured budget
  // (`maxRows`); fall back to the legacy full-terminal guess. The reservation
  // must allow ZERO (a `chromeRows: 0, markerRows: 0` naked list reserves
  // nothing); the clamp-to-at-least-one belongs on the resulting `available`
  // value so a malformed stream still yields a positive window.
  const reserved = Math.max(0, chromeRows + markerRows);
  const available =
    maxRows !== undefined
      ? Math.max(1, maxRows - reserved)
      : Math.max(1, rows - reserved - shellReservedRows);
  const visible = Math.max(
    minVisible,
    Math.min(total, Math.floor(available / Math.max(1, rowSpan))),
  );

  const safeSelected = selected >= 0 && selected < total ? selected : 0;

  let start: number;
  if (safeSelected < visible) {
    // Top-aligned on the first page so the user sees the list start.
    start = 0;
  } else {
    // Center the focused row, then clamp so the window never bleeds past
    // the end. The half-window offset keeps the focus visible even on the
    // last page (it pulls `start` back when near the end).
    const halfWindow = Math.floor(visible / 2);
    start = safeSelected - halfWindow;
    start = Math.max(0, Math.min(total - visible, start));
  }
  const end = Math.min(total, start + visible);

  return {
    start,
    end,
    hasAbove: start > 0,
    hasBelow: end < total,
  };
}
