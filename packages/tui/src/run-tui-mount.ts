import { isFrugalPerf } from '@wrongstack/core/utils';
import { type RenderOptions, render } from 'ink';
import type React from 'react';
import { createFrameDiffStdout, tuiFrameDiffEnabled } from './frame-diff-stdout.js';

/** Ink mount handle: the instance signal handlers unmount, plus the resize unsubscription. */
export interface MountInkAppResult {
  instance: { unmount: () => void; waitUntilExit(): Promise<unknown> };
  detachResize: () => void;
  /** Make the next frame a whole repaint, after a screen write Ink did not make. */
  invalidateFrame: () => void;
}

/**
 * Frame ceiling for Ink's render throttle. It bounds every repaint, a typed
 * character's echo included: at the old 10fps a keystroke waited up to 100ms
 * for its frame (measured p50 ~115ms), at 30fps ~15ms. Stream paints are
 * paced separately and slower by `tuiStreamFlushMs`, so the ceiling does not
 * raise steady streaming cost; the frugal profile halves it.
 */
export function tuiRenderMaxFps(): number {
  return isFrugalPerf() ? 15 : 30;
}

/** Ink render options for the TUI. Exported for tests. */
export function tuiRenderOptions(deps: {
  inkStdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
}): RenderOptions {
  return {
    exitOnCtrlC: false,
    stdin: deps.inkStdin,
    stdout: deps.stdout,
    maxFps: tuiRenderMaxFps(),
    // Write only the changed part of each changed line instead of the whole
    // frame. Ink ignores this for frames that fill the viewport on Windows
    // consoles, where it repaints the frame inside one synchronized update.
    // WRONGSTACK_TUI_INCREMENTAL=0 falls back to whole-frame writes for a
    // terminal that mishandles the cursor-relative updates.
    incrementalRendering: process.env['WRONGSTACK_TUI_INCREMENTAL'] !== '0',
  };
}

/**
 * Ink mount — moved verbatim from runTui() (decomposition Phase 1 R3,
 * docs/decomposition-plan.md): render() with exitOnCtrlC disabled and fps
 * bounding, the raw-Ctrl+C stdin watcher arming (only AFTER Ink owns stdin —
 * attaching earlier would flip the stream into flowing mode and drop
 * boot-time keystrokes), and the resize erase handler.
 *
 * Any mount failure is reported through onStartupFailure and returns null;
 * runTui then returns without wiring waitUntilExit — same as the original
 * catch-and-return.
 */
export function mountInkApp(deps: {
  appElement: React.ReactElement;
  inkStdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  onRawCtrlC: (data: Buffer | string) => void;
  onStartupFailure: (err: unknown) => void;
}): MountInkAppResult | null {
  try {
    // Ink repaints viewport-filling frames whole on Windows consoles; the
    // differ turns those into writes of just the rows that changed.
    const frameDiff = createFrameDiffStdout(deps.stdout, { enabled: tuiFrameDiffEnabled() });
    const instance = render(
      deps.appElement,
      tuiRenderOptions({ inkStdin: deps.inkStdin, stdout: frameDiff.stream }),
    );
    // Arm the last-resort raw Ctrl+C watcher now that Ink owns stdin —
    // attaching a 'data' listener earlier would flip the stream into
    // flowing mode before Ink mounts and drop boot-time keystrokes.
    deps.inkStdin.on('data', deps.onRawCtrlC);

    // Terminal reflows visible text on resize BEFORE Ink can react, which can
    // leave ghosts below the cursor. Erase from-cursor-to-end on every resize
    // to minimize artifacts. Ink immediately re-renders at the new width.
    const onResize = (): void => {
      // The erase below bypasses the frame differ, and the terminal reflowed.
      frameDiff.invalidate();
      try {
        // \x1b[J = erase from cursor to end of screen. Does NOT touch
        // anything above the cursor, so committed Static history in
        // scrollback is preserved. Ink's useStdout subscriber will
        // immediately re-render the live region at the new width.
        // Do NOT prefix with \x1b[H: homing to (0,0) erases the visible
        // committed output and repositions the live region (input + status
        // bar) at the top of the viewport instead of the bottom.
        deps.stdout.write('\x1b[J');
      } catch {
        // stdout might be detached mid-shutdown — ignore.
      }
    };
    deps.stdout.on('resize', onResize);

    return {
      instance,
      detachResize: () => deps.stdout.off('resize', onResize),
      invalidateFrame: frameDiff.invalidate,
    };
  } catch (err) {
    deps.onStartupFailure(err);
    return null;
  }
}
