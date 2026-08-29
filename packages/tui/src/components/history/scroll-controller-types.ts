/**
 * Public types for the scrollable history viewport.
 *
 * Extracted from scrollable-history.tsx so the imperative controller
 * contract, props, and shared geometry types can be imported without
 * pulling in the full component.
 */
import type { MutableRefObject } from 'react';
import type { HistoryProps } from './index.js';

/**
 * Imperative scroll surface owned by the ScrollableHistory component. The app
 * key/mouse handlers call these instead of dispatching reducer actions: all
 * scroll math needs the live height cache, which lives here, and routing it
 * through app state previously forced totals and offsets to travel through
 * separate commits — the root cause of an entire family of jump bugs.
 */
export interface HistoryScrollController {
  /** Scroll by `deltaUp` rows: positive = older content, negative = newer. */
  scrollBy(deltaUp: number): void;
  /** Scroll by one viewport page. */
  scrollPage(dir: 'up' | 'down'): void;
  /** Jump to the oldest retained entry. */
  scrollToTop(): void;
  /** Re-pin to the newest output. */
  scrollToBottom(): void;
  /** Jump to a 0-based cell clicked/dragged on the scrollbar track. */
  scrollToTrackCell(cell: number): void;
  /** True while the viewport is scrolled away from the newest output. */
  isScrolled(): boolean;
  /**
   * True when the viewport cell lands on a copyable card's copy icon. Lets the
   * mouse handler decide synchronously whether to consume the click before
   * firing the async copy. See {@link copyAtViewportCell} for the `row`/`col`
   * coordinate contract.
   */
  hasCopyTargetAt(row: number, col: number): boolean;
  /**
   * Handle a left-click inside the history viewport. `row` is 0-based from the
   * viewport top; `col` is 0-based from the LEFT EDGE OF THE HISTORY BAND, not
   * the raw terminal column. In the interactive mount the band renders flush at
   * terminal column 0 (the scrollbar occupies the rightmost columns), so the
   * caller passes the terminal column directly; a band that is inset from the
   * left must subtract its left offset first. When the cell lands on a copyable
   * card's copy icon, its content is written to the system clipboard and the
   * entry id is returned; otherwise returns null.
   */
  copyAtViewportCell(row: number, col: number): Promise<number | null>;
  /**
   * Begin a drag-to-select gesture at `row`,`col` (history-band viewport cell).
   * The cell must be inside a card's row range and inside the rendered band
   * (`0 <= col < termWidth`); the mouse handler has already excluded the rail.
   * Calls that don't satisfy that contract are silently ignored. Existing
   * scrollbar/copy-icon/wheel paths remain intact because they call their own
   * handlers; this only kicks in when the mouse layer explicitly routes a
   * left-press into the card band.
   *
   * Column contract (v1.1 M3): `col` is a HISTORY-BAND column (0-based from
   * the band's left edge). The controller translates it to card-body-local
   * coordinates before storing: bordered kinds (assistant/thinking/user) have
   * a MESSAGE_PANEL_CHROME_WIDTH (2) left gutter, and gutter columns CLAMP to
   * the card's first visible column — a press on the border/padding selects
   * from the start of the card's visible line, mirroring standard editor
   * margin-click behavior. Gutterless kinds (info, memory-lifecycle, tool
   * groups, …) pass the column through unchanged.
   *
   * Copy contract (block-based): the selection rect only decides WHICH
   * blocks it touches — every touched block is copied in full via
   * copyableTextForEntry (the same payload the copy icon writes), so inline
   * chrome (card gutter, `👤 USER  ` label, `ℹ ` icon) neither leaks into
   * nor offsets the payload. Columns still drive the GESTURE: band bounds
   * (`isOutOfBand`), the highlight band, and the drag-vs-click distinction
   * (a zero-size selection commits nothing).
   */
  beginSelection(row: number, col: number): void;
  /**
   * Extend an active selection to `row`,`col` (history-band viewport cell,
   * translated to body-local exactly as in {@link beginSelection}). If no
   * selection is in progress, the call is a no-op. Columns outside the band
   * or rows below the viewport / above 0 cancel the drag internally — leaving
   * stale viewport-relative coords around after a mid-drag escape would let
   * the next right-click paste from the wrong card, which is the worse
   * failure mode than the selection disappearing.
   */
  extendSelection(row: number, col: number): void;
  /**
   * Mark an active drag as ended (left-release) WITHOUT copying. The primary
   * release path goes straight to {@link commitSelection}; this intermediate
   * state exists for callers that end a drag but defer the copy decision,
   * and it pins {@link extendSelection} against stray post-release motion.
   * If no selection is in progress, the call is a no-op.
   */
  endSelection(): void;
  /**
   * True while a drag-selection has been begun and not yet committed,
   * cleared, or cancelled. Lets the key handler decide synchronously whether
   * a left-release should trigger {@link commitSelection} — a release with
   * no active selection must not spawn a pointless async clipboard path.
   */
  hasSelection(): boolean;
  /** Drop any in-progress or committed selection without copying. */
  clearSelection(): void;
  /**
   * Commit the active selection to the system clipboard. Triggered by the
   * left-button release that ends a drag (the release-commits-copy
   * contract); a right-press in the history band commits any selection that
   * is still pending after an unusual end. Returns true if a non-empty
   * selection was resolved and the write succeeded. Returns false silently
   * when there is no selection, the selection is empty (e.g. the drag never
   * moved), or the write fails — the caller can show a transient notice on
   * the truthy branch and stay silent on the falsy branch.
   */
  commitSelection(): Promise<boolean>;
}

export interface ScrollableHistoryProps extends HistoryProps {
  /** Height of the viewport in rows, computed by App from the bottom region. */
  viewportRows: number;
  /** Receives the imperative scroll controller. The component assigns on
   *  mount and clears on unmount. Optional for isolated renderers. */
  controllerRef?: MutableRefObject<HistoryScrollController | null> | undefined;
  /** Reports scroll-state transitions (scrolled away from / re-pinned to the
   *  newest output) so the host can adjust key hints. */
  onScrollInfo?: ((info: { scrolled: boolean }) => void) | undefined;
  /** Optional cap on the width used for entry wrapping (right panel mode). */
  maxWidth?: number | undefined;
  /** Layout store for persisting entry height data across renders and sessions.
   *  When provided, the ScrollableHistory seeds its height cache from the
   *  store's persisted measurements and marks entries as measured after render,
   *  eliminating estimate-vs-actual scroll jumps on re-render. */
  layoutStore?: import('../../layout-store.js').LayoutStore | undefined;
  /**
   * Entry id of the card whose copy icon was just clicked. That card's icon
   * renders in the success color for the brief window the host keeps this set,
   * giving per-card visual feedback alongside the status-line "Copied" notice.
   * `null` / undefined = no card highlighted.
   */
  copiedEntryId?: number | null | undefined;
  /**
   * Called when the user scrolls near the top of the currently loaded
   * entries. The host should respond by loading older entries from the
   * history archive and dispatching `archiveLoaded` to prepend them.
   */
  onRequestOlderEntries?: (() => void) | undefined;
}
