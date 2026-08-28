/**
 * Model tier resolution — the deterministic "how expensive should this job be?"
 * layer that sits on top of the existing fallback-profile and model-matrix
 * primitives.
 *
 * A tier binds three things that were previously configured independently:
 *
 *   fallbackProfile  →  which models, in what failover order
 *   budget           →  maxCostUsd / maxIterations / maxToolCalls / timeoutMs
 *   modelRuntime     →  reasoning effort, cache ttl, generation params
 *
 * Everything here is deterministic: no LLM call, no scoring, no heuristic over
 * task text. A tier is chosen by an explicit argument, or by a table lookup
 * with the SAME precedence the model matrix already uses (exact role → the
 * role's phase → the `*` default). That precedence is deliberately identical so
 * a reader only has to learn one rule for both tables.
 *
 * Fail-safe by construction: an unconfigured or unknown tier resolves to
 * `undefined` rather than to an invented model id, and callers then fall
 * through to their existing behavior (matrix → session). A tier can only ever
 * ADD a decision the config actually expresses.
 */

import type {
  Config,
  ModelMatrixEntry,
  ModelTierLevel,
  ModelTiersConfig,
} from '../types/config.js';
import type { SubagentConfig } from '../types/multi-agent.js';
import type { ResolvedModelTarget } from './model-matrix.js';
import { phaseForRole, resolveModelTargetFromEntry } from './model-matrix.js';

/** Fallback default when the config names no default tier. */
export const DEFAULT_TIER_ID = 'standard';

/** Where a tier decision came from. Mirrors `ModelMatrixResolutionSource`. */
export type ModelTierSource = 'explicit' | 'role' | 'phase' | 'default' | 'config-default';

export interface ModelTierDecision {
  /** The chosen tier id. */
  tier: string;
  /** Which rung of the ladder produced it. */
  source: ModelTierSource;
  /** The routing key that matched, when the decision came from the table. */
  key?: string | undefined;
  /** True when the tier id has a configured level backing it. */
  configured: boolean;
}

export interface ModelTierBudget {
  maxCostUsd?: number | undefined;
  maxIterations?: number | undefined;
  maxToolCalls?: number | undefined;
  maxTokens?: number | undefined;
  timeoutMs?: number | undefined;
}

export interface ResolvedTierTarget extends ResolvedModelTarget {
  tier: string;
  source: ModelTierSource;
  /** Budget fields declared by the level, if any. */
  budget: ModelTierBudget;
}

/** The tier config, normalized. Returns undefined when the layer is off. */
export function activeTierConfig(config: Config): ModelTiersConfig | undefined {
  const tiers = config.modelTiers;
  if (tiers?.enabled !== true) return undefined;
  return tiers;
}

/** All configured level ids, in config order. Empty when the layer is off. */
export function listTierIds(config: Config): string[] {
  const tiers = activeTierConfig(config);
  return Object.keys(tiers?.levels ?? {});
}

/** The configured level for a tier id, or undefined. */
export function tierLevel(config: Config, tier: string | undefined): ModelTierLevel | undefined {
  if (!tier) return undefined;
  const tiers = activeTierConfig(config);
  return tiers?.levels?.[tier];
}

/** True when `tier` names a level this config actually defines. */
export function isConfiguredTier(config: Config, tier: string | undefined): boolean {
  return tierLevel(config, tier) !== undefined;
}

/**
 * Deterministic tier ladder.
 *
 *   1. `explicit`  — the tool/task/caller named a tier outright.
 *   2. `role`      — routing[<roster role>].
 *   3. `phase`     — routing[<the role's phase>].
 *   4. `default`   — the routing table's `*` entry.
 *   5. config default (`modelTiers.default`), else {@link DEFAULT_TIER_ID}.
 *
 * An explicit tier naming no configured level is still returned (with
 * `configured: false`) rather than silently rewritten — callers surface it as
 * an error instead of quietly running the job at the wrong expense.
 */
export function classifyTier(
  config: Config,
  input: { role?: string | undefined; tier?: string | undefined } = {},
): ModelTierDecision | undefined {
  const tiers = activeTierConfig(config);
  if (!tiers) return undefined;

  if (input.tier) {
    return {
      tier: input.tier,
      source: 'explicit',
      configured: isConfiguredTier(config, input.tier),
    };
  }

  const routing = tiers.routing ?? {};
  const role = input.role;
  const roleTier = role ? routing[role] : undefined;
  if (roleTier) {
    return {
      tier: roleTier,
      source: 'role',
      key: role,
      configured: isConfiguredTier(config, roleTier),
    };
  }

  const phase = phaseForRole(role);
  const phaseTier = phase ? routing[phase] : undefined;
  if (phaseTier) {
    return {
      tier: phaseTier,
      source: 'phase',
      key: phase,
      configured: isConfiguredTier(config, phaseTier),
    };
  }

  const starTier = routing['*'];
  if (starTier) {
    return {
      tier: starTier,
      source: 'default',
      key: '*',
      configured: isConfiguredTier(config, starTier),
    };
  }

  const fallbackTier = tiers.default ?? DEFAULT_TIER_ID;
  return {
    tier: fallbackTier,
    source: 'config-default',
    configured: isConfiguredTier(config, fallbackTier),
  };
}

/** Extract only the budget fields a level declares. */
export function tierBudget(level: ModelTierLevel | undefined): ModelTierBudget {
  if (!level) return {};
  return {
    ...(level.maxCostUsd !== undefined ? { maxCostUsd: level.maxCostUsd } : {}),
    ...(level.maxIterations !== undefined ? { maxIterations: level.maxIterations } : {}),
    ...(level.maxToolCalls !== undefined ? { maxToolCalls: level.maxToolCalls } : {}),
    ...(level.maxTokens !== undefined ? { maxTokens: level.maxTokens } : {}),
    ...(level.timeoutMs !== undefined ? { timeoutMs: level.timeoutMs } : {}),
  };
}

/**
 * Expand a level into a concrete model target by reusing the model-matrix
 * expander. A level IS a matrix entry plus a budget, so the profile-as-primary
 * semantics (chain[0] primary, remainder failover) come for free and stay
 * identical between the two tables.
 */
export function tierModelTarget(
  config: Config,
  level: ModelTierLevel | undefined,
): ResolvedModelTarget | undefined {
  if (!level) return undefined;
  const entry: ModelMatrixEntry = {
    ...(level.provider !== undefined ? { provider: level.provider } : {}),
    ...(level.model !== undefined ? { model: level.model } : {}),
    ...(level.modelRuntime !== undefined ? { modelRuntime: level.modelRuntime } : {}),
    ...(level.fallbackProfile !== undefined ? { fallbackProfile: level.fallbackProfile } : {}),
  };
  return resolveModelTargetFromEntry(config, entry);
}

/**
 * Full resolution: classify, then expand. Returns undefined when the layer is
 * off or the chosen tier has no configured level — in both cases the caller
 * keeps whatever it already resolved.
 */
export function resolveTier(
  config: Config,
  input: { role?: string | undefined; tier?: string | undefined } = {},
): ResolvedTierTarget | undefined {
  const decision = classifyTier(config, input);
  if (!decision) return undefined;
  const level = tierLevel(config, decision.tier);
  if (!level) return undefined;
  const target = tierModelTarget(config, level);
  return {
    ...(target ?? {}),
    tier: decision.tier,
    source: decision.source,
    budget: tierBudget(level),
  };
}

/** Spend budgets a tier is allowed to tighten. `timeoutMs` is deliberately absent. */
const TIGHTENABLE_BUDGETS = ['maxCostUsd', 'maxIterations', 'maxToolCalls', 'maxTokens'] as const;

type TighteningBudgetField = (typeof TIGHTENABLE_BUDGETS)[number];

/**
 * Apply a resolved tier to a subagent config.
 *
 * Model fields are FILL-ONLY: an explicit `delegate({ model })` or a `/setmodel`
 * role pin is a decision the user already made, and a tier is only a default.
 *
 * Spend budgets are different, and getting this wrong makes the whole feature
 * pointless. By the time a spawn reaches here, `applyRosterBudget` /
 * `instantiateRosterConfig` have ALREADY populated every budget field with the
 * role's generous default — so a fill-only rule would mean a 'budget' tier
 * changes the model but never the spend ceiling, which is not a budget at all.
 * The rule is therefore:
 *
 *   - caller-pinned (`cfg.budgetPins`) → never touched; a number the user typed wins.
 *   - unset                            → set from the tier.
 *   - set by a roster/generic default  → TIGHTENED to the tier value (min), never raised.
 *
 * Tightening only, never raising: a tier must not be able to silently grant a
 * worker more money than its role was designed to spend.
 *
 * `timeoutMs` is excluded from tightening on purpose. Clamping a wall-clock
 * budget down is the exact shape of the bug that once capped 10-hour roster
 * agents at ~4 minutes, and a cost label is not a good reason to kill a
 * long-running job mid-flight. It stays fill-only.
 */
export function applyTierToSubagentConfig(
  cfg: SubagentConfig,
  resolved: ResolvedTierTarget | undefined,
): void {
  if (!resolved) return;

  if (!cfg.model && resolved.model) cfg.model = resolved.model;
  if (!cfg.provider && resolved.provider) cfg.provider = resolved.provider;
  if (!cfg.fallbackProfile && resolved.fallbackProfile) {
    cfg.fallbackProfile = resolved.fallbackProfile;
  }
  if (!cfg.fallbackModels?.length && resolved.fallbackModels?.length) {
    cfg.fallbackModels = [...resolved.fallbackModels];
  }
  if (!cfg.modelRuntime && resolved.modelRuntime) cfg.modelRuntime = resolved.modelRuntime;

  const budget = resolved.budget;
  const pinned = new Set(cfg.budgetPins ?? []);

  for (const field of TIGHTENABLE_BUDGETS) {
    const tierValue = budget[field];
    if (tierValue === undefined || pinned.has(field)) continue;
    const current = cfg[field as TighteningBudgetField];
    cfg[field as TighteningBudgetField] =
      current === undefined ? tierValue : Math.min(current, tierValue);
  }

  if (cfg.timeoutMs === undefined && budget.timeoutMs !== undefined && !pinned.has('timeoutMs')) {
    cfg.timeoutMs = budget.timeoutMs;
  }
}
