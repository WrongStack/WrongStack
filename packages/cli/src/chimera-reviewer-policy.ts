import { parseModelRef } from '@wrongstack/core/agent';
import type { ProviderModelStatusTracker } from '@wrongstack/core/coordination';
import {
  buildReviewerModelPool,
  selectRoundRobinReviewerAssignment,
} from '@wrongstack/core/plugin';
import type { SubagentConfig, SubagentError, TaskResult } from '@wrongstack/core/types';

/**
 * Resolve the fallback-model chain used when spawning the chimera-review
 * reviewer subagent.
 *
 * Auto-review bundles pass the chain already resolved from the active fallback
 * profile/config. Manual and ordinary Chimera reviews do not inject their own
 * hard-coded model list; they rely on the selected session provider/model unless
 * the caller supplies a resolved fallback chain.
 */
export function resolveReviewerFallbackModels(
  reviewFallbackModels?: readonly string[] | undefined,
  /** Append session ref as a final fallback chain entry. */
  sessionRef?: string,
): string[] {
  const base =
    reviewFallbackModels && reviewFallbackModels.length > 0 ? [...reviewFallbackModels] : [];
  if (sessionRef && !base.includes(sessionRef)) {
    base.push(sessionRef);
  }
  return base;
}

/**
 * Process-local round-robin cursor for Chimera reviewer model assignment.
 * Advances on every successful assignment so concurrent/successive reviewers
 * start on different providers and share rate-limit budget across the pool.
 */
let reviewerRoundRobinCursor = 0;

/** Test hook — reset the process-local reviewer round-robin cursor. */
export function __resetReviewerRoundRobinCursor(value = 0): void {
  reviewerRoundRobinCursor = value;
}

/**
 * Assign provider/model/fallbackModels for a Chimera reviewer spawn.
 *
 * Builds the pool from the configured primary + fallback chain, then chooses
 * either the next round-robin entry or a random starting entry. The injected
 * random source keeps the random policy deterministic in tests. When the pool
 * has <=1 usable entry the original primary/fallbacks are returned unchanged.
 *
 * When a {@link ProviderModelStatusTracker} is supplied, blocked entries
 * (waiting-room / token-reset-limit room) are filtered from both the pool
 * and the round-robin pick so a 429-stricken model is never re-spawned on
 * a concurrent reviewer turn. Without the tracker, the legacy pre-waiting-
 * room behavior is preserved.
 */
export function assignReviewerModels(
  provider: string,
  model: string,
  fallbackModels: readonly string[],
  selection: 'round-robin' | 'random' = 'round-robin',
  statusTracker?: ProviderModelStatusTracker | undefined,
  random: () => number = Math.random,
): { provider: string; model: string; fallbackModels: string[] } {
  const pool = buildReviewerModelPool(provider, model, fallbackModels, statusTracker);
  if (pool.length <= 1) {
    return {
      provider,
      model,
      fallbackModels: [...fallbackModels],
    };
  }
  const cursor =
    selection === 'random'
      ? Math.min(pool.length - 1, Math.floor(Math.max(0, random()) * pool.length))
      : reviewerRoundRobinCursor;
  const assignment = selectRoundRobinReviewerAssignment(
    pool,
    cursor,
    provider,
    model,
    statusTracker,
  );
  if (selection === 'round-robin') reviewerRoundRobinCursor = assignment.nextCursor;
  return {
    provider: assignment.provider,
    model: assignment.model,
    fallbackModels: assignment.fallbackModels,
  };
}

/** Backward-compatible round-robin entry point for existing callers. */
export function assignReviewerModelsRoundRobin(
  provider: string,
  model: string,
  fallbackModels: readonly string[],
  statusTracker?: ProviderModelStatusTracker | undefined,
): { provider: string; model: string; fallbackModels: string[] } {
  return assignReviewerModels(provider, model, fallbackModels, 'round-robin', statusTracker);
}

/** One rung of the Chimera reviewer retry ladder. */
export interface ReviewerAttempt {
  provider: string;
  model: string;
  /** In-request fallback chain handled inside the subagent for this rung. */
  fallbackModels: string[];
  /**
   * Where the rung came from — an inherited (unpinned) spawn, the round-robin
   * pick, an entry of the active fallback profile, or the session model kept as
   * the guaranteed last resort.
   */
  tier: 'inherit' | 'primary' | 'fallback' | 'session';
}

/**
 * Hard cap on reviewer spawns for a single review bundle. Every rung costs a
 * full subagent run, so the ladder is bounded — but the session rung is always
 * kept as the final entry no matter where the cap lands.
 */
export const MAX_REVIEWER_ATTEMPTS = 4;

/** Per-attempt wall-clock budget for a reviewer spawn. */
export const REVIEWER_ATTEMPT_TIMEOUT_MS = 900_000;

/**
 * Wall-clock budget for the whole ladder. Session shutdown awaits the pending
 * Chimera work, so retries must not turn a 15-minute worst case into an
 * unbounded one — later rungs draw down whatever is left of this budget.
 */
export const REVIEWER_LADDER_BUDGET_MS = 1_200_000;

/** Below this the ladder stops: too little left for a rung to say anything. */
export const REVIEWER_MIN_ATTEMPT_MS = 120_000;

/**
 * Build the ordered list of reviewer spawns to try for one review bundle.
 *
 * The first rung reproduces today's assignment exactly, so the happy path is
 * unchanged. The rest exist only for the failure path: the assigned chain, then
 * the session's fallback profile, then the session model itself. A review is
 * never abandoned just because one model was unavailable.
 */
export function buildReviewerAttemptLadder(input: {
  assigned: { provider: string; model: string; fallbackModels?: readonly string[] | undefined };
  /** Active fallback profile chain, appended after the assigned chain. */
  profileChain?: readonly string[] | undefined;
  /** Session provider/model — the guaranteed last resort. */
  session: { provider: string; model: string };
  maxAttempts?: number | undefined;
}): ReviewerAttempt[] {
  const assignedChain = [...(input.assigned.fallbackModels ?? [])];
  const profileChain = [...(input.profileChain ?? [])];
  const rungs: ReviewerAttempt[] = [];
  const seen = new Set<string>();

  const key = (provider: string, model: string): string => `${provider.trim()}/${model.trim()}`;
  const push = (
    provider: string,
    model: string,
    fallbackModels: string[],
    tier: ReviewerAttempt['tier'],
  ): void => {
    const p = provider.trim();
    const m = model.trim();
    // A rung without a provider spawns a bare model id that 401s on
    // multi-provider hosts — drop it rather than burn an attempt on it.
    if (!p || !m) return;
    if (seen.has(key(p, m))) return;
    seen.add(key(p, m));
    rungs.push({ provider: p, model: m, fallbackModels, tier });
  };

  push(input.assigned.provider, input.assigned.model, [...assignedChain], 'primary');

  for (const [chain, tier] of [
    [assignedChain, 'fallback'],
    [profileChain, 'fallback'],
  ] as const) {
    for (let i = 0; i < chain.length; i++) {
      const parsed = parseModelRef(chain[i]!);
      // Keep the rest of the chain so a rung can still self-heal in-request
      // before the ladder pays for another spawn.
      push(parsed.provider ?? '', parsed.model, chain.slice(i + 1), tier);
    }
  }

  const sessionKey = key(input.session.provider, input.session.model);
  push(input.session.provider, input.session.model, [], 'session');

  const cap = Math.max(1, Math.floor(input.maxAttempts ?? MAX_REVIEWER_ATTEMPTS));
  if (rungs.length <= cap) return rungs;

  const trimmed = rungs.slice(0, cap);
  // The session model is the contract's guaranteed last resort. If the cap
  // pushed it off the ladder it replaces the final rung rather than vanishing.
  if (!trimmed.some((r) => key(r.provider, r.model) === sessionKey)) {
    const sessionRung = rungs.find((r) => key(r.provider, r.model) === sessionKey);
    if (sessionRung) trimmed[trimmed.length - 1] = sessionRung;
  }
  return trimmed;
}

/**
 * Cap for the mutating Chimera agents (fix, cascade). Deliberately tighter than
 * the reviewer's: those agents edit files, so every extra rung re-enters a tree
 * a dead attempt may already have touched. One retry recovers the common case
 * (primary model down or rate-limited) without compounding that risk.
 */
export const MAX_MUTATING_ATTEMPTS = 2;

/**
 * Ladder for a mutating Chimera agent (fix / cascade).
 *
 * Rung 0 deliberately carries no provider/model: those spawns inherit the role
 * model matrix, and pinning a model here would silently override it. Later
 * rungs name a model precisely because the inherited one just failed.
 */
export function buildMutatingAgentLadder(input: {
  profileChain?: readonly string[] | undefined;
  session: { provider: string; model: string };
  maxAttempts?: number | undefined;
}): ReviewerAttempt[] {
  const cap = Math.max(1, Math.floor(input.maxAttempts ?? MAX_MUTATING_ATTEMPTS));
  const inherit: ReviewerAttempt = {
    provider: '',
    model: '',
    fallbackModels: [],
    tier: 'inherit',
  };
  if (cap === 1) return [inherit];
  return [
    inherit,
    ...buildReviewerAttemptLadder({
      assigned: { provider: '', model: '' },
      profileChain: input.profileChain,
      session: input.session,
      maxAttempts: cap - 1,
    }),
  ];
}

/**
 * Should the ladder move to the next rung after this outcome?
 *
 * Anything short of success is worth another model — that is the whole point
 * of the ladder. The exceptions are deliberate stops: a terminated subagent
 * (`stopped`) and a parent abort (Ctrl+C, session teardown), where spawning a
 * replacement would fight the thing that asked us to stop.
 */
export function shouldAdvanceReviewerLadder(
  status: TaskResult['status'] | undefined,
  error?: Pick<SubagentError, 'kind'> | undefined,
): boolean {
  if (status === 'success') return false;
  if (status === 'stopped') return false;
  if (error?.kind === 'aborted_by_parent') return false;
  return true;
}

/**
 * Timeout for the next rung: the per-attempt budget, clamped to whatever is
 * left of the ladder budget. Returns 0 when the ladder should stop.
 */
export function reviewerAttemptTimeoutMs(
  remainingMs: number,
  attemptTimeoutMs: number = REVIEWER_ATTEMPT_TIMEOUT_MS,
  minAttemptMs: number = REVIEWER_MIN_ATTEMPT_MS,
): number {
  if (remainingMs < minAttemptMs) return 0;
  return Math.min(attemptTimeoutMs, Math.floor(remainingMs));
}

/**
 * Chimera reviewers only inspect code and return a report. They never repair
 * files themselves; bug-hunter/security-scanner/fix agents own all mutations.
 */
export const CHIMERA_REVIEW_READ_ONLY_TOOLS = Object.freeze([
  'read',
  'grep',
  'glob',
  'tree',
  'codebase-stats',
  'codebase-search',
  'codebase-skeleton',
  'codebase-repo-map',
  'codebase-incoming-calls',
  'codebase-outgoing-calls',
] as const);

export function applyChimeraReviewerReadOnlyPolicy(config: SubagentConfig): SubagentConfig {
  return {
    ...config,
    // A security boundary, not an additive default: discard any inherited
    // mutation tools/capabilities so Chimera reviewers cannot repair files.
    tools: [...CHIMERA_REVIEW_READ_ONLY_TOOLS],
    allowedCapabilities: ['fs.read'],
    worktree: 'off',
    // Mandatory model-driven completion: a reviewer must never be killed by
    // the wall-clock watchdog. At its deadline (or when the leader's session
    // ends and `Director.requestFinish()` fires) it receives an in-band
    // `subagent.finish_requested` notification between tool batches and
    // finishes its report in its own turn within the granted grace window.
    // Only if that window also elapses does the terminal stop apply — the
    // reviewer's bounded maximum lifetime.
    gracefulFinish: true,
  };
}
