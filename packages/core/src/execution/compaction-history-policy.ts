import type { CompactReport } from '@wrongstack/contracts/types/compactor';
import type { Context } from '../core/context.js';
import type { PressureLevel } from './compaction-thresholds.js';
import { effectiveMaxContext, LEVEL_RANK } from './compaction-thresholds.js';

export interface CompactionHistoryPolicyHost {
  stateFor: (
    ctx: import('../core/context.js').Context,
  ) => import('./auto-compaction-state.js').AutoCompactionState;
  hygieneInterval: (
    availableInputTokens: number,
    thresholds: { warn: number; hard: number },
  ) => number;
  resolvePreserveK: (ctx: import('../core/context.js').Context) => number;
  _maxContext: number;
}

export function shouldRunHygiene(
  this: CompactionHistoryPolicyHost,
  ctx: Context,
  level: PressureLevel,
  tokens: number,
  availableInputTokens: number,
  thresholds: { warn: number; hard: number },
): boolean {
  if (level === 'hard') return true;
  const last = this.stateFor(ctx).lastHygieneTokens;
  if (last === null) return true;
  // Compaction or a rewind can shrink the context below the last anchor.
  // Re-anchor on the smaller size instead of banking the drop as growth
  // that has already been spent.
  const anchor = Math.min(last, tokens);
  this.stateFor(ctx).lastHygieneTokens = anchor;
  return tokens - anchor >= this.hygieneInterval(availableInputTokens, thresholds);
}

export function hygieneInterval(
  this: CompactionHistoryPolicyHost,
  availableInputTokens: number,
  thresholds: { warn: number; hard: number },
): number {
  const fractional = Math.max(1, Math.floor(availableInputTokens * HYGIENE_GROWTH_RATIO));
  const gap = Math.max(
    1,
    Math.floor(availableInputTokens * thresholds.hard) -
      Math.ceil(availableInputTokens * thresholds.warn),
  );
  if (HYGIENE_MIN_GROWTH_TOKENS <= gap) {
    return Math.max(HYGIENE_MIN_GROWTH_TOKENS, fractional);
  }
  return fractional;
}

export function invalidateTokenCaches(this: CompactionHistoryPolicyHost, ctx: Context): void {
  const state = this.stateFor(ctx);
  ctx.lastRequestTokens = undefined;
  ctx.lastRealInputTokens = undefined;
  delete ctx.meta['lastRequestTokensAt'];
  delete ctx.meta['realAnchorMsgCount'];
  state._cachedTokens = -1;
  state._cachedMsgCount = -1;
  state._cachedToolCount = -1;
  state._cachedRevision = -1;
  state._cachedSystemRef = null;
  state._cachedToolsRef = null;
}

export function shouldSkipNoopRetry(
  this: CompactionHistoryPolicyHost,
  ctx: Context,
  level: PressureLevel,
  tokens: number,
): boolean {
  // Hard pressure must still pass the overflow check on every retry.
  if (level === 'hard') return false;
  const stuck = this.stateFor(ctx).lastNoopAttempt;
  if (!stuck) return false;
  // Escalation always retries — soft → hard might be reducible aggressively.
  if (LEVEL_RANK[level] > LEVEL_RANK[stuck.level]) return false;
  return Math.abs(tokens - stuck.tokens) < NOOP_RETRY_DELTA_TOKENS;
}

export function recordAttempt(
  this: CompactionHistoryPolicyHost,
  ctx: Context,
  level: PressureLevel,
  tokens: number,
  report: CompactReport,
): void {
  // Prefer full-request tokens (accurate); fall back to message-only before/after.
  const before = report.fullRequestTokensBefore ?? report.before;
  const after = report.fullRequestTokensAfter ?? report.after;
  const saved = before - after;
  const minimumUsefulSaving = Math.max(
    MIN_EFFECTIVE_REDUCTION_TOKENS,
    Math.ceil(before * MIN_EFFECTIVE_REDUCTION_RATIO),
  );
  const reduced = saved >= minimumUsefulSaving;
  const repaired = !!report.repaired;
  if (reduced || repaired) {
    this.stateFor(ctx).lastNoopAttempt = null;
  } else {
    this.stateFor(ctx).lastNoopAttempt = { level, tokens };
  }
}

export function resolvePreserveK(this: CompactionHistoryPolicyHost, ctx: Context): number {
  const policy = ctx.meta?.['contextWindowPolicy'];
  const k =
    policy && typeof policy === 'object'
      ? (policy as { preserveK?: unknown }).preserveK
      : undefined;
  return typeof k === 'number' && k > 0 ? Math.floor(k) : 6;
}

export function resolveToolResultRetention(
  this: CompactionHistoryPolicyHost,
  ctx: Context,
): number {
  const policy = ctx.meta?.['contextWindowPolicy'];
  const threshold =
    policy && typeof policy === 'object'
      ? (policy as { eliseThreshold?: unknown }).eliseThreshold
      : undefined;
  const perResultBaseline =
    typeof threshold === 'number' && Number.isFinite(threshold) && threshold >= 0
      ? Math.floor(threshold)
      : 1_200;
  const desired = perResultBaseline * this.resolvePreserveK(ctx);
  const contextCap = Math.max(
    perResultBaseline,
    Math.floor(effectiveMaxContext(ctx, this._maxContext) * 0.12),
  );
  return Math.max(perResultBaseline, Math.min(desired, contextCap));
}

export function resolveToolReceiptRetention(
  this: CompactionHistoryPolicyHost,
  ctx: Context,
): number {
  return Math.min(96, Math.max(16, this.resolvePreserveK(ctx) * 4));
}

const NOOP_RETRY_DELTA_TOKENS = 2_000;

const MIN_EFFECTIVE_REDUCTION_TOKENS = 1_000;

const MIN_EFFECTIVE_REDUCTION_RATIO = 0.005;

const HYGIENE_GROWTH_RATIO = 0.15;

const HYGIENE_MIN_GROWTH_TOKENS = 20_000;
