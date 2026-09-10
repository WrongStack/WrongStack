import type { Director } from '@wrongstack/core/coordination';
import { toErrorMessage } from '@wrongstack/core/utils';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { Action } from './app-action-type.js';
import type { AppProps } from './app-props.js';
import type { State } from './app-state.js';
import { AUTONOMY_OPTIONS } from './components/autonomy-picker.js';
import { DEFAULT_INPUT_PROMPT, type KeyEvent } from './components/input.js';
import type { HistoryScrollController } from './components/scrollable-history.js';
import { SELECTION_COPY_ID } from './components/scrollable-history.js';
import { sidebarOffsetForCell } from './components/sidebar-scrollbar.js';
import type { StatusBarClickMap } from './components/status-bar-types.js';
import { STATUSLINE_ITEMS, type StatuslineItem } from './components/statusline-picker.js';
import {
  hitRegion,
  isHistoryScrollTarget,
  SCROLLBAR_HIT_WIDTH,
  statusBarLineRow,
} from './hit-test.js';
import { type DOMElement, measureElement } from './ink.js';
import { routeInputKey } from './input-key-router.js';
import type { KeyRouteContext } from './key-handler-context.js';
import { routeBusyInterrupt, routeCtrlCEscalation } from './key-routes/key-route-busy.js';
import {
  routeChordPanels,
  routeDoubleEsc,
  routeEscClosePanels,
  routeFKeyPanels,
  routeModalOverlay,
  routePanelEscapeRouter,
  routeSddBoard,
  routeSettingsOverlay,
} from './key-routes/key-route-overlay.js';
import { routePastePipeline } from './key-routes/key-route-paste.js';
import { overlayPointerKey } from './overlay-key-router.js';
import type { PasteAccumState } from './paste-accumulator.js';
import { estimateSidebarMaxScroll } from './reducers/workspace-panels.js';

const INPUT_PROMPT = DEFAULT_INPUT_PROMPT;

/** Keyboard activity means the user has taken control of an armed automatic turn. */
export function stopNextStepsAutoSubmitOnKey(cancel: () => void): void {
  cancel();
}

export interface AppKeyHandlerOptions {
  state: State;
  dispatch: Dispatch<Action>;
  historyScrollRef: MutableRefObject<HistoryScrollController | null>;
  /** Resets the live-tail timeout after a user-driven history navigation. */
  onHistoryScrollActivity?: (() => void) | undefined;
  runInterruptLadder: () => void;
  enhanceCancelledRef: MutableRefObject<boolean>;
  enhanceAbortRef: MutableRefObject<AbortController | null>;
  inputGateRef: MutableRefObject<boolean>;
  lastEscAtRef: MutableRefObject<number>;
  pasteAccumRef: MutableRefObject<PasteAccumState>;
  pasteFlushTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  commitPaste: (full: string) => Promise<void>;
  tryPickerKey: (input: string, key: KeyEvent, isEnter: boolean) => boolean;
  dismissedEscAtRef: MutableRefObject<number>;
  streamingTextRef: MutableRefObject<string>;
  confirmExitRef: MutableRefObject<boolean>;
  activeCtrlRef: MutableRefObject<AbortController | null>;
  clearPendingConfirms: () => void;
  liveDirector: () => Director | null;
  openProjectPicker: () => Promise<void>;
  loadLiveSessions: () => Promise<void>;
  openStatuslinePicker: (field?: number) => void;
  statuslineHiddenItems: StatuslineItem[];
  getSddRun: AppProps['getSddRun'];
  onSddLifecycle: AppProps['onSddLifecycle'];
  getSettings: AppProps['getSettings'];
  saveSettings: AppProps['saveSettings'];
  lastEnterAtRef: MutableRefObject<number>;
  draftRef: MutableRefObject<{ buffer: string; cursor: number }>;
  setDraft: (buffer: string, cursor: number) => void;
  /** Submits the composer. `overrideRaw` bypasses the buffer (bash mode
   *  forwards its draft through the `!` shell path this way). */
  submit: (overrideRaw?: string) => void;
  mouseMode: boolean;
  termRows: number;
  terminalColumns: number;
  terminalRows: number;
  /** Width of the main column (terminal width minus sidebar). When > 0,
   *  scrollbar hit-tests use this instead of terminalColumns so the scrollbar
   *  track is correctly positioned to the left of the sidebar. */
  mainColumnWidth: number;
  /**
   * Whether a full-width overlay owns the screen.
   *
   * Passed in rather than derived. The old proxy —
   * `mainColumnWidth >= stdout.columns` — is true whenever the sidebar is
   * ZERO wide, and `computeSidebarWidth` returns 0 for any terminal under
   * `SIDEBAR_MIN_TERMINAL` (64 columns). So on a narrow terminal the flag was
   * permanently true with nothing open, and the whole `if (!overlayOpen)`
   * block below — wheel scrolling, scrollbar drag, drag-select, copy icons,
   * every status-bar chip click, PageUp/PageDown — silently stopped working,
   * along with Shift+Tab, `?` help, and (via `routeInputKey`) up/down input
   * history. `app.tsx` already hands the real value to `useMouseTracking`.
   */
  overlayOpen: boolean;
  /**
   * Effective swarm-on-sidebar read: `panelPositions.fleet === 'sidebar'`
   * OR the legacy `showAgentSwarmPanel === 'sidebar'` flag from
   * `liveSettings`. The renderer at `app-view.tsx:897-899` reads
   * ONLY the legacy `showAgentSwarmPanel` field (not the panel-
   * position map) to decide whether to show the mission card; the
   * scroll-clamp reservation must match that source or a config-only
   * legacy 'sidebar' swarm mode (no recent picker open) will render
   * the mission card but the clamp will under-reserve, hiding the
   * bottom mission rows behind `RightSidebar`'s `overflowY="hidden"`
   * viewport. The OR with `panelPositions.fleet` is directionally
   * safe (over-reservation is harmless) and aligns with the field
   * that gates whether the swarm twin is mounted. See
   * {@link SidebarLayoutState.effectiveSwarmOnSidebar}. Threaded into
   * `sidebarScroll` dispatches so the reducer's mission-queue
   * reservation matches the actual render.
   */
  effectiveSwarmOnSidebar: boolean;
  /**
   * Approximate row count for routed sidebar twin panels mounted above
   * `SidebarContent`. Subtracted from `viewportHeight` by the reducer's
   * scroll clamp so the user can't scroll past the end into blank space.
   * See {@link SidebarLayoutState.sidebarTwinRowCount}.
   */
  sidebarTwinRowCount: number;
  statusBarWrapRef: MutableRefObject<DOMElement | null>;
  belowStatusBarRef: MutableRefObject<DOMElement | null>;
  /** Chip click map published by StatusBar on every render. */
  statusBarClickMapRef: MutableRefObject<StatusBarClickMap | null>;
  openModelPicker: () => Promise<void>;
  nextStepsAutoSubmitTimerRef: MutableRefObject<ReturnType<typeof setInterval> | undefined>;
  nextStepsAutoSubmitSuggestionRef: MutableRefObject<string | null>;
  nextStepsAutoSubmitLabel: string | null;
  setNextStepsAutoSubmitCountdown: Dispatch<SetStateAction<number | null>>;
  setNextStepsAutoSubmitLabel: Dispatch<SetStateAction<string | null>>;
  cancelNextStepsCountdown: () => void;
  pasteClipboardText: () => Promise<void>;
  pasteClipboardImage: () => Promise<void>;
  slashRegistry: AppProps['slashRegistry'];
  agent: AppProps['agent'];
  /**
   * Called with the copied entry's id after a chat card's copy icon is clicked
   * and its content was successfully written to the clipboard. Lets the host
   * surface a transient "Copied" confirmation and flash that card's icon. Not
   * called when the click missed or the write failed.
   */
  onHistoryCopy?: ((entryId: number) => void) | undefined;
}

/** Creates the terminal key host around focused overlay/input routers. */
export function createAppKeyHandler(
  options: AppKeyHandlerOptions,
): (input: string, key: KeyEvent) => Promise<void> {
  const {
    state,
    dispatch,
    historyScrollRef,
    onHistoryScrollActivity,
    inputGateRef,
    pasteAccumRef,
    commitPaste,
    tryPickerKey,
    openStatuslinePicker,
    lastEnterAtRef,
    draftRef,
    setDraft,
    submit,
    mouseMode,
    termRows,
    terminalColumns,
    terminalRows,
    mainColumnWidth,
    overlayOpen,
    effectiveSwarmOnSidebar,
    sidebarTwinRowCount,
    statusBarWrapRef,
    belowStatusBarRef,
    statusBarClickMapRef,
    openModelPicker,
    nextStepsAutoSubmitTimerRef,
    nextStepsAutoSubmitSuggestionRef,
    nextStepsAutoSubmitLabel,
    setNextStepsAutoSubmitCountdown,
    setNextStepsAutoSubmitLabel,
    cancelNextStepsCountdown,
    pasteClipboardText,
    pasteClipboardImage,
    slashRegistry,
    agent,
    onHistoryCopy,
  } = options;
  const stdout = { columns: terminalColumns, rows: terminalRows };
  /** Effective width of the history area (terminal minus sidebar).
   *  Used for scrollbar/hit-test geometry so clicks land on the correct track. */
  const historyWidth = mainColumnWidth > 0 ? mainColumnWidth : (stdout?.columns ?? 80);

  /**
   * Run a detached promise from a key handler without risking the process.
   *
   * `void fn()` is the default idiom in this file, and most call sites were
   * only safe because the callee happened to try/catch internally — incidental,
   * not enforced. The ones that did not (paste commit on the 500 ms timer
   * stack, the SDD lifecycle ops, the clipboard write, `/goal` dispatch) each
   * turned a routine failure into an unhandled rejection, which Node 22's
   * default `--unhandled-rejections=throw` escalates to process death. That
   * violates the project's "no error may kill the process" rule, and a key
   * handler is the last place a user can afford to lose the session.
   *
   * The failure surfaces as an error entry, the same way `submit-controller`
   * reports a failed slash dispatch.
   */
  const detach = (work: Promise<unknown> | undefined, what: string): void => {
    void Promise.resolve(work).catch((err: unknown) => {
      dispatch({
        type: 'addEntry',
        entry: { kind: 'error', text: `${what} failed: ${toErrorMessage(err)}` },
      });
    });
  };

  // Shared view for the ordered route modules (decomposition Phase 3).
  const ctx: KeyRouteContext = { ...options, stdout, historyWidth, detach };

  const handleKey = async (input: string, key: KeyEvent) => {
    // Any key is an explicit user takeover. Stop both the final-ten-second
    // sweep and its armed submit before routing the key, including keys owned
    // by overlays/navigation and Ctrl+C. The cancel callback is a no-op when
    // no next-step countdown exists.
    stopNextStepsAutoSubmitOnKey(cancelNextStepsCountdown);

    // ── Ctrl+C: THE unconditional escape hatch ────────────────────────
    // Moved verbatim to routeCtrlCEscalation (key-routes/key-route-busy.ts,
    // decomposition Phase 3). Raw-mode terminals deliver Ctrl+C as KEY DATA —
    // no SIGINT is ever generated — so this runs BEFORE every modal/status
    // guard: Ctrl+C has to work precisely when everything else is wedged.
    if (routeCtrlCEscalation(ctx, input, key)) return;
    if (routeModalOverlay(ctx, input, key)) return;

    // ── Monitor overlays are NON-modal ───────────────────────────────
    // F2 fleet, F3 agents, F4 worktree, F6 todos, F7 queue, and the
    // goalRun monitor render in the lower region of the layout, but the
    // chat input above them stays LIVE — typing, backspace, paste, cursor
    // movement, and Enter (submit) all flow through to the input buffer.
    // Only the F-key toggles below and Esc are reserved for the panel:
    //   • F2/F3/F4/F6/F7 toggle their respective overlay
    //   • Esc closes whichever overlay is open
    // (Overlays with their own dedicated UI — `confirmQueue`, `enhance`,
    // `modelPicker`, `autonomyPicker`, `settingsPicker`, `rewindOverlay`,
    // `helpOpen` — are still modal and keep their own guards above.)
    // Ctrl+C still aborts via the SIGINT handler, which bypasses handleKey.

    // Re-entrancy guard: block stale-second events from \r\n terminals.
    if (inputGateRef.current) return;

    // ── Double-Esc clears input buffer ────────────────────────────────
    // Moved verbatim to routeDoubleEsc (key-routes/key-route-overlay.ts,
    // decomposition Phase 3): Esc twice within ESC_DOUBLE_PRESS_MS while the
    // buffer is non-empty clears it — bash's Ctrl+C double-press, adapted
    // for Esc.
    if (routeDoubleEsc(ctx, key)) return;

    // ── Bracketed-paste accumulation ──────────────────────────────────
    // Moved verbatim to routePastePipeline (key-routes/key-route-paste.ts,
    // decomposition Phase 3). The begin marker (\x1b[200~) opens accumulation;
    // fragments accumulate until the end marker (\x1b[201~), then the whole
    // payload finalizes at once — before Enter handling, so a "\n" fragment
    // inside a paste never submits mid-paste.
    if (await routePastePipeline(ctx, input)) return;

    // Some terminals emit \r\n for Enter as two separate stdin events.
    // \r arrives with key.return=true (handled below); \n may arrive as
    // a stray character with key.return=false. Normalize both to Enter
    // and prevent them from polluting the buffer as literal text.
    // Mouse buttons inside a selectable overlay map to keyboard semantics:
    // left = confirm (Enter), right = cancel/back (Esc). Tracking is
    // overlay-scoped (see the mouse effect near stateRef), so this is gated on
    // an overlay being open and never disturbs normal chat clicks. Combined
    // with wheel-to-move in each picker block, this gives full mouse menu
    // control without any pixel hit-testing.
    const { isEnter, cancelAction } = overlayPointerKey(state, input, key, {
      termRows,
      viewportRows: state.viewportRows,
    });

    // Right-click cancels the open overlay (mirrors each picker's Esc path).
    if (cancelAction) {
      dispatch(cancelAction);
      return;
    }

    // ── Paste-active guard: swallow Enter mid-paste ──────────────────
    // Ink can split `\r\n` (which arrives inside a paste payload) into
    // BOTH a raw `\r` character AND a decoded Enter event (key.return,
    // input=''). The former is correctly accumulated by feedPaste above,
    // but the decoded Enter has input='' → it bypasses feedPaste and
    // would submit the buffer mid-paste. Catch it here.
    if (pasteAccumRef.current !== null && isEnter) return;

    // IMPORTANT: do NOT bail on `!input` here. Special keys (arrows,
    // Enter, Escape, Tab, Backspace) arrive with an empty `input`
    // string, and the slash/file pickers + cursor movement below all
    // depend on receiving those events. The late guard before text
    // insertion handles the empty-input case correctly.

    // All picker dispatch is delegated to the usePickerKeys hook.
    // The hook handles Esc (close), ↑/↓ (navigate), wheel (scroll),
    // Enter (confirm), and picker-specific keys (search, filter, Tab).
    // If no picker is open the hook returns false immediately.
    if (tryPickerKey(input, key, isEnter)) return;

    if (routeEscClosePanels(ctx, key)) return;

    if (routeBusyInterrupt(ctx, key)) return;

    // Monitor-overlay chords (Ctrl+B → SDD board, Ctrl+Y → kanban) — moved
    // verbatim to routeChordPanels (key-routes/key-route-overlay.ts, Phase 3).
    if (routeChordPanels(ctx, input, key)) return;
    // F-key / Ctrl-alias dispatch — moved verbatim to routeFKeyPanels
    // (key-routes/key-route-overlay.ts, Phase 3).
    if (routeFKeyPanels(ctx, input, key)) return;
    // SDD board drill-down (←/→ phases, c/z/x run lifecycle) — moved
    // verbatim to routeSddBoard (key-routes/key-route-overlay.ts, Phase 3).
    if (routeSddBoard(ctx, input, key)) return;
    if (routeSettingsOverlay(ctx, input, key, isEnter)) return;
    if (routePanelEscapeRouter(ctx, key)) return;

    // overlayOpen tracks whether the renderer hides the right sidebar for a
    // bottom-routed panel/overlay. Sidebar-routed panels must not suppress
    // sidebar focus or history hit-testing, so this shares AppView's
    // routing-aware layout decision via mainColumnWidth.

    // ── Sidebar focus + scroll ───────────────────────────────────────
    // Shift+Tab on an empty draft toggles keyboard focus between the
    // chat input and the right sidebar. When sidebar-focused, ↑/↓ scroll
    // the sidebar content. Esc or typing unfocuses automatically.
    if (key.tab && key.shift && draftRef.current.buffer === '' && !overlayOpen) {
      dispatch({ type: 'toggleSidebarFocus' });
      return;
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
        return;
      }
      if (key.downArrow) {
        dispatch({
          type: 'sidebarScroll',
          delta: 1,
          viewportHeight: sidebarViewportHeight,
          sidebarTwinRowCount,
          effectiveSwarmOnSidebar,
        });
        return;
      }
      if (key.escape) {
        dispatch({ type: 'toggleSidebarFocus' });
        return;
      }
      if (input) {
        // Non-empty input unfocuses the sidebar so the keystroke lands
        // in the chat input buffer (falls through below).
        dispatch({ type: 'toggleSidebarFocus' });
      }
    }

    // `?` on an empty prompt opens the keys-&-commands help overlay (lazygit
    // style). With any draft text it types normally, so a literal `?` mid-
    // message is never swallowed. Guarded via overlayOpen — when any panel
    // or picker is active the key is ignored so overlay-internal `?` usage
    // (none currently) is never stolen.
    if (
      input === '?' &&
      !key.ctrl &&
      !key.meta &&
      draftRef.current.buffer === '' &&
      !overlayOpen &&
      !state.bashMode
    ) {
      dispatch({ type: 'toggleHelp' });
      return;
    }
    // `!` on an empty prompt flips the composer into bash mode: a dedicated
    // shell-command line whose Enter runs the draft via the `!` path (`/dev`).
    // With any draft text it types normally, so a literal `!` mid-message is
    // never swallowed — and inside bash mode itself `!` is just a character.
    // Mirrors the `?` help-shortcut gate above.
    if (
      input === '!' &&
      !key.ctrl &&
      !key.meta &&
      draftRef.current.buffer === '' &&
      !overlayOpen &&
      !state.bashMode
    ) {
      dispatch({ type: 'bashModeEnter' });
      return;
    }
    // No panel below uses Enter for itself (ProcessList has its own
    // dedicated guard above; every other panel either has no useInput
    // or only captures ↑↓/Esc/letter shortcuts). Enter always reaches
    // the submit path so the live input stays usable behind overlays.
    if (isEnter) {
      // Shift+Enter inserts a literal newline instead of submitting.
      if (key.shift) {
        const { buffer, cursor } = draftRef.current;
        const next = buffer.slice(0, cursor) + '\n' + buffer.slice(cursor);
        setDraft(next, cursor + 1);
        lastEnterAtRef.current = Date.now(); // prevent duplicate from \r
        return;
      }

      // ── Bash mode: Enter runs the draft as a shell command ────────────
      // Forwarded through the SAME `!` entry point a typed `!cmd` uses —
      // warning dialog included — so `/dev` remains the single shell
      // execution path. An empty line just leaves bash mode. A leading `!`
      // in the draft is stripped so `!!cmd` never reaches /dev doubled.
      if (state.bashMode) {
        const body = draftRef.current.buffer.trim();
        const command = body.startsWith('!') ? body.slice(1).trim() : body;
        dispatch({ type: 'bashModeExit' });
        lastEnterAtRef.current = Date.now(); // prevent duplicate from \r
        if (command) detach(Promise.resolve(submit(`!${command}`)), 'Send');
        return;
      }

      // Re-entrancy protection for terminals that emit `\r\n` as two
      // separate stdin events: ignore Enter pressed within 50ms of the
      // last one. The 50ms window catches the double-event reliably
      // (the second `\n` arrives within microseconds of the `\r`) while
      // staying well below human double-tap speed.
      //
      // We intentionally do NOT await submit() here — it kicks off
      // agent.run() which can stay pending for minutes when a delegate
      // call is in flight. Awaiting would block this handler frame for
      // the full duration, which means every subsequent keystroke would
      // miss its dispatch (including the slash key — the user reported
      // the input feeling dead during delegated work). submit() handles
      // its own re-entrancy via state.status: when the agent is busy,
      // the message is queued instead of re-running concurrently.
      const now = Date.now();
      if (now - lastEnterAtRef.current < 50) return;
      lastEnterAtRef.current = now;
      // `submit` is typed `() => void` at the wiring site, so TS silently
      // discarded the promise it actually returns — and its non-slash branch
      // has no top-level try/catch (an `@file` chip whose file was deleted
      // between attach and send rejects while resolving attachments).
      // `useStableKeyHandler` only covers the promise `handleKey` itself
      // returns; `void submit()` detached from that chain.
      detach(Promise.resolve(submit()), 'Send');
      return;
    }

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
          detach(
            historyScrollRef.current?.commitSelection().then((copied) => {
              if (copied) onHistoryCopy?.(SELECTION_COPY_ID);
            }),
            'Copy',
          );
          return;
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
          return;
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
          return;
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
          return;
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
          region?.kind === 'history'
            ? region.row
            : region?.kind === 'scrollbar'
              ? region.cell
              : null;
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
          return;
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
          return;
        }
        if (
          pressedRailRow !== null &&
          historyScrollRef.current?.activateToolViewControlAt(pressedRailRow, key.mouse.x - 1)
        ) {
          historyScrollRef.current.clearSelection();
          return;
        }
        // Drag-to-select: the press must land inside the history band on a
        // non-gutter cell; a motion event with the button still held extends
        // the selection. Button-drag tracking (1002) delivers both in every
        // mode, so no mouseMode gate. Cells right of the card band belong to
        // the rail handlers below.
        if (region?.kind === 'history' && key.mouse.x <= historyWidth - SCROLLBAR_HIT_WIDTH) {
          if (key.mouse.kind === 'press') {
            historyScrollRef.current?.beginSelection(region.row, key.mouse.x - 1);
            return;
          }
          if (key.mouse.kind === 'move') {
            historyScrollRef.current?.extendSelection(region.row, key.mouse.x - 1);
            return;
          }
        }
        if (region?.kind === 'scrollbar') {
          // Scrollbar drag also cancels any pending selection: the user is
          // scrubbing chat, not selecting text.
          historyScrollRef.current?.clearSelection();
          historyScrollRef.current?.scrollToTrackCell(region.cell);
          onHistoryScrollActivity?.();
          return;
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
          detach(
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
              return;
            }
            case 'autonomy': {
              dispatch({ type: 'autonomyPickerOpen', options: AUTONOMY_OPTIONS });
              return;
            }
            case 'todos': {
              dispatch({ type: 'toggleTodosMonitor' });
              return;
            }
            case 'plan':
            case 'tasks':
            case 'fleet': {
              openStatuslinePicker(STATUSLINE_ITEMS.indexOf(span.id));
              return;
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
        return;
      }
      if (key.pageDown) {
        historyScrollRef.current?.scrollPage('down');
        onHistoryScrollActivity?.();
        return;
      }
      // Terminal-safe paging fallback for compact keyboards (notably MacBooks).
      // Preserve the composer's Ctrl+U/D editing semantics whenever it contains
      // text; on an empty draft these chords page through chat history.
      if (key.ctrl && draftRef.current.buffer === '' && (input === 'u' || input === 'd')) {
        historyScrollRef.current?.scrollPage(input === 'u' ? 'up' : 'down');
        onHistoryScrollActivity?.();
        return;
      }
    }

    if (
      await routeInputKey(
        {
          state,
          draft: draftRef.current,
          overlayOpen,
          prompt: INPUT_PROMPT,
          terminalColumns: stdout?.columns ?? 80,
          terminalRows: stdout?.rows ?? 24,
          nextSteps: {
            timer: nextStepsAutoSubmitTimerRef,
            suggestion: nextStepsAutoSubmitSuggestionRef,
            label: nextStepsAutoSubmitLabel,
            setCountdown: setNextStepsAutoSubmitCountdown,
            setLabel: setNextStepsAutoSubmitLabel,
            cancel: cancelNextStepsCountdown,
          },
          dispatch,
          setDraft,
          pasteClipboardText,
          pasteClipboardImage,
          commitPaste,
        },
        input,
        key,
      )
    ) {
      return;
    }
    // Ctrl+P → toggle PhaseMonitor overlay when Goal is active.
    if (key.ctrl && input === 'p') {
      if (state.goalRun) dispatch({ type: 'goalRunMonitorToggle' });
      else {
        // No active Goal — treat as a command alias for /goal status
        // `submit-controller` wraps the identical dispatch in try/catch and
        // reports an error entry; this Ctrl+P alias did not.
        detach(
          slashRegistry.dispatch('/goal', agent.ctx).then((res) => {
            if (res?.message)
              dispatch({ type: 'addEntry', entry: { kind: 'info', text: res.message } });
          }),
          '/goal',
        );
      }
      return;
    }
  };

  return handleKey;
}
