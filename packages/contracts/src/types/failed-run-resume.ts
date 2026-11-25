/**
 * Automatic resume of a leader run a provider killed on a transient failure
 * (timeout, 5xx, dropped connection, rate limit) — one policy for every host
 * that auto-proceeds, so the TUI, REPL and WebUI cannot drift apart.
 *
 * A provider that times out once usually times out a few times in a row, so a
 * single resume left `auto` sessions stopped mid-task. The budget is a few
 * resumes with a growing wait; it resets once a run completes, and a host
 * pauses (autonomy untouched) when it runs out.
 *
 * Browser-safe: no Node imports.
 */

/** Automatic resumes allowed in a row before the host pauses for the user. */
export const MAX_FAILED_RUN_RESUMES = 3;

/** Longest wait before one automatic resume. */
export const MAX_FAILED_RUN_RESUME_DELAY_MS = 120_000;

/** Base wait for hosts whose ordinary auto-proceed delay is near zero. */
export const DEFAULT_FAILED_RUN_RESUME_BASE_MS = 15_000;

function failedRunResumeAttempt(attempt: number): number {
  return Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
}

/**
 * Whether a finished run is one an automatic resume can fix: it `failed` (a
 * run the user stopped comes back `aborted`) on a provider error the provider
 * marked recoverable — rate limit, overload, 5xx, timeout, dropped connection.
 * A context overflow is recoverable but would overflow again, and non-provider
 * stops (loop guard, iteration limit) were deliberate.
 */
export function isResumableRunFailure(
  status: string,
  error: { code?: string | undefined; recoverable?: boolean | undefined } | undefined,
): boolean {
  if (status !== 'failed') return false;
  if (error?.recoverable !== true) return false;
  const code = error.code ?? '';
  return code.startsWith('PROVIDER_') && code !== 'PROVIDER_CONTEXT_OVERFLOW';
}

/**
 * Wait before resume `attempt` (1-based): the host's base delay, doubled per
 * attempt, capped. A provider that just failed on its own retries needs time,
 * not an immediate fourth try.
 */
export function failedRunResumeDelayMs(attempt: number, baseMs: number): number {
  const base = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : 0;
  if (base === 0) return 0;
  const step = failedRunResumeAttempt(attempt);
  return Math.min(MAX_FAILED_RUN_RESUME_DELAY_MS, base * 2 ** (step - 1));
}

/**
 * The prompt for resume `attempt` (1-based). The attempt number keeps each
 * resume distinct, so the auto-proceed repetition guard counts real progress
 * instead of halting the second resume as an echo loop. The run's own work is
 * still in the transcript, so it asks to carry on, not to start over.
 */
export function failedRunResumePrompt(attempt: number, reason?: string): string {
  const step = failedRunResumeAttempt(attempt);
  const trimmedReason = reason?.trim().replace(/\s+/g, ' ') ?? '';
  let reasonEnd = Math.min(trimmedReason.length, 200);
  const lastReasonUnit = trimmedReason.charCodeAt(reasonEnd - 1);
  if (lastReasonUnit >= 0xd800 && lastReasonUnit <= 0xdbff) reasonEnd -= 1;
  const cause = trimmedReason ? ` (${trimmedReason.slice(0, reasonEnd)})` : '';
  return [
    `Automatic resume ${step} of ${MAX_FAILED_RUN_RESUMES}: the previous run stopped on a provider error${cause} after its retries, not on a decision of yours.`,
    'Continue the original task from where it stopped; do not redo work that is already done, and do not stop to ask whether to continue.',
    'If you cannot tell how far it got, check the files and the todo board first, then carry on.',
  ].join(' ');
}
