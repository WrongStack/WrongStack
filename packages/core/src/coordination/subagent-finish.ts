/**
 * subagent-finish — model-driven completion for background subagents.
 *
 * Problem this module solves: a subagent that outlives its leader (the
 * post-session Chimera reviewer is the canonical case) previously had only
 * two exits — finish on its own, or be killed by the wall-clock watchdog
 * (`executeSubagentWithTimeout` aborts the runner at the deadline). The kill
 * is an external interrupt: it discards whatever the model was mid-way
 * through producing and violates the "agent completes its own turn" contract.
 *
 * The graceful-finish path replaces the kill with a notification:
 *
 *   1. The subagent's config opts in via `gracefulFinish`.
 *   2. When the finish condition fires — the wall-clock deadline is crossed,
 *      or the leader explicitly calls `Director.requestFinish()` — the budget
 *      records a single finish deadline and emits `subagent.finish_requested`
 *      on the subagent's EventBus, carrying the ready-to-read notice text.
 *   3. The agent loop folds that notice into the conversation as a `/btw`
 *      note at the TOP of its next iteration — between tool batches,
 *      in-band, no abort, no restart.
 *   4. The model reads the notice and completes its task in its own turn.
 *   5. If the grace window also elapses, the watchdog applies the existing
 *      terminal stop. That is the documented maximum lifetime — the bound
 *      that keeps a subagent from living forever, reached only after the
 *      model was given legitimate working time to finish.
 *
 * @module subagent-finish
 */

/** Structural form of `SubagentConfig.gracefulFinish` (avoids a layer cycle). */
export type GracefulFinishConfig = boolean | { graceMs?: number | undefined } | undefined;

/**
 * EventBus name for the in-band finish request. Emitted on the subagent's own
 * EventBus (the bus the runner wired into `budget._events`), so delivery is
 * process-local and lands at the loop's next iteration boundary.
 */
export const SUBAGENT_FINISH_REQUESTED_EVENT = 'subagent.finish_requested';

/**
 * Default grace window granted after the finish request fires. Long enough
 * for a model to run one or two more tool calls and write a complete final
 * report; short enough that a session shutdown cannot stall indefinitely.
 */
export const DEFAULT_SUBAGENT_FINISH_GRACE_MS = 120_000;

/** Resolved graceful-finish policy for one subagent. */
export interface GracefulFinish {
  /** Milliseconds of legitimate working time granted after notification. */
  graceMs: number;
}

/**
 * Resolve the graceful-finish policy from a `SubagentConfig`.
 *
 * `undefined` (the default for every existing spawn) keeps the legacy
 * behavior byte-for-byte: the watchdog preempts/negotiates/aborts exactly as
 * it did before. Only spawns that explicitly opt in get the notify-then-bound
 * lifecycle.
 */
export function resolveGracefulFinish(config: {
  gracefulFinish?: GracefulFinishConfig | undefined;
}): GracefulFinish | undefined {
  const raw = config.gracefulFinish;
  if (raw === undefined || raw === false) return undefined;
  if (raw === true) return { graceMs: DEFAULT_SUBAGENT_FINISH_GRACE_MS };
  const graceMs =
    typeof raw.graceMs === 'number' && Number.isFinite(raw.graceMs) && raw.graceMs > 0
      ? Math.floor(raw.graceMs)
      : DEFAULT_SUBAGENT_FINISH_GRACE_MS;
  return { graceMs };
}

/**
 * The in-band notice the subagent reads between tool calls. Delivered as a
 * `/btw` note, so it arrives at the next iteration boundary — never mid-tool,
 * never as an abort. The wording is deliberately imperative and
 * self-contained: the model must be able to act on it without any other
 * context about why the leader finished. Carried verbatim on the event
 * payload so the core agent loop needs no coordination-layer import to fold
 * it into the conversation.
 */
export function buildSubagentFinishNotice(input: {
  /** Why the finish was requested (e.g. "leader session ended"). */
  reason: string;
  /** Epoch milliseconds by which the final output should be complete. */
  deadlineMs: number;
  /** Granted working-time window in milliseconds. */
  graceMs: number;
}): string {
  const seconds = Math.max(1, Math.round(input.graceMs / 1000));
  const localTime = new Date(input.deadlineMs).toISOString();
  return [
    '[SUBAGENT FINISH] The leader agent has finished its work.',
    `Reason: ${input.reason}`,
    `You have roughly ${seconds} seconds (until ${localTime}) of legitimate working time left.`,
    'Finish your task now, in this turn: complete the thought you are working on, stop',
    'starting new tool calls unless one is strictly required to finish, and write your',
    'final answer or report as your final output, then end your turn.',
    'Do not restart the task and do not begin new work.',
  ].join('\n');
}
