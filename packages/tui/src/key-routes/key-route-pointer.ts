/**
 * Pointer routes for the TUI key handler — decomposition Phase 3 route 4.
 *
 * Moved verbatim from `createAppKeyHandler`/`handleKey`
 * (docs/decomposition-plan.md, Phase 3). `routeSidebarFocusScroll` owns the
 * keyboard-driven sidebar focus/scroll tail (Shift+Tab toggle, ↑/↓ scroll,
 * Esc/typing unfocus); `routePointerEvents` owns the full mouse block
 * (right-press copy fallback, wheel split, sidebar rail scrub, history
 * scrollbar click/drag, copy icons, drag-select, release-commits-copy,
 * status-bar chips, PageUp/PageDown, Ctrl+U/D paging).
 *
 * Call-order contract (pinned by tests/key-handler-replay-corpus.test.ts):
 * routeSidebarFocusScroll runs with the panel routes; routePointerEvents
 * runs after the composer Enter pipeline and before routeInputKey.
 */
import { AUTONOMY_OPTIONS } from '../components/autonomy-picker.js';
import type { KeyEvent } from '../components/input.js';
import { SELECTION_COPY_ID } from '../components/scrollable-history.js';
import { sidebarOffsetForCell } from '../components/sidebar-scrollbar.js';
import { STATUSLINE_ITEMS } from '../components/statusline-picker.js';
import {
  hitRegion,
  isHistoryScrollTarget,
  SCROLLBAR_HIT_WIDTH,
  statusBarLineRow,
} from '../hit-test.js';
import { measureElement } from '../ink.js';
import type { KeyRouteContext } from '../key-handler-context.js';
import { estimateSidebarMaxScroll } from '../reducers/workspace-panels.js';

/**
 * Sidebar focus + scroll. Shift+Tab on an empty draft toggles keyboard focus
 * between the chat input and the right sidebar. When sidebar-focused, ↑/↓
 * scroll the sidebar content. Esc or typing unfocuses automatically.
 */
export function routeSidebarFocusScroll(
  ctx: KeyRouteContext,
  input: string,
  key: KeyEvent,
): boolean {
  const {
    state,
    dispatch,
    draftRef,
    overlayOpen,
    termRows,
    sidebarTwinRowCount,
    effectiveSwarmOnSidebar,
  } = ctx;
  if (key.tab && key.shift && draftRef.current.buffer === '' && !overlayOpen) {
    dispatch({ type: 'toggleSidebarFocus' });
    return true;
  }
  if (state.sidebarFocused && !overlayOpen) {
    // The ↑↓ scroll applies to `SidebarContent` (context/model/fleet/
    // sessions cards). Per-panel sidebar twins scroll internally and
    // share the same RightSidebar region; they DO shrink the
    // SidebarContent viewport when mounted, so we pass
    // `sidebarTwinRowCount` (computed at the call site from the open
    // twin flags) and the reducer subtracts it from the viewport before
    // clamping. The mission-queue reservation also depends on the
    // effective swarm-panel source (picker draft vs persisted config)
    // — `effectiveSwarmOnSidebar` is the dual-source boolean from
    // `resolveSidebarLayout`.
    const sidebarViewportHeight = termRows - 2;
    if (key.upArrow) {
      dispatch({
        type: 'sidebarScroll',
        delta: -1,
        viewportHeight: sidebarViewportHeight,
        sidebarTwinRowCount,
        effectiveSwarmOnSidebar,
      });
      return true;
    }
    if (key.downArrow) {
      dispatch({
        type: 'sidebarScroll',
        delta: 1,
        viewportHeight: sidebarViewportHeight,
        sidebarTwinRowCount,
        effectiveSwarmOnSidebar,
      });
      return true;
    }
    if (key.escape) {
      dispatch({ type: 'toggleSidebarFocus' });
      return true;
    }
    if (input) {
      // Non-empty input unfocuses the sidebar so the keystroke lands
      // in the chat input buffer (falls through below).
      dispatch({ type: 'toggleSidebarFocus' });
    }
  }
  return false;
}

/**
 * Full mouse block: right-press copy fallback, wheel split (sidebar band vs
 * history viewport), sidebar rail press/drag scrub, history scrollbar
 * click/drag with inspect/copy/tool-control icons, drag-to-select,
 * release-commits-copy, clickable status-bar chips (mouseMode-gated), and
 * PageUp/PageDown/Ctrl+U/D history paging. Returns true when the event was
 * consumed.
 */
export async function routePointerEvents(
  ctx: KeyRouteContext,
  input: string,
  key: KeyEvent,
): Promise<boolean> {
  const {
    state,
    dispatch,
    draftRef,
    overlayOpen,
    stdout,
    termRows,
    historyWidth,
    sidebarTwinRowCount,
    effectiveSwarmOnSidebar,
    mouseMode,
    historyScrollRef,
    onHistoryCopy,
    onHistoryScrollActivity,
    statusBarWrapRef,
    belowStatusBarRef,
    statusBarClickMapRef,
    openModelPicker,
    openStatuslinePicker,
  } = ctx;
  // History lives in a bounded managed viewport. Skip scrolling when ANY
  // overlay below the statusline is open — these overlays
  // use arrow keys for their own navigation (↑↓ selection, scrolling).
  // Pickers (settings/model/autonomy) are already intercepted earlier
  // and never reach this point, so they don't need listing here.
  // (overlayOpen is defined above in the multi-line input navigation section.)

  // Wheel always drives the managed history viewport. Native terminal
  // scrollback cannot reveal virtualized rows, so gating this on full mouse
  // mode makes the wheel appear broken (especially on macOS terminals without
  // dedicated PageUp/PageDown keys). Drag-select-copy and scrollbar scrub
  // also work in every mode (button-drag tracking is always on); full mouse
  // mode still gates the clickable status-bar chips.
  if (!overlayOpen) {
    // Right-press in the history card band commits any drag selection that
    // is still pending (one whose release was swallowed or that ended out
    // of band). With release-commits-copy below, a normally released
    // selection is already committed and cleared, so this usually no-ops;
    // it stays as the explicit fallback.
    if (key.mouse?.kind === 'press' && key.mouse.button === 'right') {
      const region = hitRegion(
        { termRows, termCols: historyWidth, viewportRows: state.viewportRows },
        key.mouse.x,
        key.mouse.y,
      );
      if (region?.kind === 'history' && key.mouse.x <= historyWidth - SCROLLBAR_HIT_WIDTH) {
        // Clipboard write — fails with no `xclip` / `clip.exe` on PATH.
        ctx.detach(
          historyScrollRef.current?.commitSelection().then((copied) => {
            if (copied) onHistoryCopy?.(SELECTION_COPY_ID);
          }),
          'Copy',
        );
        return true;
      }
      // Right-press outside the card area (gutter, bottom region, outside
      // the viewport) clears any stale selection so a late commit doesn't
      // fire on an old drag the user has forgotten about.
      historyScrollRef.current?.clearSelection();
    }
    // Horizontal trackpad reports are also encoded as "wheel" with delta 0;
    // ignore them so diagonal gestures do not accidentally move chat down.
    if (key.mouse?.kind === 'wheel' && key.mouse.wheel !== 0) {
      // ── Sidebar wheel scroll ──
      // When the wheel lands in the sidebar region (right of the main
      // column) and the sidebar is visible, scroll sidebar content
      // directly — no keyboard focus required. The row bound keeps the
      // wheel inside the sidebar's vertical band (the history viewport
      // rows); wheel over the bottom region keeps its existing no-op
      // behavior instead of scrolling a panel that isn't there.
      if (
        historyWidth < (stdout?.columns ?? 80) &&
        key.mouse.x > historyWidth &&
        key.mouse.y <= state.viewportRows
      ) {
        dispatch({
          type: 'sidebarScroll',
          delta: key.mouse.wheel > 0 ? -1 : 1,
          viewportHeight: termRows - 2,
          sidebarTwinRowCount,
          effectiveSwarmOnSidebar,
        });
        return true;
      }
      // ── History wheel scroll ──
      if (
        isHistoryScrollTarget(
          { termRows, termCols: historyWidth, viewportRows: state.viewportRows },
          key.mouse.x,
          key.mouse.y,
        )
      ) {
        if (key.mouse.shift)
          historyScrollRef.current?.scrollPage(key.mouse.wheel > 0 ? 'up' : 'down');
        else historyScrollRef.current?.scrollBy(key.mouse.wheel > 0 ? 1 : -1);
        onHistoryScrollActivity?.();
        // Scrolling always cancels any pending drag-select: the user is
        // moving through history, not committing a text selection. Without
        // this clear, a Right-Click after a wheel-flushed drag would copy a
        // stale range the user has already forgotten about.
        historyScrollRef.current?.clearSelection();
        return true;
      }
    }
    // ── Sidebar scrollbar press/drag ──
    // The one-column rail at the sidebar's right edge (last terminal
    // column). Press jumps the thumb to that row; held-drag motion
    // (?1002h reports move + left button) scrubs. Same clamp inputs as
    // the wheel branch above so the mapping matches the reducer's
    // reachable range, and the same viewport the thumb renders with
    // (termRows − 1 — RightSidebar's innerHeight).
    if (
      (key.mouse?.kind === 'press' || key.mouse?.kind === 'move') &&
      key.mouse.button === 'left' &&
      // Sidebar-visible guard: when the rail is hidden the history
      // scrollbar owns the last column — this branch must not claim its
      // presses (the content-based maxScroll estimate is positive even
      // when nothing sidebar-side is rendered).
      historyWidth < (stdout?.columns ?? 80) &&
      key.mouse.x >= (stdout?.columns ?? 80) &&
      key.mouse.y <= state.viewportRows
    ) {
      const railMaxScroll = estimateSidebarMaxScroll(
        state,
        Math.max(1, termRows - 2 - sidebarTwinRowCount),
        effectiveSwarmOnSidebar,
      );
      if (railMaxScroll > 0) {
        const target = sidebarOffsetForCell(
          key.mouse.y - 1,
          Math.max(1, termRows - 1),
          railMaxScroll,
        );
        // Skip no-op jumps: move events fire per cell during a drag, and
        // re-dispatching the same offset would re-render the whole app.
        if (target !== state.sidebarScrollOffset) {
          dispatch({
            type: 'sidebarScrollSet',
            offset: target,
            viewportHeight: termRows - 2,
            sidebarTwinRowCount,
            effectiveSwarmOnSidebar,
          });
        }
        return true;
      }
    }
    // Scrollbar click / drag. Button-drag tracking (mode 1002) reports
    // presses and held-button motion in every mode, so a left press on the
    // right-edge track jumps to that absolute position and dragging the
    // track scrubs. The track lives in the top `viewportRows` band, so the
    // bottom region is never affected.
    if (
      (key.mouse?.kind === 'press' || key.mouse?.kind === 'move') &&
      key.mouse.button === 'left'
    ) {
      const region = hitRegion(
        { termRows, termCols: historyWidth, viewportRows: state.viewportRows },
        key.mouse.x,
        key.mouse.y,
      );
      const copyRow =
        region?.kind === 'history' ? region.row : region?.kind === 'scrollbar' ? region.cell : null;
      const pressedRailRow = copyRow !== null && key.mouse.kind === 'press' ? copyRow : null;
      if (
        pressedRailRow !== null &&
        historyScrollRef.current?.hasInspectTargetAt?.(pressedRailRow, key.mouse.x - 1)
      ) {
        historyScrollRef.current.clearSelection();
        const payload = historyScrollRef.current.inspectAtViewportCell?.(
          pressedRailRow,
          key.mouse.x - 1,
        );
        if (payload) {
          dispatch({
            type: 'inspectOverlayOpen',
            entryId: payload.entryId,
            ...(payload.entryIds ? { entryIds: payload.entryIds } : {}),
          });
        }
        return true;
      }
      if (
        pressedRailRow !== null &&
        historyScrollRef.current?.hasCopyTargetAt(pressedRailRow, key.mouse.x - 1)
      ) {
        historyScrollRef.current?.clearSelection();
        void historyScrollRef.current
          .copyAtViewportCell(pressedRailRow, key.mouse.x - 1)
          .then((entryId) => {
            // Non-null id means the clipboard write succeeded — surface the
            // transient "Copied" confirmation and flash that card's icon. A
            // null result (missed target or write failure) is silent.
            if (entryId !== null) onHistoryCopy?.(entryId);
          })
          .catch(() => null);
        return true;
      }
      if (
        pressedRailRow !== null &&
        historyScrollRef.current?.activateToolViewControlAt(pressedRailRow, key.mouse.x - 1)
      ) {
        historyScrollRef.current.clearSelection();
        return true;
      }
      // Drag-to-select: the press must land inside the history band on a
      // non-gutter cell; a motion event with the button still held extends
      // the selection. Button-drag tracking (1002) delivers both in every
      // mode, so no mouseMode gate. Cells right of the card band belong to
      // the rail handlers below.
      if (region?.kind === 'history' && key.mouse.x <= historyWidth - SCROLLBAR_HIT_WIDTH) {
        if (key.mouse.kind === 'press') {
          historyScrollRef.current?.beginSelection(region.row, key.mouse.x - 1);
          return true;
        }
        if (key.mouse.kind === 'move') {
          historyScrollRef.current?.extendSelection(region.row, key.mouse.x - 1);
          return true;
        }
      }
      if (region?.kind === 'scrollbar') {
        // Scrollbar drag also cancels any pending selection: the user is
        // scrubbing chat, not selecting text.
        historyScrollRef.current?.clearSelection();
        historyScrollRef.current?.scrollToTrackCell(region.cell);
        onHistoryScrollActivity?.();
        return true;
      }
    }
    // Left-release after a drag-select: end AND commit in one gesture —
    // press, drag, release copies the selected text. A degenerate press
    // without motion (anchor === head) makes commitSelection a silent
    // no-op, so plain clicks never copy. Routed before the hit-region
    // branches because a release is meaningful only when a selection was
    // started on the matching press; anything else falls through
    // unchanged. The SGR decoder keeps the last-pressed button identity
    // on release, so `button === 'left'` is the correct gate here for a
    // primary-button drag-select.
    if (key.mouse?.kind === 'release' && key.mouse.button === 'left') {
      // Only a release that ends an actual begun selection commits — a
      // stray release (click on the rail, status bar, or anywhere a press
      // never routed into beginSelection) must not spawn the async copy.
      if (historyScrollRef.current?.hasSelection()) {
        ctx.detach(
          historyScrollRef.current?.commitSelection().then((copied) => {
            if (copied) onHistoryCopy?.(SELECTION_COPY_ID);
          }),
          'Copy',
        );
      }
    }
    // Clickable status-bar chips. The bar is bottom-anchored above the panels
    // in belowStatusBarRef; measure both to resolve each content line's
    // absolute row, then resolve the click column against the chip click map
    // StatusBar publishes on every render (spans derived from the SAME
    // segment nodes PowerlineRail draws — see StatusBarClickMap). A press
    // only — drags never open a picker. Spans are 0-based from the bar's
    // left edge (including its one-cell inset), so screen col = start + 1.
    if (
      mouseMode &&
      key.mouse?.kind === 'press' &&
      key.mouse.button === 'left' &&
      statusBarWrapRef.current
    ) {
      const sbHeight = measureElement(statusBarWrapRef.current).height;
      const belowHeight = belowStatusBarRef.current
        ? measureElement(belowStatusBarRef.current).height
        : 0;
      const mx = key.mouse.x;
      const my = key.mouse.y;
      const rowFor = (line: number) =>
        statusBarLineRow({
          termRows,
          statusBarHeight: sbHeight,
          belowHeight,
          headerRows: 0,
          line,
        });
      const clickMap = statusBarClickMapRef.current;
      const lineEntry = clickMap?.lines.find((entry) => rowFor(entry.line) === my);
      const span = lineEntry?.spans.find(
        (candidate) => mx >= candidate.start + 1 && mx <= candidate.start + candidate.len,
      );
      if (span) {
        switch (span.id) {
          case 'model': {
            await openModelPicker();
            return true;
          }
          case 'autonomy': {
            dispatch({ type: 'autonomyPickerOpen', options: AUTONOMY_OPTIONS });
            return true;
          }
          case 'todos': {
            dispatch({ type: 'toggleTodosMonitor' });
            return true;
          }
          case 'plan':
          case 'tasks':
          case 'fleet': {
            openStatuslinePicker(STATUSLINE_ITEMS.indexOf(span.id));
            return true;
          }
          default:
            // Non-clickable chip — fall through to the handlers below.
            break;
        }
      }
    }
    if (key.pageUp) {
      historyScrollRef.current?.scrollPage('up');
      onHistoryScrollActivity?.();
      return true;
    }
    if (key.pageDown) {
      historyScrollRef.current?.scrollPage('down');
      onHistoryScrollActivity?.();
      return true;
    }
    // Terminal-safe paging fallback for compact keyboards (notably MacBooks).
    // Preserve the composer's Ctrl+U/D editing semantics whenever it contains
    // text; on an empty draft these chords page through chat history.
    if (key.ctrl && draftRef.current.buffer === '' && (input === 'u' || input === 'd')) {
      historyScrollRef.current?.scrollPage(input === 'u' ? 'up' : 'down');
      onHistoryScrollActivity?.();
      return true;
    }
  }
  return false;
}
