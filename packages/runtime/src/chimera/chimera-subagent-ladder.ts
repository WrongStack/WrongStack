import { randomUUID } from 'node:crypto';
import type { SubagentConfig, SubagentTaskUsage, TaskResult } from '@wrongstack/contracts/types';
import type { Director as FleetDirector } from '@wrongstack/coordination';
import { toErrorMessage } from '@wrongstack/core/utils';
import {
  REVIEWER_ATTEMPT_TIMEOUT_MS,
  REVIEWER_LADDER_BUDGET_MS,
  REVIEWER_MIN_ATTEMPT_MS,
  type ReviewerAttempt,
  reviewerAttemptTimeoutMs,
  shouldAdvanceReviewerLadder,
} from './chimera-reviewer-policy.js';

type Director = Pick<FleetDirector, 'spawn' | 'assign' | 'awaitTasks' | 'terminate'>;

/** Display form of a rung — `inherit` rungs have no model of their own. */
export function attemptLabel(attempt: ReviewerAttempt): string {
  return attempt.tier === 'inherit' ? 'inherited model' : `${attempt.provider}/${attempt.model}`;
}

/** What went wrong on one rung of a Chimera subagent ladder. */
export interface LadderAttemptFailure {
  /** `provider/model`, or `inherited model` for an unpinned rung. */
  model: string;
  tier: ReviewerAttempt['tier'];
  /** 1-based rung index. */
  attempt: number;
  /** Human-readable failure summary. */
  reason: string;
  /** True when the rung threw instead of returning a result. */
  threw: boolean;
  /** Tool calls the rung made before dying — non-zero means it may have acted. */
  toolCalls: number;
}

interface LadderRunOutcome {
  /** Terminal result, when a rung produced one. */
  result?: TaskResult | undefined;
  /** Winning subagent, left alive only when `keepWinnerAlive` is set. */
  subagentId?: string | undefined;
  /** 1-based index of the rung that succeeded. */
  wonAt?: number | undefined;
  attemptsUsed: number;
  failures: LadderAttemptFailure[];
  /** Exception from the final rung, when it threw rather than returned. */
  lastError?: unknown;
  /** Cumulative token & cost spend across all attempted rungs. */
  accumulatedUsage?: SubagentTaskUsage | undefined;
  /** Total iterations across all attempted rungs. */
  totalIterations?: number | undefined;
  /** Total tool calls across all attempted rungs. */
  totalToolCalls?: number | undefined;
  /** Total wall-clock duration across all attempted rungs. */
  totalDurationMs?: number | undefined;
}

interface LadderRunOptions {
  director: Director;
  ladder: readonly ReviewerAttempt[];
  /** Build the spawn config for a rung. Must apply the rung's model itself. */
  buildConfig: (attempt: ReviewerAttempt, timeoutMs: number) => SubagentConfig;
  /**
   * Build the task text. Receives the failures so far so a mutating agent can
   * be warned that the tree may already hold a dead attempt's partial edits.
   */
  buildTask: (attempt: ReviewerAttempt, failures: readonly LadderAttemptFailure[]) => string;
  /** Per-rung wall-clock budget. */
  attemptTimeoutMs?: number | undefined;
  /** Wall-clock budget for the whole ladder — bounds session shutdown. */
  budgetMs?: number | undefined;
  /**
   * Leave the winning subagent alive for the caller to retire. Failed rungs are
   * always terminated immediately regardless.
   */
  keepWinnerAlive?: boolean | undefined;
  onAttemptFailed?: (
    failure: LadderAttemptFailure,
    next: ReviewerAttempt | undefined,
  ) => void | Promise<void>;
  onRecovered?: (
    attempt: ReviewerAttempt,
    failures: readonly LadderAttemptFailure[],
  ) => void | Promise<void>;
  /** Injectable clock — tests drive the budget without real waiting. */
  now?: () => number;
}

/**
 * Run one task down a ladder of models until it succeeds.
 *
 * A Chimera agent must never be abandoned because a single model was
 * unavailable: every rung short of a deliberate stop (`stopped` status, parent
 * abort) advances to the next model, ending on the session model. The ladder is
 * bounded by both rung count and wall clock — session shutdown awaits this work.
 */
export async function runSubagentModelLadder(opts: LadderRunOptions): Promise<LadderRunOutcome> {
  const {
    director: dir,
    ladder,
    buildConfig,
    buildTask,
    attemptTimeoutMs = REVIEWER_ATTEMPT_TIMEOUT_MS,
    budgetMs = REVIEWER_LADDER_BUDGET_MS,
    keepWinnerAlive = false,
    onAttemptFailed,
    onRecovered,
    now = Date.now,
  } = opts;

  const startedAt = now();
  const failures: LadderAttemptFailure[] = [];
  const outcome: LadderRunOutcome = { attemptsUsed: 0, failures };
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalCostUsd = 0;
  let hasUsage = false;
  let totalIterations = 0;
  let totalToolCalls = 0;
  let totalDurationMs = 0;

  const foldAttemptMetrics = (res: TaskResult | undefined): void => {
    if (!res) return;
    if (typeof res.iterations === 'number' && Number.isFinite(res.iterations)) {
      totalIterations += res.iterations;
    }
    if (typeof res.toolCalls === 'number' && Number.isFinite(res.toolCalls)) {
      totalToolCalls += res.toolCalls;
    }
    if (typeof res.durationMs === 'number' && Number.isFinite(res.durationMs)) {
      totalDurationMs += res.durationMs;
    }
    if (res.usage) {
      hasUsage = true;
      totalInput += res.usage.inputTokens;
      totalOutput += res.usage.outputTokens;
      totalCacheRead += res.usage.cacheReadTokens ?? 0;
      totalCacheWrite += res.usage.cacheWriteTokens ?? 0;
      totalCostUsd += res.usage.costUsd;
    }
    outcome.totalIterations = totalIterations;
    outcome.totalToolCalls = totalToolCalls;
    outcome.totalDurationMs = totalDurationMs;
    if (hasUsage) {
      outcome.accumulatedUsage = {
        inputTokens: totalInput,
        outputTokens: totalOutput,
        ...(totalCacheRead > 0 ? { cacheReadTokens: totalCacheRead } : {}),
        ...(totalCacheWrite > 0 ? { cacheWriteTokens: totalCacheWrite } : {}),
        totalTokens: totalInput + totalOutput,
        costUsd: totalCostUsd,
      };
    }
  };

  for (let rung = 0; rung < ladder.length; rung++) {
    const attempt = ladder[rung]!;
    const timeoutMs = reviewerAttemptTimeoutMs(
      budgetMs - (now() - startedAt),
      attemptTimeoutMs,
      REVIEWER_MIN_ATTEMPT_MS,
    );
    if (timeoutMs === 0) {
      outcome.lastError = new Error(
        `ladder budget exhausted after ${outcome.attemptsUsed} attempt(s)`,
      );
      break;
    }

    outcome.attemptsUsed++;
    let subagentId: string | undefined;
    let attemptResult: TaskResult | undefined;
    let attemptError: unknown;
    try {
      subagentId = await dir.spawn(buildConfig(attempt, timeoutMs));
      const taskId = randomUUID();
      await dir.assign({
        id: taskId,
        description: buildTask(attempt, failures),
        subagentId,
      });
      attemptResult = (await dir.awaitTasks([taskId]))[0];
    } catch (err) {
      attemptError = err;
    }
    foldAttemptMetrics(attemptResult);

    if (!attemptError && attemptResult?.status === 'success') {
      outcome.result = attemptResult;
      outcome.wonAt = rung + 1;
      outcome.lastError = undefined;
      if (keepWinnerAlive) {
        outcome.subagentId = subagentId;
      } else if (subagentId) {
        await terminateQuietly(dir, subagentId);
      }
      if (rung > 0) await onRecovered?.(attempt, failures);
      return outcome;
    }

    // This rung is spent — retire its subagent before spawning the next.
    if (subagentId) await terminateQuietly(dir, subagentId);

    outcome.result = attemptResult;
    outcome.lastError = attemptError;
    const failure: LadderAttemptFailure = {
      model: attemptLabel(attempt),
      tier: attempt.tier,
      attempt: rung + 1,
      reason: attemptError
        ? errorText(attemptError)
        : `${attemptResult?.status ?? 'unknown'}: ${attemptResult?.error?.message ?? 'no result'}`,
      threw: attemptError !== undefined,
      toolCalls: attemptResult?.toolCalls ?? 0,
    };
    failures.push(failure);

    const canAdvance = attemptError
      ? true
      : shouldAdvanceReviewerLadder(attemptResult?.status, attemptResult?.error);
    const next = canAdvance ? ladder[rung + 1] : undefined;
    await onAttemptFailed?.(failure, next);
    if (!next) break;
  }

  return outcome;
}

/**
 * Preamble for a mutating agent's retry: the tree may already hold a dead
 * attempt's edits, so the successor must re-read before it writes.
 */
export function buildRetryPreamble(failures: readonly LadderAttemptFailure[]): string {
  if (failures.length === 0) return '';
  const mayHaveWritten = failures.some((f) => f.threw || f.toolCalls > 0);
  const history = failures.map((f) => `${f.model} (${f.reason})`).join('; ');
  return [
    `⚠ RETRY — ${failures.length} previous attempt(s) failed: ${history}.`,
    mayHaveWritten
      ? 'Those attempts may have already applied part of this work, so the working tree can be in a half-finished state. Re-read every file before you change it and treat any fix that is already present as done — do not apply it twice.'
      : 'They made no tool calls, so the working tree is untouched.',
    '',
  ].join('\n');
}

function errorText(err: unknown): string {
  return toErrorMessage(err);
}

async function terminateQuietly(dir: Director, subagentId: string): Promise<void> {
  try {
    await dir.terminate(subagentId);
  } catch {
    /* best-effort — subagent may already be gone */
  }
}
