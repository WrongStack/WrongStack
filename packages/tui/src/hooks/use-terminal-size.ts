/**
 * One subscription point for terminal size.
 *
 * Eleven components and hooks each did this by hand:
 *
 * ```ts
 * const { stdout } = useStdout();
 * const [w, setW] = useState(stdout?.columns ?? 90);
 * useEffect(() => {
 *   const handleResize = () => setW(stdout?.columns ?? 90);
 *   handleResize();
 *   process.stdout.on('resize', handleResize);
 *   return () => process.stdout.off('resize', handleResize);
 * }, [stdout]);
 * ```
 *
 * Three problems, all of them invisible until they aren't:
 *
 *  - **Listener budget.** Every copy attaches its own listener to
 *    `process.stdout`, and nothing raises the limit. Seven of these are
 *    mounted for the whole session (status bar, history, input,
 *    monitor-shell, sidebar frame, viewport sync, render lifecycle); open the
 *    fleet, mailbox and enhance panels and Node prints
 *    `MaxListenersExceededWarning` to stderr — straight through the middle of
 *    a rendered frame.
 *  - **Two different streams.** They SUBSCRIBE to `process.stdout` but READ
 *    from Ink's `useStdout()`. Those are the same object in a normal run and
 *    different objects under Ink's test renderer, where the listener then
 *    fires for a stream nobody reads.
 *  - **Three defaults.** `?? 90`, `?? 80` and `?? 24` all appear, so the same
 *    non-TTY produces different layouts in different panels.
 *
 * Core already exports `onResize(cb, stream)` for this and had no callers.
 * This hook is the React shape of it: subscribe to the stream you read, with
 * the fallback stated once per call site rather than remembered.
 */

import { onResize } from '@wrongstack/core/utils';
import { useEffect, useState } from 'react';
import { useStdout } from '../ink.js';

interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

interface UseTerminalSizeOptions {
  /**
   * Upper bound applied to `columns`. Panels use this to stay inside a pinned
   * content width — see the bordered-box overflow rule.
   */
  readonly maxWidth?: number | undefined;
  /**
   * Column count when the stream reports none (a pipe, a test renderer).
   * Deliberately explicit: the call sites this replaced disagreed (90 vs 80),
   * and quietly picking one would have moved layouts in non-TTY runs.
   */
  readonly fallbackColumns?: number | undefined;
  /** Row count when the stream reports none. */
  readonly fallbackRows?: number | undefined;
}

export function useTerminalSize(options: UseTerminalSizeOptions = {}): TerminalSize {
  const { maxWidth, fallbackColumns = 80, fallbackRows = 24 } = options;
  const { stdout } = useStdout();
  // Ink's stream in a real run IS `process.stdout`; under the test renderer it
  // is not. Read and subscribe to the same one either way.
  const stream = stdout ?? process.stdout;

  const measure = (): TerminalSize => {
    const raw = stream?.columns ?? fallbackColumns;
    return {
      columns: maxWidth ? Math.min(raw, maxWidth) : raw,
      rows: stream?.rows ?? fallbackRows,
    };
  };

  const [size, setSize] = useState<TerminalSize>(measure);

  useEffect(() => {
    // Re-measure on mount: the stream may have changed size between the
    // initial `useState` and the effect, and a panel that opens after a resize
    // would otherwise render one frame at the old width.
    setSize(measure());
    return onResize(() => setSize(measure()), stream as NodeJS.WriteStream);
    // `measure` closes over the three values below; re-subscribing on a stream
    // swap is required, and on a bound change is how the cap takes effect.
  }, [stream, maxWidth, fallbackColumns, fallbackRows]);

  return size;
}
