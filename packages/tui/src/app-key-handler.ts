import type { Director } from '@wrongstack/core/coordination';
import { toErrorMessage } from '@wrongstack/core/utils';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { Action } from './app-action-type.js';
import type { AppProps } from './app-props.js';
import type { State } from './app-state.js';
import { DEFAULT_INPUT_PROMPT, type KeyEvent } from './components/input.js';
import type { HistoryScrollController } from './components/scrollable-history.js';
import type { StatusBarClickMap } from './components/status-bar-types.js';
import type { StatuslineItem } from './components/statusline-picker.js';
import type { DOMElement } from './ink.js';
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
import { routePointerEvents, routeSidebarFocusScroll } from './key-routes/key-route-pointer.js';
import { overlayPointerKey } from './overlay-key-router.js';
import type { PasteAccumState } from './paste-accumulator.js';

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
    inputGateRef,
    pasteAccumRef,
    commitPaste,
    tryPickerKey,
    lastEnterAtRef,
    draftRef,
    setDraft,
    submit,
    termRows,
    terminalColumns,
    terminalRows,
    mainColumnWidth,
    overlayOpen,
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
    if (routeSidebarFocusScroll(ctx, input, key)) return;

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

    // ── Pointer events (mouse/wheel/paging) ───────────────────────────
    if (await routePointerEvents(ctx, input, key)) return;

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
