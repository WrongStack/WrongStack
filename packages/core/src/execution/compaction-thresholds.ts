import type { Context } from '../core/context.js';
import {
  CONTEXT_REQUEST_OVERHEAD_META,
  type ContextRequestOverhead,
  type ContextWindowBudgetSnapshot,
  computeContextWindowBudget,
} from '../utils/context-budget.js';

export type PressureLevel = 'warn' | 'soft' | 'hard';
export const LEVEL_RANK: Record<PressureLevel, number> = { warn: 0, soft: 1, hard: 2 };

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
