import type { Context } from '../core/context.js';

import {
  readRealAnchoredContextTokens,
  requestTokenBasisStillCurrent,
} from '../core/context-usage-anchor.js';

import {
  estimateRequestTokensCalibrated,
  estimateRequestTokensUpperBound,
  getCalibrationState,
} from '../utils/token-estimate.js';

export interface CompactionTokenEstimationHost {
  stateFor: (ctx: Context) => AutoCompactionState;
  _estimator: ((ctx: Context) => number) | undefined;
}
export function estimateContextTokens(
  host: CompactionTokenEstimationHost,
  ctx: Context,
): { tokens: number; exact: boolean } {
  const state = host.stateFor(ctx);
  const msgCount = ctx.messages.length;
  const toolCount = (ctx.tools ?? []).length;
  const revision = ctx.state?.revision ?? -1;

  // Prefer the REAL usage anchor: compaction decisions run against the
  // provider's authoritative prompt-token count (+ the delta of unsent
  // messages), not a scaled estimate. Only the newest turn is estimated;
  // everything else is exact. Falls through to the estimate paths before
  // the first response or right after compaction shrank the array.
  const anchored = readRealAnchoredContextTokens(ctx);
  if (anchored !== null) {
    // The provider count is real. Do not replace it with a density estimate
    // of history the provider already billed. Only an unsent suffix is still
    // an estimate, and only that suffix gets the upper bound.
    return { tokens: tokensFromAnchor(ctx, anchored), exact: true };
  }
  // Custom estimator — never cache; call fresh every invocation.
  if (host._estimator) return { tokens: host._estimator(ctx), exact: false };
  const calibrationKey = `${ctx.provider?.id ?? 'unknown'}/${ctx.model}`;
  const cal = getCalibrationState(calibrationKey);
  if (
    calibrationKey === state._cachedCalibrationKey &&
    cal.ratio === state._cachedCalibrationRatio &&
    cal.calibrated === state._cachedCalibrated &&
    msgCount === state._cachedMsgCount &&
    toolCount === state._cachedToolCount &&
    revision === state._cachedRevision &&
    ctx.systemPrompt === state._cachedSystemRef &&
    ctx.tools === state._cachedToolsRef &&
    state._cachedTokens >= 0
  ) {
    // Default estimator, context unchanged — reuse cached value.
    return { tokens: state._cachedTokens, exact: false };
  }

  const stashed = tryStashedTokens(ctx, msgCount, toolCount, revision);
  let tokens: number;
  if (stashed !== null) {
    // H1: the agent loop's pre-flight (or its restash in emitContextPct)
    // populated `ctx.lastRequestTokens` this iteration. Apply the
    // per-(provider,model) calibration ratio and use it. This avoids
    // a third redundant O(n) walk per iteration.
    tokens = cal.calibrated
      ? Math.round(stashed * Math.min(1.5, Math.max(0.5, cal.ratio)))
      : stashed;
  } else {
    // Default estimator, context changed and no stash — compute fresh
    // and cache. Cold-start path: very first iteration, or the
    // middleware is being driven from somewhere that didn't run the
    // agent loop's pre-flight (tests, manual compaction trigger).
    tokens = estimateRequestTokensCalibrated(
      ctx.messages,
      ctx.systemPrompt,
      ctx.tools ?? [],
      `${ctx.provider?.id ?? 'unknown'}/${ctx.model}`,
    ).total;
  }
  state._cachedCalibrationKey = calibrationKey;
  state._cachedCalibrationRatio = cal.ratio;
  state._cachedCalibrated = cal.calibrated;
  state._cachedTokens = tokens;
  state._cachedMsgCount = msgCount;
  state._cachedToolCount = toolCount;
  state._cachedRevision = revision;
  state._cachedSystemRef = ctx.systemPrompt;
  state._cachedToolsRef = ctx.tools;
  return { tokens, exact: false };
}

export function tokensFromAnchor(ctx: Context, anchored: number): number {
  const covered = ctx.meta?.['realAnchorMsgCount'];
  const prefix = ctx.lastRealInputTokens;
  if (
    typeof covered !== 'number' ||
    !Number.isFinite(covered) ||
    typeof prefix !== 'number' ||
    !Number.isFinite(prefix) ||
    covered < 0 ||
    covered >= ctx.messages.length
  ) {
    return anchored;
  }
  const suffixUpper = estimateRequestTokensUpperBound(
    ctx.messages.slice(covered),
    [],
    [],
    `${ctx.provider?.id ?? 'unknown'}/${ctx.model}`,
  ).total;
  return prefix + suffixUpper;
}

export function tryStashedTokens(
  ctx: Context,
  msgCount: number,
  toolCount: number,
  revision: number,
): number | null {
  if (!requestTokenBasisStillCurrent(ctx)) return null;
  const stashed = ctx.lastRequestTokens;
  if (typeof stashed !== 'number' || !Number.isFinite(stashed) || stashed <= 0) return null;
  // The agent loop writes the (msg, tool) count it computed the stash at
  // into ctx.meta['lastRequestTokensAt']. When the counts disagree the
  // caller has already recomputed and refreshed the stash, but we verify
  // the meta key exists for safety — older code paths and tests may set
  // lastRequestTokens without the companion entry.
  const stashedAt = ctx.meta?.['lastRequestTokensAt'];
  if (typeof stashedAt !== 'object' || stashedAt === null) return null;
  const meta = stashedAt as { msgCount?: unknown; toolCount?: unknown; revision?: unknown };
  if (meta.msgCount !== msgCount) return null;
  if (typeof meta.toolCount === 'number' && meta.toolCount !== toolCount) return null;
  // A same-length replaceMessages() rewrite is invisible to count-only
  // stamps. Require the ConversationState revision that produced the stash;
  // legacy stamps without it are treated as untrusted and recomputed once.
  if (meta.revision !== revision) return null;
  return stashed;
}

import type { AutoCompactionState } from './auto-compaction-state.js';
