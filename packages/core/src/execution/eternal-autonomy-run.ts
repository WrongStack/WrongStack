/**
 * One directive run for EternalAutonomyEngine: the bounded agent.run call,
 * its outcome classification, and the per-iteration usage delta. Also the
 * completion markers the engine scans for. Split out of eternal-autonomy.ts.
 */
import type { JournalEntry } from '../storage/goal-store.js';
import { toErrorMessage } from '../utils/error.js';
import type { EternalAutonomyOptions } from './eternal-autonomy-types.js';

export interface DecidedAction {
  source: JournalEntry['source'];
  task: string;
  directive: string;
  /** Set when source === 'todo' so the engine can attribute failures. */
  todoId?: string | undefined;
}

/**
 * Free-text marker the model can emit (on its own line) to declare the
 * overall mission accomplished. Detected in the successful iteration's
 * `finalText`. When present, the engine flips `goalState='completed'`
 * and stops — the model has explicitly claimed completion AND the
 * iteration succeeded, which together is the most reliable stop signal
 * we can get without a separate verifier round-trip.
 */
export const GOAL_COMPLETE_MARKER = /^\s*\[goal[_\s-]*complete\]\s*$/im;
/** Optional per-deliverable completion marker consumed by the coordination loop. */
export const DONE_DELIVERABLE_MARKER = /\[done:\s*[^\]]+\]/i;

/**
 * Free-text marker for the `/goal clear` command equivalent — when the
 * model emits this, the engine treats it as a manual goal clear (not just
 * completion) so the goal file is removed and onEternalStop fires.
 */
export const GOAL_CLEAR_MARKER = /^\s*\[\/?goal\s*clear\]\s*$/im;

export interface DirectiveOutcome {
  status: JournalEntry['status'];
  note: string | undefined;
  finalText: string;
  isTransientFailure: boolean;
}

/** Run one directive through `agent.run` and classify the result. */
export async function runDirective(
  agent: EternalAutonomyOptions['agent'],
  directive: string,
  signal: AbortSignal,
  maxAgentSteps: number,
): Promise<DirectiveOutcome> {
  let status: JournalEntry['status'] = 'success';
  let note: string | undefined;
  let finalText = '';
  // Captured from `result.error?.recoverable` when the agent.run returns
  // a recoverable WrongStackError (ProviderError sets this for 429/529
  // /5xx/network). Drives the engine's exponential backoff so a
  // transient rate-limit storm doesn't burn the failure budget in
  // seconds. Permanent errors leave this false and trip the normal
  // consecutiveFailures path.
  let isTransientFailure = false;

  try {
    const result = await agent.run([{ type: 'text' as const, text: directive }], {
      signal,
      // Enable per-call autonomous continuation so the agent can chain
      // multiple internal tool/response cycles end-to-end on one
      // directive instead of returning to the engine after a single
      // round-trip. The model uses `[continue]` / `[done]` markers
      // (or the `continue_to_next_iteration` tool) to control the
      // inner loop. Without this flag the engine produced shallow
      // iterations and almost never let a real task finish.
      autonomousContinue: true,
      // Cap the inner loop so a runaway agent.run can't burn through
      // the iteration timeout — the engine's own outer loop is the
      // long-running thing, each tick should be bounded.
      maxIterations: maxAgentSteps,
    });

    if (result.status === 'aborted') {
      status = 'aborted';
      note = 'stopped by user';
    } else if (result.status === 'failed') {
      status = 'failure';
      note = result.error?.describe?.() ?? 'agent run failed';
      isTransientFailure = result.error?.recoverable === true;
    } else if (result.status === 'max_iterations') {
      status = 'failure';
      note = `max iterations (${result.iterations})`;
    } else {
      status = 'success';
      finalText = result.finalText ?? '';
      const tail = finalText.slice(0, 240).replace(/\s+/g, ' ').trim();
      if (tail) note = tail;
    }
  } catch (err) {
    const isAbort =
      err instanceof Error && (err.name === 'AbortError' || err.message.includes('abort'));
    status = isAbort ? 'aborted' : 'failure';
    note = toErrorMessage(err);
    // Surface .recoverable on the thrown WrongStackError too — provider
    // errors that escape the agent's catch (rare; usually wrapped into
    // result.error) still classify correctly.
    if (
      !isAbort &&
      typeof (err as { recoverable?: unknown | undefined })?.recoverable === 'boolean'
    ) {
      isTransientFailure = (err as { recoverable: boolean }).recoverable;
    }
  }
  return { status, note, finalText, isTransientFailure };
}

/**
 * Capture per-iteration usage delta. Cost is always non-negative;
 * if the counter wraps or resets mid-iteration we clamp to 0 so the
 * journal never shows negative spend.
 */
export function iterationUsageDelta(
  beforeUsage: { input: number; output: number } | undefined,
  afterUsage: { input: number; output: number } | undefined,
  beforeCost: number | undefined,
  afterCost: number | undefined,
): {
  tokens: { input: number; output: number } | undefined;
  costUsd: number | undefined;
} {
  const tokens =
    beforeUsage && afterUsage
      ? {
          input: Math.max(0, afterUsage.input - beforeUsage.input),
          output: Math.max(0, afterUsage.output - beforeUsage.output),
        }
      : undefined;
  const costUsd =
    typeof beforeCost === 'number' && typeof afterCost === 'number'
      ? Math.max(0, afterCost - beforeCost)
      : undefined;
  return { tokens, costUsd };
}

/**
 * Whether the engine should compact now: every `compactEveryNIterations`
 * iterations (default 25), or aggressively once the current request fills
 * `aggressiveCompactRatio` (default 0.85) of `maxContextTokens`.
 */
export function compactionDue(
  opts: Pick<
    EternalAutonomyOptions,
    'compactEveryNIterations' | 'aggressiveCompactRatio' | 'maxContextTokens'
  >,
  ctx: EternalAutonomyOptions['agent']['ctx'],
  iterationsSinceCompact: number,
): { aggressive: boolean } | null {
  const maxCtx = opts.maxContextTokens;
  if (maxCtx && maxCtx > 0) {
    const used = ctx.tokenCounter?.currentRequestTokens?.();
    if (used) {
      const total = used.input + used.cacheRead + used.cacheWrite;
      if (total / maxCtx >= (opts.aggressiveCompactRatio ?? 0.85)) return { aggressive: true };
    }
  }
  return iterationsSinceCompact >= (opts.compactEveryNIterations ?? 25)
    ? { aggressive: false }
    : null;
}
