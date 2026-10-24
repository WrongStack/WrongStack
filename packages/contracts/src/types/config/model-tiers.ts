/**
 * Model tier configuration — the deterministic "how expensive should this job
 * be?" layer.
 *
 * A tier is deliberately NOT a new model-selection engine. It is a thin,
 * named composite over primitives that already exist:
 *
 *   tier = fallbackProfile (which models, in what order)
 *        + budget          (maxCostUsd / maxIterations / maxToolCalls / timeout)
 *        + modelRuntime    (reasoning effort, cache ttl, generation params)
 *
 * `FallbackProfileManager` already turns a profile name into a health-filtered
 * `provider/model` chain, and `resolveModelTargetFromEntry` already treats
 * `chain[0]` as the primary and the rest as the failover list. The tier layer
 * only adds a *name* for "budget vs standard vs premium" and a deterministic
 * map from task shape → that name, so callers (the leader, the Kanban
 * dispatcher, the spawn path) can say "run this cheaply" without knowing any
 * model id.
 *
 * The tier vocabulary intentionally reuses `ModelProfile.costTier`
 * ('budget' | 'standard' | 'premium') from `models/model-intelligence.ts` so
 * the codebase has ONE set of words for model expense, not two.
 */

import type { ModelRuntimeConfig } from './runtime.js';

/**
 * Built-in tier ids. Matches `ModelProfile.costTier` exactly. Users may define
 * additional named levels; these three are the ones the built-in routing
 * defaults and the UI surfaces know by name.
 */
export const BUILTIN_MODEL_TIER_IDS = ['budget', 'standard', 'premium'] as const;

export type BuiltinModelTierId = (typeof BUILTIN_MODEL_TIER_IDS)[number];

/** A tier id — one of the built-ins, or any user-defined level name. */
export type ModelTierId = BuiltinModelTierId | (string & {});

/**
 * One configured level. Every field is optional so a level can be as thin as
 * `{ fallbackProfile: 'cheap' }` — unset budget fields fall through to the
 * role/roster defaults rather than clamping them.
 */
export interface ModelTierLevel {
  /**
   * Named chain from {@link Config.fallbackProfiles}. `chain[0]` becomes the
   * primary model for anything routed to this tier; the remainder becomes the
   * failover chain. This is the field that actually picks the model.
   */
  fallbackProfile?: string | undefined;
  /**
   * Explicit provider override. Normally left unset — the profile's first
   * entry already carries a provider. Set only to pin a tier to one provider
   * while letting the profile choose the model.
   */
  provider?: string | undefined;
  /**
   * Explicit model override. When set, this wins over the profile's primary
   * and the profile is used for failover only. Mirrors `ModelMatrixEntry`.
   */
  model?: string | undefined;
  /**
   * Per-tier runtime overrides — the natural home for "budget tier thinks
   * less, premium tier thinks harder". Applied to subagents matched by this
   * tier, and to the leader when a leader tier switch is applied.
   */
  modelRuntime?: ModelRuntimeConfig | undefined;
  /** Max estimated USD spend for a subagent spawned at this tier. */
  maxCostUsd?: number | undefined;
  /** Max LLM iterations for a subagent spawned at this tier. */
  maxIterations?: number | undefined;
  /** Max tool invocations for a subagent spawned at this tier. */
  maxToolCalls?: number | undefined;
  /** Max total (input + output) tokens for a subagent spawned at this tier. */
  maxTokens?: number | undefined;
  /** Wall-clock budget in ms for a subagent spawned at this tier. */
  timeoutMs?: number | undefined;
  /** Human-facing note shown in the TUI/WebUI tier editors. */
  description?: string | undefined;
}

/**
 * How the leader is allowed to change its OWN tier mid-session.
 *
 * - 'off'     — the leader never changes its own tier. Tiers still route
 *               subagent spawns and Kanban dispatch.
 * - 'propose' — the leader emits `model.tier_proposed`; a human accepts or
 *               rejects in the TUI/WebUI. Default.
 * - 'auto'    — the leader applies the switch itself once every guard below
 *               passes, and only emits a notification.
 *
 * DEFAULT IS 'propose', and that matters: the autonomy invariant is that the
 * system never widens its own authority. 'auto' is a thing the USER turns on.
 */
export type ModelTierLeaderMode = 'off' | 'propose' | 'auto';

/**
 * Guard rails for leader self-switching. These exist because a tier switch is
 * NOT free: it invalidates the provider prompt cache, and a downgrade can move
 * the session onto a model with a smaller context window.
 */
export interface ModelTierLeaderConfig {
  /** Authority level for leader self-switching. Default 'propose'. */
  mode?: ModelTierLeaderMode | undefined;
  /**
   * Minimum turns the leader must dwell on a tier before another switch is
   * eligible. Hysteresis: without it, a request that oscillates around a
   * routing threshold busts the prompt cache on every single turn. Mirrors the
   * proven `stickyFallbackTurns` guard in the fallback extension. Default 6.
   */
  dwellTurns?: number | undefined;
  /**
   * Minimum projected USD saving, over the dwell window, required to justify a
   * downgrade. The projection is compared against the cost of re-warming the
   * prompt cache on the target model. A switch that does not pay for itself is
   * refused. Default 0.10.
   */
  minSavingsUsd?: number | undefined;
  /**
   * Refuse a switch when current context occupancy exceeds this fraction of
   * the TARGET model's context window. Prevents a downgrade from stranding the
   * session over the smaller model's limit. Default 0.8.
   */
  maxContextFillForSwitch?: number | undefined;
  /**
   * Ceiling the leader may never exceed on its own. When set, an upgrade
   * proposal above this tier is refused even in 'auto' mode — the user keeps
   * the authority to spend at the top tier.
   */
  maxTier?: ModelTierId | undefined;
}

/**
 * Deterministic routing table: which tier a piece of work runs at.
 *
 * Keys are matched by the same precedence the model matrix already uses —
 * exact roster role, then the role's phase, then the `*` default — so the two
 * tables read the same way and a reader only has to learn one rule.
 */
export type ModelTierRouting = Record<string, ModelTierId>;

export interface ModelTiersConfig {
  /**
   * Master switch. OFF by default: tier resolution changes which model serves
   * a spawn, so it is opt-in exactly like `model-router`.
   */
  enabled?: boolean | undefined;
  /** Tier used when nothing in {@link routing} matches. Default 'standard'. */
  default?: ModelTierId | undefined;
  /** The configured levels, keyed by tier id. */
  levels?: Record<string, ModelTierLevel> | undefined;
  /** role / phase / `*` → tier id. */
  routing?: ModelTierRouting | undefined;
  /** Leader self-switching authority and guard rails. */
  leader?: ModelTierLeaderConfig | undefined;
}
