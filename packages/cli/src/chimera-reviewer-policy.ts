import {
  buildReviewerModelPool,
  DEFAULT_REVIEW_FALLBACK_MODELS,
  selectRoundRobinReviewerAssignment,
} from '@wrongstack/core/plugin';
import type { SubagentConfig } from '@wrongstack/core/types';

/**
 * Resolve the fallback-model chain used when spawning the chimera-review
 * reviewer subagent.
 *
 * - When the auto-review bundle already resolved a chain (`reviewFallbackModels`
 *   present), that chain is used verbatim.
 * - Otherwise (manual/ordinary Chimera), fall back to the shared
 *   DEFAULT_REVIEW_FALLBACK_MODELS default from `@wrongstack/core`.
 *
 * Exported so the drift-guard test can assert the exact value the production
 * spawn uses, rather than string-matching source. Shared single constant means
 * the two spawn seams can never diverge and reopen the chimera-review
 * `provider_auth` (1 iter / 0 tools) failure. See fix(auto-review) 623bd441a.
 */
export function resolveReviewerFallbackModels(
  reviewFallbackModels?: readonly string[] | undefined,
  /** Append session ref as a final fallback chain entry. */
  sessionRef?: string,
): string[] {
  const base =
    reviewFallbackModels && reviewFallbackModels.length > 0
      ? [...reviewFallbackModels]
      : [...DEFAULT_REVIEW_FALLBACK_MODELS];
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
 * Builds the pool from the configured primary + fallback chain, then picks
 * the next entry via round-robin. When the pool has <=1 usable entry the
 * original primary/fallbacks are returned unchanged.
 */
export function assignReviewerModelsRoundRobin(
  provider: string,
  model: string,
  fallbackModels: readonly string[],
): { provider: string; model: string; fallbackModels: string[] } {
  const pool = buildReviewerModelPool(provider, model, fallbackModels);
  if (pool.length <= 1) {
    return {
      provider,
      model,
      fallbackModels: [...fallbackModels],
    };
  }
  const assignment = selectRoundRobinReviewerAssignment(
    pool,
    reviewerRoundRobinCursor,
    provider,
    model,
  );
  reviewerRoundRobinCursor = assignment.nextCursor;
  return {
    provider: assignment.provider,
    model: assignment.model,
    fallbackModels: assignment.fallbackModels,
  };
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
  'codebase-search',
  'codebase-stats',
] as const);

export function applyChimeraReviewerReadOnlyPolicy(config: SubagentConfig): SubagentConfig {
  return {
    ...config,
    // A security boundary, not an additive default: discard any inherited
    // mutation tools/capabilities so Chimera reviewers cannot repair files.
    tools: [...CHIMERA_REVIEW_READ_ONLY_TOOLS],
    allowedCapabilities: ['fs.read'],
    worktree: 'off',
  };
}
