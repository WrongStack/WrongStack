/**
 * Confirm-observer registry — tells the approval path which
 * `tool.confirm_needed` listeners can actually ANSWER a prompt.
 *
 * `waitForConfirm` auto-denies when nothing is listening, because emitting the
 * event with no UI attached leaves the resolver pending forever and the run
 * looks stuck (headless/CI). That guard is a raw `listenerCount`, which cannot
 * tell an answering surface (TUI dialog, WebUI modal) from a passive one.
 *
 * The HQ approval bridge is passive by design: it MIRRORS prompts a local
 * surface raised so a remote operator can also answer them. Subscribing it
 * would have silently converted every headless auto-deny into a 120-second
 * wait, purely because HQ happened to be connected — a safety regression with
 * no visible cause. Passive subscribers mark themselves here and the guard
 * subtracts them, so "HQ is the only listener" still means "nobody can
 * answer".
 *
 * Process-wide on purpose. The count is compared against a single bus's
 * listener count, so the arithmetic is only exact when the observers are on
 * that bus. It errs toward auto-deny (an observer on another bus makes the
 * difference smaller, never larger), which is the safe direction.
 *
 * @module core/confirm-observers
 */

let observerCount = 0;

/**
 * Declare that the caller subscribed to `tool.confirm_needed` only to WATCH —
 * it will never answer on its own. Returns a disposer; call it when the
 * subscription goes away.
 */
export function markConfirmObserver(): () => void {
  observerCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    observerCount = Math.max(0, observerCount - 1);
  };
}

/** How many currently-registered `tool.confirm_needed` listeners cannot answer. */
export function confirmObserverCount(): number {
  return observerCount;
}

/** Test-only reset so a leaked observer in one spec cannot skew the next. */
export function resetConfirmObserversForTest(): void {
  observerCount = 0;
}
