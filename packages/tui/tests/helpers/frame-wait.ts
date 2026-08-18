/**
 * Bounded frame waiting for ink-testing-library views.
 *
 * Asserting `view.lastFrame()` after ONE `setImmediate` flush is not sound:
 * the observed content lands only after effect → (fetch promise) → setState
 * → React/ink scheduler commit, and the commit is a MessageChannel macrotask
 * with no guaranteed ordering against a single `setImmediate`. On a
 * contended CI runner the sample can beat the commit and read a pre-commit
 * frame — the exact failure of CI run 32137776491 (cron-jobs-monitor saw the
 * 'No cron jobs' empty state instead of the 'cron offline' error banner).
 * Polling the rendered frame until it settles removes the ordering
 * assumption entirely.
 *
 * The deadline uses monotonic `performance.now()` on purpose: some suites
 * freeze `Date.now()` to a constant, which would make a `Date.now()`-derived
 * deadline unreachable and convert a genuine regression into a testTimeout
 * hang instead of a crisp assertion failure.
 */

/** Minimal structural shape of an ink-testing-library render result. */
export interface FrameView {
  lastFrame(): string | undefined;
}

/**
 * Sample frames until `predicate` holds (bounded by `timeoutMs`).
 * Returns the last frame either way, so a genuine failure surfaces the
 * actual rendered content in the assertion diff rather than a timeout.
 */
export async function waitForFrame(
  view: FrameView,
  predicate: (frame: string) => boolean,
  timeoutMs = 2000,
): Promise<string> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const frame = view.lastFrame() ?? '';
    if (predicate(frame)) return frame;
    if (performance.now() > deadline) return frame;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
