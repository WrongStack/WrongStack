/**
 * Leader tier self-switching policy.
 *
 * The leader may notice mid-session that it is doing cheap work on an
 * expensive model (or the reverse) and want to move itself to another tier.
 * That is genuinely useful and genuinely dangerous, so every decision goes
 * through the pure guards in this module.
 *
 * Why guards at all — a tier switch is NOT free:
 *
 *   1. It invalidates the provider prompt cache. The next turn re-reads the
 *      whole conversation at full input price on the new model. A switch that
 *      saves $0.002/turn but costs $0.40 to re-warm is a loss, and a switch
 *      that happens every time a heuristic wobbles across a threshold is a
 *      permanent tax. Hence {@link ModelTierLeaderConfig.dwellTurns} and the
 *      break-even test.
 *   2. A downgrade can land on a model with a SMALLER context window. If the
 *      conversation already exceeds it, the session is stranded. Hence the
 *      context-fill gate.
 *   3. Spending authority belongs to the user. The leader may never raise
 *      itself above `maxTier`, and in the default 'propose' mode it may not
 *      switch at all without a human accepting.
 *
 * Everything here is pure: prices, window sizes and turn counts are injected,
 * so the policy is unit-testable and holds no I/O or layer dependencies.
 */

import type { Config, ModelTierLeaderMode } from '../types/config.js';
import { activeTierConfig, listTierIds } from './model-tier.js';

/** Per-1M-token prices and window for one model, as published by models.dev. */
export interface TierModelEconomics {
  /** USD per 1M uncached input tokens. */
  inputPerMTok?: number | undefined;
  /** USD per 1M output tokens. */
  outputPerMTok?: number | undefined;
  /** USD per 1M cache-read input tokens. */
  cacheReadPerMTok?: number | undefined;
  /** USD per 1M cache-write input tokens. */
  cacheWritePerMTok?: number | undefined;
  /** Context window in tokens. */
  maxContext?: number | undefined;
}

export interface LeaderTierSwitchRequest {
  /** Tier the leader is on now (undefined when it has never been set). */
  fromTier?: string | undefined;
  /** Tier the leader wants to move to. */
  toTier: string;
  /** Current conversation size in tokens — what a switch would have to re-read. */
  contextTokens: number;
  /** Turns elapsed since the last tier switch. Large when there has been none. */
  turnsSinceSwitch: number;
  /** Economics of the current and target models. */
  economics: { from: TierModelEconomics; to: TierModelEconomics };
  /**
   * How many further turns to amortize the re-warm cost over. Defaults to the
   * configured `dwellTurns`, which is the minimum the session is committed to
   * staying on the new tier anyway — deliberately conservative.
   */
  projectedTurns?: number | undefined;
}

export type LeaderTierRefusalCode =
  | 'disabled'
  | 'same-tier'
  | 'unknown-tier'
  | 'dwell'
  | 'context-window'
  | 'ceiling'
  | 'not-worth-it';

export interface LeaderTierEconomicsSummary {
  /** One-off cost of re-reading the context on the target model. */
  reWarmCostUsd: number;
  /** Per-turn context cost on the current model. */
  stayCostPerTurnUsd: number;
  /** Per-turn context cost on the target model. */
  switchCostPerTurnUsd: number;
  /** Net saving over `projectedTurns`, after paying the re-warm cost. */
  projectedSavingsUsd: number;
  /** True when the target is cheaper per input token than the current model. */
  isDowngrade: boolean;
}

export type LeaderTierVerdict =
  | {
      allowed: true;
      /** 'auto' means apply now; 'propose' means ask a human first. */
      mode: Extract<ModelTierLeaderMode, 'auto' | 'propose'>;
      economics: LeaderTierEconomicsSummary;
      reason: string;
    }
  | {
      allowed: false;
      code: LeaderTierRefusalCode;
      economics?: LeaderTierEconomicsSummary | undefined;
      reason: string;
    };

const DEFAULTS = {
  mode: 'propose' as ModelTierLeaderMode,
  dwellTurns: 6,
  minSavingsUsd: 0.1,
  maxContextFillForSwitch: 0.8,
};

/** The leader policy with every default resolved to a concrete value. */
export interface ResolvedLeaderTierPolicy {
  mode: ModelTierLeaderMode;
  dwellTurns: number;
  minSavingsUsd: number;
  maxContextFillForSwitch: number;
  maxTier?: string | undefined;
}

/** Read the leader policy with defaults applied. */
export function leaderTierPolicy(config: Config): ResolvedLeaderTierPolicy {
  const leader = config.modelTiers?.leader ?? {};
  return {
    mode: leader.mode ?? DEFAULTS.mode,
    dwellTurns: leader.dwellTurns ?? DEFAULTS.dwellTurns,
    minSavingsUsd: leader.minSavingsUsd ?? DEFAULTS.minSavingsUsd,
    maxContextFillForSwitch: leader.maxContextFillForSwitch ?? DEFAULTS.maxContextFillForSwitch,
    ...(leader.maxTier !== undefined ? { maxTier: leader.maxTier } : {}),
  };
}

/**
 * Rank of a tier within the configured ladder. Config declaration order IS the
 * ladder — the first declared level is the cheapest rung. Ranking by name would
 * mean guessing at user-defined level names, and ranking by live price would
 * make a ceiling flip whenever a provider changed its price list.
 */
export function tierRank(config: Config, tier: string | undefined): number {
  if (!tier) return -1;
  return listTierIds(config).indexOf(tier);
}

/**
 * Cost model for the switch.
 *
 * `contextTokens` is the quantity that actually matters: it is re-read on every
 * turn, cached on the current model and uncached on the first turn of the new
 * one. Output tokens are not modeled — they do not change with the switch
 * decision and would only add noise to the comparison.
 */
export function evaluateSwitchEconomics(
  request: LeaderTierSwitchRequest,
  projectedTurns: number,
): LeaderTierEconomicsSummary {
  const mtok = request.contextTokens / 1_000_000;
  const { from, to } = request.economics;

  const fromInput = from.inputPerMTok ?? 0;
  const toInput = to.inputPerMTok ?? 0;

  // Cached reads are what a settled session actually pays per turn. Fall back
  // to the uncached input price when a provider publishes no cache pricing.
  const stayPerTurn = mtok * (from.cacheReadPerMTok ?? fromInput);
  const switchPerTurn = mtok * (to.cacheReadPerMTok ?? toInput);
  // The first turn after a switch pays full freight on the new model.
  const reWarm = mtok * (to.cacheWritePerMTok ?? toInput);

  return {
    reWarmCostUsd: reWarm,
    stayCostPerTurnUsd: stayPerTurn,
    switchCostPerTurnUsd: switchPerTurn,
    projectedSavingsUsd: (stayPerTurn - switchPerTurn) * projectedTurns - reWarm,
    isDowngrade: toInput < fromInput,
  };
}

/**
 * The full decision. Returns whether the switch may happen, and — in 'propose'
 * mode — that a human has to accept it first.
 *
 * Guard order is deliberate: the cheap structural checks run before the
 * economics, so a refusal reason is always the most fundamental one rather than
 * whichever gate happened to be evaluated first.
 */
export function evaluateLeaderTierSwitch(
  config: Config,
  request: LeaderTierSwitchRequest,
): LeaderTierVerdict {
  const tiers = activeTierConfig(config);
  if (!tiers) {
    return { allowed: false, code: 'disabled', reason: 'The model-tier layer is not enabled.' };
  }

  const policy = leaderTierPolicy(config);
  if (policy.mode === 'off') {
    return {
      allowed: false,
      code: 'disabled',
      reason: 'Leader tier switching is off (modelTiers.leader.mode = "off").',
    };
  }

  if (request.toTier === request.fromTier) {
    return {
      allowed: false,
      code: 'same-tier',
      reason: `Already running at tier "${request.toTier}".`,
    };
  }

  const targetRank = tierRank(config, request.toTier);
  if (targetRank < 0) {
    const available = listTierIds(config);
    return {
      allowed: false,
      code: 'unknown-tier',
      reason:
        `"${request.toTier}" is not a configured tier` +
        `${available.length ? ` (available: ${available.join(', ')})` : ''}.`,
    };
  }

  if (policy.maxTier !== undefined) {
    const ceiling = tierRank(config, policy.maxTier);
    if (ceiling >= 0 && targetRank > ceiling) {
      return {
        allowed: false,
        code: 'ceiling',
        reason:
          `Tier "${request.toTier}" is above the configured ceiling "${policy.maxTier}". ` +
          'Raising spend past the ceiling is the user’s call, not the leader’s.',
      };
    }
  }

  if (request.turnsSinceSwitch < policy.dwellTurns) {
    return {
      allowed: false,
      code: 'dwell',
      reason:
        `Only ${request.turnsSinceSwitch} turn(s) since the last tier switch; ` +
        `${policy.dwellTurns} required. Switching more often than this busts the ` +
        'prompt cache faster than a new tier can pay for itself.',
    };
  }

  // A downgrade can land on a smaller window. Refuse before the session is
  // stranded above the target model's limit.
  const targetWindow = request.economics.to.maxContext;
  if (targetWindow && targetWindow > 0) {
    const fill = request.contextTokens / targetWindow;
    if (fill > policy.maxContextFillForSwitch) {
      return {
        allowed: false,
        code: 'context-window',
        reason:
          `Context is ${Math.round(fill * 100)}% of the target model's ${targetWindow}-token ` +
          `window (limit ${Math.round(policy.maxContextFillForSwitch * 100)}%). ` +
          'Compact first, then retry the switch.',
      };
    }
  }

  const projectedTurns = request.projectedTurns ?? policy.dwellTurns;
  const economics = evaluateSwitchEconomics(request, projectedTurns);

  // With no published prices for EITHER model, every term above is zero and a
  // strict break-even test would refuse literally every downgrade — turning a
  // missing price list into a silent kill switch. Skip the economic gate in
  // that case and rely on the structural guards; the switch is still only a
  // proposal unless the user turned on 'auto'.
  const pricingKnown =
    request.economics.from.inputPerMTok !== undefined ||
    request.economics.to.inputPerMTok !== undefined;

  // The break-even test applies to DOWNGRADES only. A downgrade is a
  // cost-motivated move, so it has to actually save money. An upgrade is a
  // capability-motivated move and is never justified by arithmetic — it is
  // gated by the ceiling and, in 'propose' mode, by a human.
  if (pricingKnown && economics.isDowngrade && economics.projectedSavingsUsd < policy.minSavingsUsd) {
    return {
      allowed: false,
      code: 'not-worth-it',
      economics,
      reason:
        `Projected saving $${economics.projectedSavingsUsd.toFixed(4)} over ${projectedTurns} ` +
        `turn(s) is below the $${policy.minSavingsUsd.toFixed(4)} floor once the ` +
        `$${economics.reWarmCostUsd.toFixed(4)} cache re-warm is paid for.`,
    };
  }

  if (!pricingKnown) {
    return {
      allowed: true,
      mode: policy.mode === 'auto' ? 'auto' : 'propose',
      economics,
      reason:
        `No published pricing for either model, so the switch to "${request.toTier}" ` +
        'was judged on the structural guards alone (dwell, context window, ceiling).',
    };
  }

  return {
    allowed: true,
    mode: policy.mode === 'auto' ? 'auto' : 'propose',
    economics,
    reason: economics.isDowngrade
      ? `Downgrade to "${request.toTier}" saves about $${economics.projectedSavingsUsd.toFixed(4)} ` +
        `over ${projectedTurns} turn(s) after a $${economics.reWarmCostUsd.toFixed(4)} re-warm.`
      : `Upgrade to "${request.toTier}" costs about $${(-economics.projectedSavingsUsd).toFixed(4)} ` +
        `over ${projectedTurns} turn(s), including a $${economics.reWarmCostUsd.toFixed(4)} re-warm.`,
  };
}
