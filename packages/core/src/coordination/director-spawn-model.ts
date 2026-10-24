import type { Config } from '@wrongstack/contracts/types/config';
import { ToolValidationError } from '@wrongstack/contracts/types/errors';
import type { Logger } from '@wrongstack/contracts/types/logger';
import type { SubagentConfig } from '@wrongstack/contracts/types/multi-agent';
import {
  isReasoningEffort,
  REASONING_EFFORT_LEVELS,
  type ReasoningEffort,
} from '@wrongstack/contracts/types/provider';
import type { JSONSchema } from '@wrongstack/contracts/types/tool';
import { conversationEffort } from '../utils/leader-effort-override.js';
import { isExternalAgentProvider } from './external-agent-provider.js';
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
  // An external ACP agent brings its own model; `provider: 'acp'` picks the
  // runner, not a model. A lane, matrix route or tier rewriting it would run
  // a WrongStack agent named after the external one instead.
  if (isExternalAgentSpawn(config)) return;

  // Session-scoped plan. Runs FIRST because, unlike every other layer here, it
  // is the user speaking about this session rather than the leader speaking
  // about this spawn. With the lock on it discards the leader's pins WHOLESALE
  // before applying its own: keeping a leader `model` next to a plan `provider`
  // would wire a pair that exists in neither, so a lane owns the whole target
  // and lets the layers below fill whatever it left unset.
  let tier = opts.tier;
  let planPinnedProvider = false;
  let planPinnedRuntime = false;
  // Set when a USER-authored layer (lane, session role overlay, explicit
  // `/setmodel` role/phase route) chose this worker's effort. Only then does the
  // leader's `leaderEffort` step aside — see the fold at the end.
  let userEffortLayer: string | undefined;
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
      planPinnedRuntime = plan.lock;
    }
    // A lane effort is the user's call only where the lane's own pins win:
    // with the lock on, or when the leader named no effort to keep.
    if (
      planTarget.modelRuntime?.reasoning?.effort !== undefined &&
      (plan.lock || config.leaderEffort === undefined)
    ) {
      userEffortLayer = lane;
    }
    if (planTarget.tier && !tier) {
      tier = planTarget.tier;
      config.tier = planTarget.tier;
    }
  }

  // A tier someone CHOSE for this spawn (the leader's `tier`, a Kanban or
  // trigger route, a user lane) is more specific than the role's standing
  // route, so the matrix steps aside and the tier fills the model below. The
  // tier used to be fill-only here, so on a routed role `tier: 'budget'` only
  // tightened the budget and kept the routed model — the reverse of what the
  // caller asked for. A guessed tier, or one naming no configured level, still
  // leaves the route in charge.
  const chosenTierModel =
    tier && !config.tierSuggested && opts.config
      ? resolveTier(opts.config, { role: config.role, tier })
      : undefined;
  const tierOutranksRoute = Boolean(
    chosenTierModel && chosenTierModel.source === 'explicit' && chosenTierModel.model,
  );

  // Per-task model matrix: when the caller didn't pin a model, resolve one
  // from the matrix by role (→ phase → `*`). Done here, before the spawned
  // event + manifest + coordinator handoff, so the fleet UI and the agent
  // itself all reflect the matched model. Explicit per-spawn models win.
  if (!config.model && opts.modelMatrix && !tierOutranksRoute) {
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
      if (entry.modelRuntime && !planPinnedRuntime) config.modelRuntime = entry.modelRuntime;
      // An explicit role/phase route is a statement the user made; the `*`
      // wildcard is only a default, so the leader's effort still beats it.
      if (
        !planPinnedRuntime &&
        entry.modelRuntime?.reasoning?.effort !== undefined &&
        (resolution?.source === 'role' || resolution?.source === 'phase')
      ) {
        userEffortLayer ??= `/setmodel ${resolution.source} route`;
      }
    }
  }

  // Deterministic tier layer. Runs AFTER the matrix so a routing-table pin wins
  // over a tier the routing table itself implied (role/phase/default) — only a
  // chosen tier skipped the matrix above — and BEFORE the session fallback so a
  // routed job actually lands on its level's model instead of silently
  // inheriting the leader's. Only fields still unset are filled, so
  // `delegate({ model })` is never second-guessed.
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

  // Leader-chosen effort. Folded in LAST so it beats every default layer (the
  // matrix `*` route, the tier, the roster) and survives a lane lock that took
  // the leader's provider/model away — the user's lane said nothing about
  // effort, so the decision stays with the leader. Only a user-authored effort
  // outranks it. Not clamped here: the request pipeline maps it onto the
  // levels the resolved model actually supports (`nearestSupportedEffort`).
  if (config.leaderEffort !== undefined) {
    if (userEffortLayer) {
      opts.logger?.info(
        `spawn: leader effort "${config.leaderEffort}" for role "${config.role ?? '?'}" ` +
          `yielded to the user's effort from ${userEffortLayer}`,
      );
    } else {
      config.modelRuntime = {
        ...config.modelRuntime,
        reasoning: { ...config.modelRuntime?.reasoning, effort: config.leaderEffort },
      };
    }
  }

  // Nothing chose this worker's effort: follow what the leader itself runs at.
  // Without this the worker silently fell back to the PROJECT effort even when
  // the leader's tab, or the leader's own `leader_effort_set`, said otherwise.
  if (config.modelRuntime?.reasoning?.effort === undefined && config.leaderConversationEffort) {
    const inherited = conversationEffort(
      config.leaderConversationEffort,
      opts.config?.modelRuntime?.reasoning?.effort,
    );
    if (inherited) {
      config.modelRuntime = {
        ...config.modelRuntime,
        reasoning: { ...config.modelRuntime?.reasoning, effort: inherited },
      };
    }
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

/** True when the spawn runs an external ACP agent (Claude Code, Codex CLI, …). */
export function isExternalAgentSpawn(config: SubagentConfig): boolean {
  return isExternalAgentProvider(config.provider);
}

/**
 * True when a PERSON pinned this spawn's model rather than the leader.
 *
 * `spawn_subagent` / `delegate` stamp `modelChosenByLeader`; everything else
 * that carries a provider/model — `/spawn --model=…`, an ACP flag, a Kanban
 * task route someone authored — came from a human. A one-off they typed is
 * more specific than a standing lane, so the session plan steps aside
 * entirely: it does not even claim a lane, which leaves that lane free for a
 * spawn the plan actually routes.
 *
 * Stepping aside WHOLESALE (rather than filling the missing half) is
 * deliberate: a human `model` beside a lane `provider` names a pair that
 * exists in neither place. The layers below — matrix, tier, session — fill the
 * gap the same way they did before the plan existed.
 */
export function isHumanPinnedSpawn(config: SubagentConfig): boolean {
  if (config.modelChosenByLeader === true) return false;
  return Boolean(config.provider || config.model);
}

/**
 * The `effort` input shared by every leader spawn tool (`delegate`,
 * `spawn_subagent`), so the wording and the accepted levels
 * cannot drift between them.
 */
export const LEADER_EFFORT_SCHEMA: JSONSchema = {
  type: 'string',
  enum: [...REASONING_EFFORT_LEVELS],
  description:
    "Reasoning effort for this worker — YOUR call, made per task and per model, just like provider/model. Match it to the work: 'low'/'minimal' for mechanical, well-specified edits or lookups; 'medium' for ordinary work; 'high'/'xhigh'/'max' for deep debugging, design, security or review where being wrong is costly; 'none' to switch reasoning off. It is applied to whatever model the worker resolves to (your pin, a user lane, the routing table or the tier) and mapped onto the nearest level that model supports. It survives a user's locked model lane; only an effort the user set on that lane or role wins over it. Omit to inherit your own session effort.",
};

/** Most skills a leader may request per spawn — each one costs prompt space. */
const MAX_SPAWN_SKILLS = 4;

/** The `skills` input shared by `delegate` and `spawn_subagent`. */
export const SPAWN_SKILLS_SCHEMA: JSONSchema = {
  type: 'array',
  items: { type: 'string' },
  maxItems: MAX_SPAWN_SKILLS,
  description:
    'Skill names to load into this worker first (e.g. one the skill companion suggested). Added ahead of the skills its role and task already select — omit to let those choose.',
};

/** Read leader-requested skill names; non-strings and blanks are dropped, the list is capped. */
export function readSpawnSkills(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = [
    ...new Set(
      value
        .filter((name): name is string => typeof name === 'string')
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ].slice(0, MAX_SPAWN_SKILLS);
  return names.length > 0 ? names : undefined;
}

/** Read and validate a leader-supplied `effort`; throws a teaching error on a bad value. */
export function readLeaderEffort(value: unknown): ReasoningEffort | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (isReasoningEffort(value)) return value;
  throw new ToolValidationError({
    message: `Unknown effort ${JSON.stringify(value)}. Use one of: ${REASONING_EFFORT_LEVELS.join(', ')}.`,
    field: 'effort',
  });
}
