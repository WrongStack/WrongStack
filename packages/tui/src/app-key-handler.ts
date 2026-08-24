import type { Director } from '@wrongstack/core/coordination';
import { toErrorMessage } from '@wrongstack/core/utils';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { Action } from './app-action-type.js';
import type { AppProps } from './app-props.js';
import type { State } from './app-state.js';
import { effectivePanelPositions } from './app-ui-state.js';
import { AUTONOMY_OPTIONS } from './components/autonomy-picker.js';
import { DEFAULT_INPUT_PROMPT, type KeyEvent } from './components/input.js';
import type { HistoryScrollController } from './components/scrollable-history.js';
import { SELECTION_COPY_ID } from './components/scrollable-history.js';
import type { StatusBarClickMap } from './components/status-bar-types.js';
import { STATUSLINE_ITEMS, type StatuslineItem } from './components/statusline-picker.js';
import { escCloseAction, escSelfOwnedPanelOpen } from './esc-close-panels.js';
import { actionForFKeyPanel, fKeyEntryFor } from './f-key-panels.js';
import {
  hitRegion,
  isHistoryScrollTarget,
  SCROLLBAR_HIT_WIDTH,
  statusBarLineRow,
} from './hit-test.js';
import { type DOMElement, measureElement } from './ink.js';
import { routeInputKey } from './input-key-router.js';
import {
  overlayPointerKey,
  routeBusyInterruptKey,
  routeModalOverlayKey,
  routePanelEscapeKey,
  routeSettingsOverlayKey,
} from './overlay-key-router.js';
import { feedPaste, type PasteAccumState } from './paste-accumulator.js';
import { sddLifecycleEntry } from './sdd-lifecycle-entry.js';

const ESC_DOUBLE_PRESS_MS = 1000;
const INPUT_PROMPT = DEFAULT_INPUT_PROMPT;

interface AppKeyHandlerOptions {
  state: State;
  dispatch: Dispatch<Action>;
  historyScrollRef: MutableRefObject<HistoryScrollController | null>;
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
  submit: () => void;
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
    runInterruptLadder,
    enhanceCancelledRef,
    enhanceAbortRef,
    inputGateRef,
    lastEscAtRef,
    pasteAccumRef,
    pasteFlushTimerRef,
    commitPaste,
    tryPickerKey,
    dismissedEscAtRef,
    streamingTextRef,
    confirmExitRef,
    activeCtrlRef,
    clearPendingConfirms,
    liveDirector,
    openProjectPicker,
    loadLiveSessions,
    openStatuslinePicker,
    statuslineHiddenItems,
    getSddRun,
    onSddLifecycle,
    getSettings,
    saveSettings,
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

  const handleKey = async (input: string, key: KeyEvent) => {
    // ── Ctrl+C: THE unconditional escape hatch ────────────────────────
    // Raw-mode terminals (ConPTY/Windows, and any tty in raw mode) deliver
    // Ctrl+C as KEY DATA — no SIGINT is ever generated — so it must be
    // routed into the escalation ladder from here. This check runs BEFORE
    // every modal/status guard below on purpose: Ctrl+C has to work
    // precisely when everything else is wedged ('aborting' block, pending
    // confirm panel, enhance overlay, …). The ladder itself is state-aware
    // (cancels open pickers on the first press, aborts + kills the fleet,
    // then exits on the second press, hard-exits on the third).
    if (key.ctrl && (input === 'c' || input === 'C' || input === '\x03')) {
      runInterruptLadder();
      return;
    }
    if (
      routeModalOverlayKey(
        {
          state,
          enhanceCancelled: enhanceCancelledRef,
          enhanceController: enhanceAbortRef,
          dispatch,
        },
        input,
        key,
      )
    ) {
      return;
    }

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
    // When the user presses Esc twice within ESC_DOUBLE_PRESS_MS ms while
    // the buffer is non-empty, clear it. This mirrors the behaviour of bash's
    // Ctrl+C double-press clearing the line, adapted for Esc (no Ctrl needed).
    if (key.escape) {
      const now = Date.now();
      if (state.buffer.length > 0 && now - lastEscAtRef.current < ESC_DOUBLE_PRESS_MS) {
        dispatch({ type: 'clearInput' });
        lastEscAtRef.current = 0;
        return;
      }
      lastEscAtRef.current = now;
    }

    // ── Bracketed-paste accumulation ──────────────────────────────────
    // Must run before the Enter/key handling below: a paste split across
    // events can land a fragment that is exactly "\n", which would
    // otherwise be read as Enter and submit mid-paste. The begin marker
    // (\x1b[200~, or a bare [200~ when Ink ate the ESC) opens accumulation;
    // we swallow every fragment until the end marker (\x1b[201~ / [201~),
    // then finalize the whole payload at once.
    if (input) {
      // Unfocus sidebar before processing paste so the buffer receives focus.
      if (state.sidebarFocused) {
        dispatch({ type: 'toggleSidebarFocus' });
      }
      const paste = feedPaste(pasteAccumRef.current, input);
      if (paste) {
        pasteAccumRef.current = paste.accum;
        if (pasteFlushTimerRef.current) clearTimeout(pasteFlushTimerRef.current);
        if (paste.error) {
          if (paste.accum !== null) {
            pasteFlushTimerRef.current = setTimeout(() => {
              pasteFlushTimerRef.current = null;
              pasteAccumRef.current = null;
            }, 500);
          } else {
            pasteFlushTimerRef.current = null;
          }
          dispatch({ type: 'addEntry', entry: { kind: 'error', text: paste.error } });
          return;
        }
        if (paste.complete !== null) {
          pasteFlushTimerRef.current = null;
          await commitPaste(paste.complete);
          return;
        }
        pasteFlushTimerRef.current = setTimeout(() => {
          pasteFlushTimerRef.current = null;
          const full = pasteAccumRef.current;
          pasteAccumRef.current = null;
          // Runs on the TIMER stack, where nothing above can catch it — unlike
          // the other `commitPaste` call sites, which are awaited inside
          // `handleKey` (and so covered by `useStableKeyHandler`'s catch).
          if (typeof full === 'string' && full) detach(commitPaste(full), 'Paste');
        }, 500);
        return;
      }
    }

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

    // ── Esc closes the topmost panel BEFORE the busy-interrupt ladder ──
    // Pressing Esc with a monitor/panel open means "close this panel",
    // not "abort the run and drop the queue" — even mid-stream. Panels
    // whose own useInput owns Esc (kanban's inline prompt, worktree,
    // goal kanban, phase monitor) are only CONSUMED here: the broadcast
    // useInput model delivers the same keypress to their handler, which
    // performs the close/cancel itself. Either way the double-Esc
    // clear-input timer is disarmed — an Esc spent on a panel must not
    // count toward the buffer-wipe double-press.
    if (key.escape) {
      const panelClose = escCloseAction(state);
      if (panelClose) {
        dispatch(panelClose);
        lastEscAtRef.current = 0;
        return;
      }
      if (escSelfOwnedPanelOpen(state)) {
        lastEscAtRef.current = 0;
        return;
      }
    }

    if (
      routeBusyInterruptKey(
        {
          state,
          dismissedAt: dismissedEscAtRef,
          streamingText: streamingTextRef,
          confirmExit: confirmExitRef,
          activeController: activeCtrlRef,
          dispatch,
          clearPendingConfirms,
          liveDirector,
        },
        key,
      )
    ) {
      return;
    }

    // Monitor overlays. Ctrl+F/G/T are the primary chords; F2/F3/F4 are
    // terminal-safe aliases because some terminals intercept the chord before
    // it reaches the app (notably Windows Terminal eats Ctrl+F for "Find").
    // F11/F12 are exposed as optional direct panel shortcuts; terminals that
    // reserve them can still use /f or the slash-command alternatives.
    // All toggles are allowed even while aborting, so the user can check
    // subagent state mid-steer.
    // Opening actions are mutually exclusive in the reducer via closePanels().
    // Ctrl+B → live multi-agent SDD board overlay (not in the F-key table —
    // no F-key alias, chord-only).
    if (key.ctrl && input === 'b') {
      dispatch({ type: 'toggleSddBoardMonitor' });
      return;
    }
    // Ctrl+Y → toggle the project kanban panel (not in the F-key table —
    // no F-key alias, chord-only). Mirrors Ctrl+B / SDD board pattern
    // because adding a 13th F-key slot would require expanding the picker
    // invariant `fn >= 1 && fn <= 12`. The slash command `/kanban` is the
    // canonical discovery path; Ctrl+Y is a power-user chord.
    //
    // NB: Ctrl+J (0x0A) is unsuitable — Ink 7 special-cases 0x0A as
    // `name='enter'` with `key.ctrl=false` BEFORE the ctrl+letter branch,
    // so the event arrives as `input='\n'` on mainstream terminals (xterm,
    // ConPTY, iTerm) and falls through to the submit path. Ctrl+B (0x02)
    // works because Ink does not special-case 0x02; Ctrl+Y (0x19) likewise.
    // Avoid 0x09/0x0A/0x0D (Ink special-case) and the existing F-key
    // ctrl-aliases (K, U, D, V, E, F, G, T).
    if (key.ctrl && input === 'y') {
      dispatch({ type: 'toggleKanbanPanel' });
      return;
    }
    // F-key / Ctrl-alias dispatch — table-driven via fKeyEntryFor.
    // Entries with hostAction need host-side work; the rest dispatch
    // directly via actionForFKeyPanel. (Two former "defence in depth"
    // branches were removed as unreachable: `key.fn && key.escape` can
    // never both be set, and Ink 7 never delivers a bare '\x1b' as
    // `input` — Esc-close is owned by the escCloseAction block above.)
    const fKeyMatched = fKeyEntryFor(key.fn, key.ctrl, input);
    if (fKeyMatched) {
      const entry = fKeyMatched;
      switch (entry.hostAction) {
        case 'openProjectPicker': {
          if (state.projectPicker.open) {
            dispatch({ type: 'projectPickerClose' });
          } else {
            dispatch({ type: 'closeAllPanels' });
            openProjectPicker();
          }
          return;
        }
        case 'loadLiveSessions': {
          if (!state.sessionsPanelOpen) {
            dispatch({ type: 'toggleSessionsPanel' });
            loadLiveSessions();
          } else {
            dispatch({ type: 'toggleSessionsPanel' });
          }
          return;
        }
        case 'openStatuslinePicker': {
          openStatuslinePicker();
          return;
        }
        case undefined: {
          const action = actionForFKeyPanel(entry, statuslineHiddenItems);
          if (action) {
            dispatch(action);
            return;
          }
          break;
        }
      }
    }
    // While the SDD board overlay is open, ←/→ drive the per-phase drill-down
    // (→ focuses a single topological column, ← steps back / exits to the
    // all-phases view) and `c` / `z` / `x` drive run lifecycle — clean worktrees
    // / rollback commits / destroy. clean+rollback refuse while the run is still
    // live (stop it first with Ctrl+C); destroy stops it for you.
    // The SDD board monitor is non-modal (chat input stays live above it),
    // so the `c` / `z` / `x` lifecycle shortcuts MUST be gated on an empty
    // input draft — otherwise typing the literal letters in chat would
    // silently fire `cleanup_worktrees` / `rollback` / `destroy`, all of
    // which are destructive and (per the fallback path) bypass the
    // confirmation ladder. This mirrors the `?` help-shortcut gate above
    // and the established non-modal pattern (F2/F3/F4/F6/F7 monitors).
    if (state.sddBoard?.monitorOpen && !key.ctrl && !key.meta && draftRef.current.buffer === '') {
      if (key.rightArrow) {
        dispatch({ type: 'sddBoardFocusNext' });
        return;
      }
      if (key.leftArrow) {
        dispatch({ type: 'sddBoardFocusPrev' });
        return;
      }
      if (input === 'c' || input === 'z' || input === 'x') {
        // c = clean worktrees · z = rollback merged commits · x = destroy.
        // Prefer the live run control (it self-refuses while running and works
        // between stop and registry-clear); fall back to the host's disk-backed
        // applySddLifecycle so the keys keep working once the run has finished.
        const op = input === 'c' ? 'cleanup_worktrees' : input === 'z' ? 'rollback' : 'destroy';
        const run = getSddRun?.();
        if (op !== 'destroy' && run) {
          const fn = op === 'cleanup_worktrees' ? run.cleanupWorktrees() : run.rollback();
          // A locked worktree or dirty index rejects here.
          detach(
            Promise.resolve(fn).then((r) => {
              dispatch({ type: 'addEntry', entry: sddLifecycleEntry(op, r) });
            }),
            `SDD ${op}`,
          );
          return;
        }
        if (onSddLifecycle) {
          detach(
            onSddLifecycle(op).then((r) => {
              dispatch({ type: 'addEntry', entry: sddLifecycleEntry(op, r) });
            }),
            `SDD ${op}`,
          );
        } else {
          dispatch({
            type: 'addEntry',
            entry: { kind: 'warn', text: 'SDD lifecycle is not available in this session.' },
          });
        }
        return;
      }
    }
    if (
      routeSettingsOverlayKey(
        { state, getSettings, saveSettings, lastEnterAt: lastEnterAtRef, dispatch },
        input,
        key,
        isEnter,
      )
    ) {
      return;
    }
    if (
      routePanelEscapeKey(
        state,
        key,
        dispatch,
        effectivePanelPositions(state, getSettings?.()).processList !== 'sidebar',
      )
    ) {
      return;
    }

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
    if (input === '?' && !key.ctrl && !key.meta && draftRef.current.buffer === '' && !overlayOpen) {
      dispatch({ type: 'toggleHelp' });
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
        // instead of chat history.
        if (
          historyWidth < (stdout?.columns ?? 80) &&
          key.mouse.x > historyWidth &&
          state.sidebarFocused
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
          // Scrolling always cancels any pending drag-select: the user is
          // moving through history, not committing a text selection. Without
          // this clear, a Right-Click after a wheel-flushed drag would copy a
          // stale range the user has already forgotten about.
          historyScrollRef.current?.clearSelection();
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
        // Copy icons live in the first of the three reserved scrollbar-rail
        // columns (icon + gap + track). Give a fresh press on that exact cell
        // priority over track jumping; the actual track remains the final
        // column and drags still scrub.
        const copyRow =
          region?.kind === 'history'
            ? region.row
            : region?.kind === 'scrollbar'
              ? region.cell
              : null;
        if (
          copyRow !== null &&
          key.mouse.kind === 'press' &&
          historyScrollRef.current?.hasCopyTargetAt(copyRow, key.mouse.x - 1)
        ) {
          // A copy-icon press also clears any pending drag-selection: starting
          // a fresh click cancels the previous gesture rather than letting the
          // user accidentally copy an unrelated selection they no longer want.
          historyScrollRef.current?.clearSelection();
          void historyScrollRef.current
            .copyAtViewportCell(copyRow, key.mouse.x - 1)
            .then((entryId) => {
              // Non-null id means the clipboard write succeeded — surface the
              // transient "Copied" confirmation and flash that card's icon. A
              // null result (missed target or write failure) is silent.
              if (entryId !== null) onHistoryCopy?.(entryId);
            })
            .catch(() => null);
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
      // left edge, so screen col = span.start + 1.
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
        return;
      }
      if (key.pageDown) {
        historyScrollRef.current?.scrollPage('down');
        return;
      }
      // Terminal-safe paging fallback for compact keyboards (notably MacBooks).
      // Preserve the composer's Ctrl+U/D editing semantics whenever it contains
      // text; on an empty draft these chords page through chat history.
      if (key.ctrl && draftRef.current.buffer === '' && (input === 'u' || input === 'd')) {
        historyScrollRef.current?.scrollPage(input === 'u' ? 'up' : 'down');
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
