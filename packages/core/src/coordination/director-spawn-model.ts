import type { Config } from '../types/config.js';
import type { Logger } from '../types/logger.js';
import type { SubagentConfig } from '../types/multi-agent.js';
import type { ModelMatrixSource } from './model-matrix.js';
import { resolveModelMatrixResolution, roleNeedsIndependentReviewModel } from './model-matrix.js';
import type { ResolvedTierTarget } from './model-tier.js';
import { applyTierToSubagentConfig, classifyTier, listTierIds, resolveTier } from './model-tier.js';
import type { ProviderModelStatusTracker } from './provider-status-tracker.js';
import { isSlotConfigured, type SubagentSlot } from './session-subagent-models.js';

export interface ResolveDirectorSpawnModelOptions {
  modelMatrix?: ModelMatrixSource | undefined;
  /**
   * Live config, used to resolve the deterministic model-tier layer. Optional:
   * when omitted (or when `modelTiers.enabled` is not true) the tier step is
   * skipped entirely and resolution behaves exactly as it did before tiers
   * existed.
   */
  config?: Config | undefined;
  /**
   * Tier named explicitly by the caller — the `tier` argument on `delegate` /
   * `spawn_subagent`, or a Kanban task's persisted route. Outranks the routing
   * table but still loses to an explicit provider/model.
   */
  tier?: string | undefined;
  /** Observability hook: fired when a tier actually contributed a decision. */
  onTierResolved?: ((resolved: ResolvedTierTarget) => void) | undefined;
  sessionProvider?: string | undefined;
  sessionModel?: string | undefined;
  statusTracker?: ProviderModelStatusTracker | undefined;
  logger?: Logger | undefined;
  /**
   * Session-scoped lane (or role overlay) claimed for this spawn. Unlike the
   * matrix this is a statement the USER made about this session, so with
   * `lock` set it outranks the provider/model the leader passed to
   * `spawn_subagent` / `delegate`. See `session-subagent-models.ts`.
   */
  sessionPlan?:
    | {
        /** Which part of the plan matched (see `SubagentSlotClaim`). */
        kind: 'role' | 'lane' | 'session-model';
        target: SubagentSlot;
        lock: boolean;
        /** Lane index, for the log line. Undefined for role/session-model. */
        slotIndex?: number | undefined;
      }
    | undefined;
}

export function resolveDirectorSpawnModel(
  config: SubagentConfig,
  opts: ResolveDirectorSpawnModelOptions,
): void {
  // Normalize: empty strings are equivalent to undefined. A config that
  // arrives with provider: "" or model: "" would bypass the !config.model
  // check below and remain as empty strings through the entire spawn,
  // producing a subagent with no valid credentials.
  if (config.provider?.trim() === '') config.provider = undefined;
  if (config.model?.trim() === '') config.model = undefined;

  // Session-scoped plan. Runs FIRST because, unlike every other layer here, it
  // is the user speaking about this session rather than the leader speaking
  // about this spawn. With the lock on it discards the leader's pins WHOLESALE
  // before applying its own: keeping a leader `model` next to a plan `provider`
  // would wire a pair that exists in neither, so a lane owns the whole target
  // and lets the layers below fill whatever it left unset.
  let tier = opts.tier;
  let planPinnedProvider = false;
  const plan = opts.sessionPlan;
  // "Use my model" carries no target of its own: it resolves to the session's
  // provider/model, which is exactly what the final fallback below already
  // does — so the plan step only has to clear whatever the leader pinned.
  const planTarget =
    plan?.kind === 'session-model'
      ? { provider: opts.sessionProvider, model: opts.sessionModel }
      : plan?.target;
  if (plan && planTarget && isSlotConfigured(planTarget)) {
    const lane =
      plan.kind === 'session-model'
        ? 'session model'
        : plan.slotIndex === undefined
          ? `role "${config.role ?? '?'}"`
          : `lane #${plan.slotIndex + 1}`;
    // Only the LEADER's pins are cleared here. A spawn a person pinned never
    // reaches this branch: `Director.spawn` declines to claim a lane for it
    // (see `isHumanPinnedSpawn`), so `opts.sessionPlan` is absent and the
    // config travels untouched.
    if (plan.lock) {
      if (config.provider || config.model || config.tier || config.fallbackProfile) {
        opts.logger?.info(
          `spawn: session subagent-model plan (${lane}) overrode leader-supplied ` +
            `"${config.provider ?? '?'}/${config.model ?? '?'}" for role "${config.role ?? '?'}"`,
        );
      }
      config.provider = undefined;
      config.model = undefined;
      config.tier = undefined;
      config.fallbackProfile = undefined;
      config.modelRuntime = undefined;
      // The ad-hoc chain goes too: its entries were chosen to back the model
      // the leader picked, so leaving it would route this worker straight back
      // to the leader's models on the first 429 — the exact decision the lock
      // took away. The lane's own profile/tier supplies the replacement chain.
      config.fallbackModels = undefined;
      tier = undefined;
    }
    if (planTarget.provider && !config.provider) {
      config.provider = planTarget.provider;
      planPinnedProvider = true;
    }
    if (planTarget.model && !config.model) config.model = planTarget.model;
    if (planTarget.fallbackProfile && !config.fallbackProfile) {
      config.fallbackProfile = planTarget.fallbackProfile;
    }
    if (planTarget.modelRuntime && !config.modelRuntime) {
      config.modelRuntime = planTarget.modelRuntime;
    }
    if (planTarget.tier && !tier) {
      tier = planTarget.tier;
      config.tier = planTarget.tier;
    }
  }

  // Per-task model matrix: when the caller didn't pin a model, resolve one
  // from the matrix by role (→ phase → `*`). Done here, before the spawned
  // event + manifest + coordinator handoff, so the fleet UI and the agent
  // itself all reflect the matched model. Explicit per-spawn models win.
  if (!config.model && opts.modelMatrix) {
    const matrix = typeof opts.modelMatrix === 'function' ? opts.modelMatrix() : opts.modelMatrix;
    const resolution = resolveModelMatrixResolution(matrix, config.role);
    const entry =
      resolution?.source === 'default' && roleNeedsIndependentReviewModel(config.role)
        ? undefined
        : resolution?.entry;
    if (entry) {
      // Matrix fields are independent: a provider-only route must survive
      // when the missing model is filled from the session below, just as a
      // model-only route keeps its model while inheriting the provider.
      if (entry.model) config.model = entry.model;
      // A lane that pinned a provider keeps it: the matrix overwrite below
      // exists to keep a matrix pair coherent, and the plan outranks the
      // matrix. The model may still come from the matrix/tier/session — the
      // same provider-from-one-layer split a provider-only matrix route
      // already relies on.
      if (entry.provider && !planPinnedProvider) config.provider = entry.provider;
      if (entry.fallbackProfile) config.fallbackProfile = entry.fallbackProfile;
      if (entry.modelRuntime) config.modelRuntime = entry.modelRuntime;
    }
  }

  // Deterministic tier layer. Runs AFTER the matrix so an explicit /setmodel
  // role or phase pin still wins — a tier is a default, not an override — and
  // BEFORE the session fallback so a routed job actually lands on its level's
  // model instead of silently inheriting the leader's. Only fields still unset
  // are filled, so `delegate({ model })` is never second-guessed.
  if (opts.config) {
    // An explicit tier that names no configured level is a config mistake, and
    // the failure mode is silent: the job would just run at whatever the matrix
    // or session resolved, i.e. at the WRONG expense, with nothing in the log
    // to say so. Warn loudly and name the levels that do exist. The spawn still
    // proceeds — refusing to run a task because a cost label was misspelled is
    // worse than running it on the normal model.
    if (tier) {
      const decision = classifyTier(opts.config, { role: config.role, tier });
      if (decision && !decision.configured) {
        const available = listTierIds(opts.config);
        opts.logger?.warn(
          `spawn: tier "${tier}" is not a configured level` +
            `${available.length ? ` (available: ${available.join(', ')})` : ' (modelTiers.levels is empty)'}` +
            ' — falling through to matrix/session resolution.',
        );
      }
    }
    const resolvedTier = resolveTier(opts.config, {
      role: config.role,
      tier,
    });
    if (resolvedTier) {
      applyTierToSubagentConfig(config, resolvedTier);
      opts.onTierResolved?.(resolvedTier);
      opts.logger?.info(
        `spawn: tier="${resolvedTier.tier}" (via ${resolvedTier.source}) applied for role ` +
          `"${config.role ?? '?'}"`,
      );
    }
  }

  // Final per-field guarantee: when the matrix or explicit config left
  // one field undefined, restore it from the session's own values. Each
  // field is guarded independently — a matrix entry that sets `model` but
  // omits `provider` (a documented supported pattern) must not have its
  // model silently overwritten by the session fallback.
  if (!config.provider && opts.sessionProvider) {
    config.provider = opts.sessionProvider;
    opts.logger?.info(
      `spawn: provider="${config.provider}" for role "${config.role ?? '?'}" ` +
        'fell back to session provider (matrix resolution left it undefined)',
    );
  }
  if (!config.model && opts.sessionModel) {
    config.model = opts.sessionModel;
    opts.logger?.info(
      `spawn: model="${config.model}" for role "${config.role ?? '?'}" ` +
        'fell back to session model (matrix resolution left it undefined)',
    );
  }

  // Check the tracker — if the resolved provider/model is blocked, log a
  // warning. The subagent itself will also check via its fallback extension
  // and rotate away, but this early warning helps debugging.
  if (opts.statusTracker && config.provider && config.model) {
    if (!opts.statusTracker.isAvailable(config.provider, config.model)) {
      opts.logger?.warn(
        `spawn: resolved model "${config.provider}/${config.model}" for role "${config.role ?? '?'}" is blocked by the status tracker. ` +
          'The subagent will attempt its fallback chain.',
      );
    }
  }
}
