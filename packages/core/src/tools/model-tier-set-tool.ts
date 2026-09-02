/**
 * `leader_tier_set` — the leader's own view of, and handle on, the model-tier
 * layer.
 *
 * This is the surface behind "this model is too expensive for what I'm doing,
 * drop me to the cheap tier". Every request runs through
 * {@link evaluateLeaderTierSwitch}, so the leader cannot outrun the user's
 * guard rails: it may not switch more often than `dwellTurns`, may not
 * downgrade into a context window it no longer fits, may not climb past
 * `maxTier`, and may not take a downgrade whose saving does not cover the
 * prompt-cache re-warm it causes.
 *
 * Authority is the user's, via `modelTiers.leader.mode`:
 *   'off'     — the action is refused outright.
 *   'propose' — DEFAULT. The tool returns the verdict and emits a proposal for
 *               a human to accept; the model is NOT changed.
 *   'auto'    — the tool applies the switch through the same
 *               `switchProviderAndModel` path `leader_model_set` uses, so the
 *               live provider instance, context caps and auto-compaction
 *               denominator all follow.
 */

import type { TierModelEconomics } from '../coordination/model-tier-leader.js';
import { evaluateLeaderTierSwitch, leaderTierPolicy } from '../coordination/model-tier-leader.js';
import { activeTierConfig, listTierIds, resolveTier } from '../coordination/model-tier.js';
import type { JSONSchema, Tool } from '../types/tool.js';
import type { FallbackManageToolOptions } from './fallback-manage-tool-options.js';

export const LEADER_TIER_SET_TOOL_NAME = 'leader_tier_set';

/** Proposal payload handed to the host when the policy says "ask a human". */
export interface LeaderTierProposal {
  fromTier: string | undefined;
  toTier: string;
  target: { provider: string; model: string };
  reason: string;
  projectedSavingsUsd: number;
  reWarmCostUsd: number;
}

export interface ModelTierSetToolOptions extends FallbackManageToolOptions {
  /** Tier the leader is currently running at, when the host tracks one. */
  getCurrentTier?: (() => string | undefined) | undefined;
  /** Current conversation size in tokens — the quantity a switch re-reads. */
  getContextTokens?: (() => number | undefined) | undefined;
  /**
   * Turns since the last tier switch. Hosts that do not track this should
   * return a large number so the dwell guard does not block the first switch.
   */
  getTurnsSinceTierSwitch?: (() => number | undefined) | undefined;
  /** Published per-1M-token prices and window for a provider/model pair. */
  getModelEconomics?:
    | ((providerId: string, modelId: string) => Promise<TierModelEconomics | undefined>)
    | undefined;
  /** Record that the leader is now on `tier` (resets the dwell counter). */
  onTierSwitched?: ((tier: string) => void) | undefined;
  /** Surface a proposal to the user. Called only in 'propose' mode. */
  onTierProposed?: ((proposal: LeaderTierProposal) => void | Promise<void>) | undefined;
}

const SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['show', 'set'],
      description:
        'show — the active tier, every configured level and what it resolves to, plus the ' +
        'switch policy. set — request a move to another tier.',
    },
    tier: {
      type: 'string',
      description: 'Target tier id for "set" (e.g. "budget", "standard", "premium").',
    },
    reason: {
      type: 'string',
      description:
        'Why the switch is warranted, in one sentence. Shown to the user in propose mode, so ' +
        'say what about the work changed — not just that a cheaper model exists.',
    },
  },
  required: ['action'],
  additionalProperties: false,
};

interface Input {
  action: 'show' | 'set';
  tier?: string | undefined;
  reason?: string | undefined;
}

interface Output {
  status: 'ok' | 'error' | 'proposed';
  message: string;
}

export function createModelTierSetTool(opts: ModelTierSetToolOptions): Tool<Input, Output> {
  return {
    name: LEADER_TIER_SET_TOOL_NAME,
    description:
      'Inspect or change the leader\'s own cost tier (e.g. "budget" | "standard" | "premium"). ' +
      'Use "set" when the nature of the work has changed enough to justify a different class of ' +
      'model — dropping to a cheap tier for mechanical work, or asking for an expensive one when ' +
      "a decision is genuinely hard. Every request is checked against the user's guard rails " +
      '(minimum dwell between switches, target context window, spend ceiling, and whether the ' +
      'saving covers the prompt-cache re-warm the switch causes). By default an allowed switch is ' +
      'PROPOSED to the user rather than applied.',
    usageHint:
      'Start with {action:"show"} to see the levels and the policy. Then {action:"set", tier, reason}. ' +
      'A refusal explains which guard rejected it; do not retry the same switch immediately.',
    category: 'config',
    inputSchema: SCHEMA,
    permission: 'auto',
    mutating: true,
    riskTier: 'standard',
    icon: 'settings',

    async execute(input) {
      const config = opts.getConfig();
      const tiers = activeTierConfig(config);
      if (!tiers) {
        return {
          status: 'error',
          message:
            'The model-tier layer is not enabled. Set `modelTiers.enabled = true` and define ' +
            '`modelTiers.levels` first.',
        };
      }

      const currentTier = opts.getCurrentTier?.();
      const policy = leaderTierPolicy(config);

      if (input.action === 'show') {
        const lines: string[] = [
          `  active tier: ${currentTier ?? '(unset — routing table decides per spawn)'}`,
          `  leader mode: ${policy.mode}`,
          `  dwell: ${policy.dwellTurns} turn(s) · min saving: $${policy.minSavingsUsd} · ` +
            `context-fill cap: ${Math.round(policy.maxContextFillForSwitch * 100)}%` +
            (policy.maxTier ? ` · ceiling: ${policy.maxTier}` : ''),
          '',
        ];
        for (const id of listTierIds(config)) {
          const resolved = resolveTier(config, { tier: id });
          const target = resolved?.model
            ? `${resolved.provider ?? config.provider}/${resolved.model}`
            : '(no model — profile empty or unresolvable)';
          const budget = resolved?.budget ?? {};
          const budgetBits = [
            budget.maxCostUsd !== undefined ? `$${budget.maxCostUsd}` : '',
            budget.maxIterations !== undefined ? `${budget.maxIterations} iters` : '',
            budget.maxToolCalls !== undefined ? `${budget.maxToolCalls} tools` : '',
          ].filter(Boolean);
          lines.push(
            `  ${id}${id === currentTier ? ' *' : ''}: ${target}` +
              (budgetBits.length ? `  [${budgetBits.join(' · ')}]` : ''),
          );
        }
        return { status: 'ok', message: lines.join('\n') };
      }

      if (!input.tier) {
        return { status: 'error', message: 'Provide "tier" for the "set" action.' };
      }

      const resolved = resolveTier(config, { tier: input.tier });
      if (!resolved?.model) {
        const available = listTierIds(config);
        return {
          status: 'error',
          message:
            `Tier "${input.tier}" does not resolve to a model` +
            `${available.length ? ` (configured tiers: ${available.join(', ')})` : ''}.`,
        };
      }
      const targetProvider = resolved.provider ?? config.provider;
      const targetModel = resolved.model;

      // Economics are only meaningful against a real context size — every term
      // in the break-even model scales with it. A host that cannot report the
      // context would otherwise produce an all-zero projection, which reads as
      // "saves nothing" and would silently refuse EVERY downgrade. Treat an
      // unknown context as "no pricing data" instead, so the policy falls back
      // to its structural guards rather than to a fail-closed no-op.
      const contextTokens = opts.getContextTokens?.();
      const haveContext = typeof contextTokens === 'number' && contextTokens > 0;
      const [fromEconomics, toEconomics] = haveContext
        ? await Promise.all([
            opts.getModelEconomics?.(config.provider, config.model) ?? Promise.resolve(undefined),
            opts.getModelEconomics?.(targetProvider, targetModel) ?? Promise.resolve(undefined),
          ])
        : [undefined, undefined];

      const verdict = evaluateLeaderTierSwitch(config, {
        ...(currentTier ? { fromTier: currentTier } : {}),
        toTier: input.tier,
        contextTokens: haveContext ? contextTokens : 0,
        // A host that does not track switches must not be permanently blocked
        // by the dwell guard, so an unknown count reads as "long ago".
        turnsSinceSwitch: opts.getTurnsSinceTierSwitch?.() ?? Number.MAX_SAFE_INTEGER,
        economics: { from: fromEconomics ?? {}, to: toEconomics ?? {} },
      });

      if (!verdict.allowed) {
        return { status: 'error', message: `Refused (${verdict.code}): ${verdict.reason}` };
      }

      const proposal: LeaderTierProposal = {
        fromTier: currentTier,
        toTier: input.tier,
        target: { provider: targetProvider, model: targetModel },
        reason: input.reason?.trim() || verdict.reason,
        projectedSavingsUsd: verdict.economics.projectedSavingsUsd,
        reWarmCostUsd: verdict.economics.reWarmCostUsd,
      };

      if (verdict.mode === 'propose') {
        await opts.onTierProposed?.(proposal);
        return {
          status: 'proposed',
          message:
            `Proposed: ${currentTier ?? 'current'} → ${input.tier} ` +
            `(${targetProvider}/${targetModel}). ${verdict.reason} ` +
            'Awaiting the user — the model has NOT been changed. ' +
            'Set `modelTiers.leader.mode = "auto"` to let this apply without asking.',
        };
      }

      if (opts.switchProviderAndModel) {
        const switchError = await opts.switchProviderAndModel(targetProvider, targetModel);
        if (switchError) {
          return {
            status: 'error',
            message: `Could not switch to ${targetProvider}/${targetModel}: ${switchError}. Config was not changed.`,
          };
        }
      }

      await opts.updateConfig((cfg) => {
        cfg['provider'] = targetProvider;
        cfg['model'] = targetModel;
        if (resolved.fallbackModels?.length) cfg['fallbackModels'] = [...resolved.fallbackModels];
      });
      opts.onTierSwitched?.(input.tier);

      const liveNote = opts.switchProviderAndModel
        ? ''
        : ' (config updated — the live session keeps its current model until restart or /setmodel)';
      return {
        status: 'ok',
        message: `✓ Leader tier → ${input.tier} (${targetProvider}/${targetModel})${liveNote}\n  ${verdict.reason}`,
      };
    },
  };
}
