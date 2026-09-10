/**
 * Composer routes for the TUI key handler — decomposition Phase 3 route 6
 * (final route; R5 picker was already a single delegation and needed no
 * module — see docs/decomposition-plan.md execution log).
 *
 * Moved verbatim from `createAppKeyHandler`/`handleKey`
 * (docs/decomposition-plan.md, Phase 3). `routeComposer` owns the
 * empty-draft `?`/`!` shortcuts and the Enter pipeline (Shift+Enter
 * newline, bash-mode run through `/dev`, the 50ms `\r\n` dedupe window,
 * the intentionally-not-awaited detached submit). `routeComposerTail`
 * owns the `routeInputKey` delegation (args bag built from ctx) and the
 * Ctrl+P → PhaseMonitor / `/goal` alias.
 *
 * Call-order contract (pinned by tests/key-handler-replay-corpus.test.ts):
 * routeComposer runs after the panel/picker routes; routeComposerTail runs
 * after the pointer route, as the last content routes before handleKey ends.
 */

import type { KeyEvent } from '../components/input.js';
import { DEFAULT_INPUT_PROMPT } from '../components/input.js';
import { routeInputKey } from '../input-key-router.js';
import type { KeyRouteContext } from '../key-handler-context.js';

/**
 * Empty-draft `?`/`!` shortcuts plus the Enter pipeline. `isEnter` is
 * derived in the orchestrator (the picker delegation consumes it too) and
 * passed in. Returns true when the key was consumed.
 */
export function routeComposer(
  ctx: KeyRouteContext,
  input: string,
  key: KeyEvent,
  isEnter: boolean,
): boolean {
  const { state, dispatch, draftRef, overlayOpen, setDraft, lastEnterAtRef, submit, detach } = ctx;

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
    return true;
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
    return true;
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
      return true;
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
      return true;
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
    if (now - lastEnterAtRef.current < 50) return true;
    lastEnterAtRef.current = now;
    // `submit` is typed `() => void` at the wiring site, so TS silently
    // discarded the promise it actually returns — and its non-slash branch
    // has no top-level try/catch (an `@file` chip whose file was deleted
    // between attach and send rejects while resolving attachments).
    // `useStableKeyHandler` only covers the promise `handleKey` itself
    // returns; `void submit()` detached from that chain.
    detach(Promise.resolve(submit()), 'Send');
    return true;
  }
  return false;
}

const INPUT_PROMPT = DEFAULT_INPUT_PROMPT;

/**
 * The composer tail: the `routeInputKey` delegation (text insertion,
 * cursor movement, input history, autocomplete — the router owns the
 * full contract) followed by the Ctrl+P → PhaseMonitor / `/goal`
 * alias. Returns true when the key was consumed.
 */
export async function routeComposerTail(
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
    nextStepsAutoSubmitTimerRef,
    nextStepsAutoSubmitSuggestionRef,
    nextStepsAutoSubmitLabel,
    setNextStepsAutoSubmitCountdown,
    setNextStepsAutoSubmitLabel,
    cancelNextStepsCountdown,
    setDraft,
    pasteClipboardText,
    pasteClipboardImage,
    commitPaste,
    slashRegistry,
    agent,
    detach,
  } = ctx;

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
    return true;
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
    return true;
  }
  return false;
}
