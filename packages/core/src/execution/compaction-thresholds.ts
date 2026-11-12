import type { Context } from '../core/context.js';
import {
  CONTEXT_REQUEST_OVERHEAD_META,
  type ContextRequestOverhead,
  type ContextWindowBudgetSnapshot,
  computeContextWindowBudget,
} from '../utils/context-budget.js';
import { repeatedReadPressure } from '../utils/context-evidence.js';
import {
  adjustLadderForPriceCliff,
  priceCliffRouteForContext,
  readPriceCliffForRoute,
} from '../utils/price-cliff.js';

export type PressureLevel = 'warn' | 'soft' | 'hard';
export const LEVEL_RANK: Record<PressureLevel, number> = { warn: 0, soft: 1, hard: 2 };

/**
 * The price-cliff cap the compaction ladder ACTUALLY applied for a pass.
 *
 * Recorded at decision time in the middleware and forwarded verbatim to the
 * `compaction.fired` event and the session record, so the WebUI, the Session
 * Story timeline and the `/context cliff` report all name the same boundary
 * that fired. Reporting must never recompute a budget: some provider routes
 * already pre-subtract the output reserve before the middleware subtracts it
 * again, so a second derivation can report a different number than the one
 * that triggered the compaction.
 */
export interface AppliedPriceCliff {
  /** The published long-context boundary, in tokens. */
  cliffTokens: number;
  /** Absolute token point the ladder fired at because of the cliff. */
  triggerTokens: number;
}

export function pressureLevelFor(
  load: number,
  thresholds: { warn: number; soft: number; hard: number },
): PressureLevel | null {
  if (load >= thresholds.hard) return 'hard';
  if (load >= thresholds.soft) return 'soft';
  if (load >= thresholds.warn) return 'warn';
  return null;
}

export function effectiveMaxContext(ctx: Context, configured: number): number {
  const learned = ctx.meta?.['effectiveMaxContext'];
  if (typeof learned === 'number' && Number.isFinite(learned) && learned > 0) {
    return Math.floor(learned);
  }
  const providerMax = ctx.provider?.capabilities?.maxContext;
  if (typeof providerMax === 'number' && Number.isFinite(providerMax) && providerMax > 0) {
    return Math.floor(providerMax);
  }
  return configured;
}

export function contextWindowBudget(
  ctx: Context,
  inputTokens: number,
  maxContext: number,
): ContextWindowBudgetSnapshot {
  return computeContextWindowBudget({
    maxContext,
    inputTokens,
    maxOutput: ctx.provider?.capabilities?.maxOutput,
    outputReserveTokens: readPositiveMetaNumber(ctx, 'contextOutputReserveTokens'),
    safetyBufferTokens: readPositiveMetaNumber(ctx, 'contextSafetyBufferTokens'),
    // Set by the agent loop from the last prepared request: what the request
    // pipeline adds beyond the durable transcript this pass measures.
    requestOverheadTokens: readRequestOverhead(ctx),
  });
}

function readRequestOverhead(ctx: Context): number | undefined {
  const value = ctx.meta?.[CONTEXT_REQUEST_OVERHEAD_META] as
    | Partial<ContextRequestOverhead>
    | undefined;
  if (!value || typeof value !== 'object') return undefined;
  // Measured for one route; another provider/model has different wire content.
  if (value.routeKey !== `${ctx.provider?.id ?? 'unknown'}/${ctx.model}`) return undefined;
  const tokens = value.tokens;
  return typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0
    ? Math.floor(tokens)
    : undefined;
}

function readPositiveMetaNumber(ctx: Context, key: string): number | undefined {
  const value = ctx.meta?.[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

/** Built-in ladder used to replace any threshold that cannot be honored. */
const DEFAULT_THRESHOLDS = { warn: 0.55, soft: 0.7, hard: 0.85 } as const;

/**
 * Make a threshold triple usable by {@link pressureLevelFor}, which tests
 * hard -> soft -> warn and therefore assumes `warn <= soft <= hard`, all
 * finite. Nothing upstream enforces that: `resolveContextWindowPolicy` passes
 * `config.warnThreshold` / `softThreshold` / `hardThreshold` through verbatim,
 * so a config typo can invert the ladder (a mild load classified 'hard') or a
 * non-numeric value can make every comparison false, disabling compaction at
 * ANY load. Both fail silently in the subsystem that owns the no-overflow
 * guarantee, so unusable values fall back to the built-in ladder and the
 * ordering is enforced.
 */
export function sanitizeThresholds(thresholds: { warn: number; soft: number; hard: number }): {
  warn: number;
  soft: number;
  hard: number;
} {
  const usable = (value: number, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1
      ? value
      : fallback;
  const warn = usable(thresholds.warn, DEFAULT_THRESHOLDS.warn);
  const soft = Math.max(warn, usable(thresholds.soft, DEFAULT_THRESHOLDS.soft));
  const hard = Math.max(soft, usable(thresholds.hard, DEFAULT_THRESHOLDS.hard));
  return { warn, soft, hard };
}

export function adaptThresholdsForSignals(
  thresholds: { warn: number; soft: number; hard: number },
  signals: { repeatedReadCount: number },
): { warn: number; soft: number; hard: number } {
  if (!Number.isFinite(signals.repeatedReadCount) || signals.repeatedReadCount < 3) {
    return thresholds;
  }
  // Re-reading the same file repeatedly is a strong sign of shrinking-spiral
  // behavior. Lower only warn/soft a little so compaction can refresh anchors
  // before the hard overflow path, but keep hard fixed as the safety boundary.
  const warn = Math.min(thresholds.warn, Math.max(0.25, thresholds.warn - 0.08));
  const soft = Math.max(warn, Math.min(thresholds.soft, Math.max(0.35, thresholds.soft - 0.04)));
  const hard = Math.max(soft, thresholds.hard);
  return { warn, soft, hard };
}

export function normalizeTargetLoad(
  targetLoad: number | null | undefined,
  thresholds: { warn: number; soft: number; hard: number },
): number {
  if (typeof targetLoad === 'number' && Number.isFinite(targetLoad) && targetLoad > 0) {
    return Math.min(Math.max(0.05, targetLoad), Math.max(0.05, thresholds.hard - 0.01));
  }
  return Math.max(0.05, thresholds.warn);
}

/** What a surface needs to explain the price cliff to the user, in tokens. */
export interface PriceCliffSummary {
  /** The published step-up boundary (absolute tokens), this route only. */
  cliffTokens: number;
  /** Published step-up factor, e.g. 2 = double price above the boundary. */
  multiplier?: number;
  /** Which billed rate steps up. */
  field?: string;
  baseRate?: number;
  cliffRate?: number;
  /** True when the cliff, not window fill, is what drives compaction here. */
  binding: boolean;
  /** Tokens the ladder fires at: min(threshold x window, cliff x headroom). */
  triggerTokens: number;
  /** Tokens the ladder would fire at without the cliff. */
  uncappedTriggerTokens: number;
  /** The measured request size this report was computed for. */
  inputTokens: number;
  /** Tokens left before the trigger; negative once it is already crossed. */
  tokensToTrigger: number;
  /** Tokens the post-compaction target lands at, cliff-capped too. */
  targetTokens: number;
  /** Input budget the rungs are measured against. */
  availableInputTokens: number;
}

/**
 * The single source for the "Context Window Report" cliff line, shared by the
 * CLI `/context` report and the WebUI `context.debug` payload. Both surfaces
 * therefore show the trigger the compaction ladder actually uses — computed
 * with `contextWindowBudget` + `adjustLadderForPriceCliff`, the same two calls
 * the middleware makes — instead of each re-deriving the arithmetic and drifting.
 *
 * `undefined` means "no cliff applies to this route": no published boundary, an
 * unknown window, or a boundary the window-relative ladder already beats.
 */
export function describePriceCliffForContext(
  ctx: Context,
  inputTokens: number,
  maxContext: number,
  thresholds: { warn: number; soft: number; hard: number } | null | undefined,
  targetLoad: number | null | undefined,
): PriceCliffSummary | undefined {
  const runtimeMax = effectiveMaxContext(ctx, maxContext);
  if (runtimeMax <= 0) return undefined;
  const routeKey = priceCliffRouteForContext(ctx);
  const cliff = readPriceCliffForRoute(ctx.meta, routeKey);
  if (!cliff) return undefined;

  const budget = contextWindowBudget(ctx, inputTokens, runtimeMax);
  // The middleware lowers warn/soft under repeated-read pressure BEFORE it
  // folds the cliff in. Skipping that rung here made this report name a cap the
  // ladder was not applying: with the adaptive soft at 0.66 a cliff sitting at
  // ~0.68 of the budget is already beaten by the window-relative rung, while
  // the un-adapted 0.70 still rendered it as a binding money cap.
  const rungs = adaptThresholdsForSignals(
    sanitizeThresholds(thresholds ?? { warn: 0.55, soft: 0.7, hard: 0.85 }),
    { repeatedReadCount: repeatedReadPressure(ctx) },
  );
  const target = normalizeTargetLoad(targetLoad, rungs);
  const adjusted = adjustLadderForPriceCliff(
    { ...rungs, targetLoad: target },
    budget.availableInputTokens,
    cliff.cliffTokens,
  );
  // A cliff the ladder already beats is published, but it is not what saves
  // money here — report it as non-binding so no surface claims a cap that is
  // not in force.
  if (!adjusted.binding || adjusted.triggerTokens === undefined) return undefined;

  return {
    cliffTokens: cliff.cliffTokens,
    ...(cliff.multiplier !== undefined ? { multiplier: cliff.multiplier } : {}),
    ...(cliff.field !== undefined ? { field: cliff.field } : {}),
    ...(cliff.baseRate !== undefined ? { baseRate: cliff.baseRate } : {}),
    ...(cliff.cliffRate !== undefined ? { cliffRate: cliff.cliffRate } : {}),
    binding: true,
    triggerTokens: adjusted.triggerTokens,
    uncappedTriggerTokens: Math.floor(rungs.soft * budget.availableInputTokens),
    inputTokens: budget.inputTokens,
    tokensToTrigger: adjusted.triggerTokens - budget.inputTokens,
    targetTokens: Math.floor(adjusted.targetLoad * budget.availableInputTokens),
    availableInputTokens: budget.availableInputTokens,
  };
}
