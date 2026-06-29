import type { EventBus } from '../kernel/events.js';

export interface RequestLimitExtensionOptions {
  events: EventBus;
  sessionId?: string | undefined;
  currentIterations: number;
  currentLimit: number;
  /** When true (default), auto-grant 100 extra after giving listeners a tick to deny. */
  autoExtend: boolean;
  /** Timeout in ms before falling back to "0 extra" if no listener responds. */
  timeoutMs?: number | undefined;
}

/**
 * Emit `iteration.limit_reached` and wait for a listener to grant or
 * deny. Resolves with the number of extra iterations to grant (0 = stop).
 * When `autoExtend` is true the listener gets a `setImmediate` window to
 * react; otherwise the resolution stays open until the timer fires.
 *
 * Listener contract — **important for `autoExtend: true` callers**:
 *
 *   - `grant(extra)` and `deny()` must be invoked **synchronously** from
 *     the event listener (or earlier than the next `setImmediate` tick).
 *     The auto-grant path resolves to 100 inside `setImmediate`, so any
 *     async work between receiving the event and calling grant/deny will
 *     lose the race and the auto-grant wins.
 *
 *   - If you need to make an async decision (await a confirm dialog,
 *     query a remote policy), pass `autoExtend: false`. The promise will
 *     stay pending until the listener calls grant/deny or `timeoutMs`
 *     fires (default 30s).
 *
 *   - Multiple listeners are allowed but the first to call grant/deny
 *     wins; subsequent calls are no-ops.
 */
export function requestLimitExtension(opts: RequestLimitExtensionOptions): Promise<number> {
  const { events, sessionId, currentIterations, currentLimit, autoExtend, timeoutMs = 30_000 } = opts;
  return new Promise((resolve) => {
    let resolved = false;
    // Shared flag so setImmediate knows when timer already resolved.
    const timerFired = () => {
      if (!resolved) {
        resolved = true;
        resolve(0);
      }
    };
    const timer = setTimeout(timerFired, timeoutMs);
    timer.unref(); // Don't keep event loop alive past timeout
    const deny = () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(0);
      }
    };
    const grant = (extra: number) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(Math.max(0, extra));
      }
    };
    events.emit('iteration.limit_reached', {
      sessionId,
      currentIterations,
      currentLimit,
      grant,
      deny,
    });
    if (autoExtend) {
      // Give listeners a tick to deny synchronously; otherwise auto-grant 100.
      setImmediate(() => {
        // Only act if timer hasn't already fired — prevents a wasted microtask
        // when the timeout resolved before this tick.
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve(100);
        }
      });
    }
  });
}
