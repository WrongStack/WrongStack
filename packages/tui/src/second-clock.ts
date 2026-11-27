import { useSyncExternalStore } from 'react';

/**
 * Shared 1-second subscriber clock for elapsed-time leaves.
 *
 * The elapsed chips (composer working time, status-bar fleet time, refiner
 * pulse) each need a per-second repaint, but the App shell must NOT re-render
 * every second just to feed them. One module-level interval serves every
 * active subscriber: all listeners are notified inside the same timer
 * callback, so React batches the updates into a single commit per second.
 * The interval only runs while at least one leaf is actively counting
 * (ref-counted start/stop), and it is unref'd so it never keeps the process
 * alive during teardown.
 *
 * This replaces the App-scope `useAnimation` tick (scan-report P4): giving
 * each leaf its own independent interval would produce out-of-phase commits
 * — two terminal repaints per second where one suffices.
 */

let tick = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    timer = setInterval(() => {
      tick += 1;
      // Notify every subscriber in ONE callback so React batches the
      // resulting store updates into a single render commit.
      for (const notify of listeners) notify();
    }, 1_000);
    timer.unref?.();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getSnapshot(): number {
  return tick;
}

const noopSubscribe = (): (() => void) => () => {};
const zeroSnapshot = (): number => 0;

/**
 * Subscribe to the shared 1s clock while `active` is true. Returns the
 * monotonic tick count; inactive callers never start the interval and never
 * re-render on ticks.
 */
export function useSecondTick(active: boolean): number {
  return useSyncExternalStore(
    active ? subscribe : noopSubscribe,
    active ? getSnapshot : zeroSnapshot,
    zeroSnapshot,
  );
}

/**
 * Elapsed milliseconds for a work spell: accumulated `base` from finished
 * spells plus the live delta since `startedAt` (null when idle). While a
 * spell is running the leaf re-renders once per second via the shared clock;
 * when idle it is fully unsubscribed and returns the frozen base.
 */
export function useElapsedMs(base: number, startedAt: number | null): number {
  useSecondTick(startedAt !== null);
  return startedAt === null ? base : base + (Date.now() - startedAt);
}
