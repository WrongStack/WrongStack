import { render } from 'ink';
import type React from 'react';

/** Ink mount handle: the instance signal handlers unmount, plus the resize unsubscription. */
export interface MountInkAppResult {
  instance: { unmount: () => void; waitUntilExit(): Promise<unknown> };
  detachResize: () => void;
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
    const instance = render(deps.appElement, {
      exitOnCtrlC: false,
      stdin: deps.inkStdin,
      // Bound reconciliation/tokenization work for large live histories
      // while preserving responsive streamed output.
      maxFps: 10,
    });
    // Arm the last-resort raw Ctrl+C watcher now that Ink owns stdin —
    // attaching a 'data' listener earlier would flip the stream into
    // flowing mode before Ink mounts and drop boot-time keystrokes.
    deps.inkStdin.on('data', deps.onRawCtrlC);

    // Terminal reflows visible text on resize BEFORE Ink can react, which can
    // leave ghosts below the cursor. Erase from-cursor-to-end on every resize
    // to minimize artifacts. Ink immediately re-renders at the new width.
    const onResize = (): void => {
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
    };
  } catch (err) {
    deps.onStartupFailure(err);
    return null;
  }
}
