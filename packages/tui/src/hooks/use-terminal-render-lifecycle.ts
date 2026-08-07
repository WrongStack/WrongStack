import { writeOut } from '@wrongstack/core/utils';
import React, { useCallback, useEffect, useInsertionEffect, useRef } from 'react';
import type { State } from '../app-state.js';
import { onResize } from '@wrongstack/core/utils';

/** Owns terminal live-region cleanup around overlay/entry/stream transitions. */
export function useTerminalRenderLifecycle(state: State): void {
  // Live-region shrink mitigation. Ink's log-update tracks the previous
  // render's logical line count; when content visually wraps past the
  // terminal width, the visual-row count exceeds the logical count and
  // log-update's clear-and-rewrite leaves the extra visual rows behind.
  // Those extras then slide into native scrollback as the next render
  // commits new Static items above the live region — looking to the user
  // like an extra echo of the input (the empty input sliding into
  // scrollback when Enter is pressed without text).
  //
  // We can't reach log-update directly, but we can issue an erase-below-
  // cursor (\x1b[J) at the moments most likely to leak: when a picker /
  // dialog transitions from open → closed (the live region's height
  // drops sharply), when a fresh history entry was just committed, and
  // when the terminal resizes (Ink re-renders the live region but the
  // cleanup logic above doesn't fire since none of its deps changed).
  // \x1b[J only touches what's below the cursor, so committed Static
  // history above is preserved.
  const prevAnyOverlayOpen = useRef(false);
  const prevEntriesCount = useRef(0);
  // Track tool-stream text length so we can fire eraseLiveRegion when the
  // live tool-output box grows — prevents the ◆ bash ⏱ Xms header line
  // from duplicating into scrollback on every 500ms tick.
  const prevToolStreamLen = useRef(0);
  // Tracks whether we've already rendered once. On the very first render
  // the prev-refs above hold their initial false/0 defaults, which makes
  // `newEntryCommitted` true whenever the app mounts with any history
  // entries already on screen — that fires eraseLiveRegion() before Ink
  // has even painted, wiping the just-committed scrollback. Skip the
  // first commit entirely; from render 2 onwards the refs reflect real
  // prior state and the diff is meaningful.
  const hasMounted = useRef(false);
  // Stable erase function — only calls process.stdout.write which is a stable global.
  const eraseLiveRegion = useCallback(() => {
    try {
      // \x1b[J = erase from cursor to end of screen. The cursor sits at the
      // top of log-update's live region, so this clears the stale live
      // region only and leaves committed Static history (in scrollback)
      // untouched. Do NOT prefix with \x1b[H: homing to (0,0) wipes the
      // visible committed output and forces the input/status bar to redraw
      // at the top of the viewport instead of staying pinned to the bottom.
      writeOut('\x1b[J');
    } catch {
      // stdout might be detached during shutdown — ignore.
    }
  }, []);
  // Cursor save-restore bracket across the Ink paint cycle:
  //
  //   useInsertionEffect → DECSC (\x1b7)   — save cursor before Ink writes
  //                        ← Ink writes new frame to stdout
  //   useLayoutEffect    → DECRC (\x1b8)   — restore cursor after Ink
  //                        ← optional \x1b[J erase at the correct position
  //
  // Without the bracket, Ink's own cursor movements between insertion and
  // layout effects shift the cursor, so \x1b[J erases a wrong region.
  // useEffect (async microtask) was too late: the terminal had already
  // scrolled the old content into scrollback by the time it fired.
  React.useLayoutEffect(() => {
    // Restore cursor saved by DECSC in useInsertionEffect above. Ink may
    // have moved the cursor while writing the new frame; DECRC returns it
    // to the pre-paint position so \x1b[J erase targets the correct region.
    try { writeOut('\x1b8'); } catch { /* stdout detached during shutdown */ }
    if (!hasMounted.current) {
      // Seed the refs from current state so the NEXT render has a real
      // baseline to diff against, then bail without writing.
      hasMounted.current = true;
      prevAnyOverlayOpen.current =
        state.picker.open ||
        state.slashPicker.open ||
        state.modelPicker.open ||
        state.autonomyPicker.open ||
        state.designPicker.open ||
        state.resumePicker.open ||
        state.settingsPicker.open ||
        state.enhanceBusy ||
        state.enhance != null ||
        state.refineFailure != null ||
        state.continueConfirm != null ||
        state.clearConfirm != null ||
        state.slashConfirm != null ||
        state.coordinator.monitorOpen ||
        state.escConfirm != null ||
        state.sendModePicker != null ||
        state.confirmQueue.length > 0 ||
        state.shellCommandWarning != null ||
        state.brainPrompt != null;
      prevEntriesCount.current = state.entries.length;
      prevToolStreamLen.current = state.toolStream?.text.length ?? 0;
      return;
    }
    const anyOpenNow =
      state.picker.open ||
      state.slashPicker.open ||
      state.modelPicker.open ||
      state.autonomyPicker.open ||
      state.designPicker.open ||
      state.resumePicker.open ||
      state.settingsPicker.open ||
      state.enhanceBusy ||
      state.enhance != null ||
      state.refineFailure != null ||
      state.continueConfirm != null ||
      state.clearConfirm != null ||
      state.slashConfirm != null ||
      state.coordinator.monitorOpen ||
      state.escConfirm != null ||
      state.sendModePicker != null ||
      state.confirmQueue.length > 0 ||
      state.shellCommandWarning != null ||
      state.brainPrompt != null;
    const overlayClosed = prevAnyOverlayOpen.current && !anyOpenNow;
    const newEntryCommitted = state.entries.length > prevEntriesCount.current;
    const curToolStreamLen = state.toolStream?.text.length ?? 0;
    const toolStreamGrew = curToolStreamLen > 0 && curToolStreamLen > prevToolStreamLen.current;
    prevAnyOverlayOpen.current = anyOpenNow;
    prevEntriesCount.current = state.entries.length;
    prevToolStreamLen.current = curToolStreamLen;
    if (overlayClosed || newEntryCommitted || toolStreamGrew) {
      eraseLiveRegion();
    }
  }, [
    state.picker.open,
    state.slashPicker.open,
    state.modelPicker.open,
    state.autonomyPicker.open,
    state.designPicker.open,
    // resumePicker is read by both overlay expressions above; it was the one
    // picker missing from this list, so /resume open→close never re-ran the
    // effect and the app's TALLEST overlay never got its erase — the session
    // list leaked into native scrollback.
    state.resumePicker.open,
    state.settingsPicker.open,
    state.enhanceBusy,
    state.enhance,
    state.refineFailure,
    state.continueConfirm,
    state.clearConfirm,
    state.slashConfirm,
    state.coordinator.monitorOpen,
    state.escConfirm,
    state.sendModePicker,
    state.confirmQueue.length,
    state.shellCommandWarning,
    state.brainPrompt,
    state.entries.length,
    state.toolStream?.text,
    eraseLiveRegion,
  ]);

  // ── Terminal resize ──
  // The old close-all-panels → wait 300ms → restore dance is gone: it made
  // every resize visibly collapse and re-open the user's panels, raced with
  // manual open/close during the window, and its underlying problem (a
  // too-tall live region scrolling reflowed rows into native scrollback) is
  // now prevented structurally — AppView caps its root at termRows with
  // overflowY hidden, so no frame can ever be taller than the terminal.
  // What remains here is a single erase-below-cursor so rows the terminal
  // itself reflowed don't linger as ghosts until Ink's next paint (run-tui
  // installs the same erase after Ink's own resize handler; this one runs
  // for renders driven by React state updates in the same burst).
  useEffect(() => {
    // Not a size READ — a side effect on resize — so it uses core's
    // `onResize` directly rather than `useTerminalSize`, which exists to hand
    // out dimensions. Same subscriber either way.
    return onResize(() => eraseLiveRegion());
  }, [eraseLiveRegion]);

  // While the prompt-refinement flow is active, the EnhancePanel's countdown
  // re-renders the live region every second. In inline mode each redraw can
  // bleed the region's top rows into native scrollback, so the preview
  // "clones" itself. We need to erase the stale region BEFORE Ink flushes
  // the new tree to the terminal — that means useInsertionEffect (runs in
  // the render commit phase, strictly before useLayoutEffect and before any
  // DOM/IO write). useLayoutEffect is too late: by the time it fires Ink
  // has already begun its paint and the first few rows of the new region
  // are co-mingled with the stale ones.
  //
  // The hasMounted ref is shared with the overlay-closed/entry-committed
  // effect above: skip the first render so we never erase on initial paint
  // (the previous terminal state is whatever the user saw before the app
  // started — there's no live region to clean yet, only committed scrollback).
  useInsertionEffect(() => {
    // Save cursor before Ink processes the React tree. The matching DECRC
    // in useLayoutEffect restores the cursor AFTER Ink's paint, so the
    // erase-below-cursor calls below target the correct live region.
    try { writeOut('\x1b7'); } catch { /* stdout detached during shutdown */ }
    if (!hasMounted.current) return;
    if (
      state.enhanceBusy ||
      state.enhance != null ||
      state.refineCountdown != null ||
      state.refineFailure != null ||
      state.continueConfirm != null
    )
      eraseLiveRegion();
  });
}
