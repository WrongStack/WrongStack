import type { SessionEvent, SessionSummary } from '../types/session.js';

/**
 * The single definition of `SessionSummary.outcome`.
 *
 * Two code paths produce this field — the live writer's `SessionSummaryTracker`
 * and the disk-rebuild `summarizeSessionEventSequence` — and they disagreed
 * three ways on the same journal, so the value a user saw depended on whether
 * the `.summary.json` sidecar cache happened to be warm:
 *
 *  1. **Precedence.** The rebuild asked "how did this session END", letting a
 *     trailing `session_end` mean `completed`. The live tracker made `error`
 *     sticky from the moment it was set, overriding the terminal marker — so a
 *     session that hit one error and then finished cleanly reported `error`
 *     forever, and no successful recovery could clear it.
 *  2. **What counts as an error.** The live tracker treated any `tool_result`
 *     with `isError` as an errored session. A failed grep is ordinary agent
 *     operation; `toolErrorCount` already records those precisely. Only
 *     `error` / `provider_error` events mean the session itself went wrong.
 *  3. **The no-signal case.** The rebuild left `outcome` undefined when the
 *     journal ended on neither a terminal marker nor an error; the live
 *     tracker defaulted to `completed`, asserting a clean end it had no
 *     evidence for.
 *
 * Measured drift: one journal (`user_input`, an errored `tool_result`, a normal
 * `llm_response`, `session_end`) summarized as `error` live and `completed`
 * rebuilt. Both paths now call this function.
 *
 * @param lastEventType Type of the final event in the journal, or undefined for
 *   an empty one. `session_end` means a clean shutdown wrote its marker; a
 *   trailing `in_flight_start` means the process died mid-operation.
 * @param hadSessionError Whether any `error` / `provider_error` event was
 *   observed. Consulted only when the journal has no terminal marker to speak
 *   for itself.
 */
export function resolveSessionOutcome(
  lastEventType: SessionEvent['type'] | undefined,
  hadSessionError: boolean,
): SessionSummary['outcome'] {
  if (lastEventType === 'session_end') return 'completed';
  if (lastEventType === 'in_flight_start') return 'aborted';
  if (hadSessionError) return 'error';
  // No terminal marker and no error: genuinely unknown. Claiming `completed`
  // here is how a killed process used to look successful in listings.
  return undefined;
}

/**
 * Whether an event means the SESSION failed, as opposed to one operation
 * inside it failing. Kept next to {@link resolveSessionOutcome} so both
 * producers classify identically.
 */
export function isSessionErrorEvent(event: SessionEvent): boolean {
  return event.type === 'error' || event.type === 'provider_error';
}
