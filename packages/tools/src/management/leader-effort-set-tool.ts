/**
 * `leader_effort_set` — the leader raising or lowering its OWN reasoning effort
 * when the work changes shape, the way `leader_model_set` lets it change its
 * own model.
 *
 * Scope is this conversation only and nothing is persisted: the user's
 * project-wide effort and the conversation's effort pref are left untouched,
 * and any later change the user makes to either wins over the leader (see
 * `utils/leader-effort-override.ts`). Workers are unaffected — their
 * effort is chosen per delegation (`effort` on `delegate` / `spawn_subagent`).
 */

import { ToolValidationError } from '@wrongstack/contracts/types/errors';
import {
  isReasoningEffort,
  REASONING_EFFORT_LEVELS,
  type ReasoningConfig,
  type ReasoningEffort,
} from '@wrongstack/contracts/types/provider';
import type { SessionEvent } from '@wrongstack/contracts/types/session';
import type { JSONSchema, Tool } from '@wrongstack/contracts/types/tool';
import {
  activeLeaderEffort,
  clearLeaderEffortOverride,
  type LeaderEffortOverride,
  nearestSupportedEffort,
  readLeaderEffortOverride,
  writeLeaderEffortOverride,
} from '@wrongstack/core/execution';
import type { FallbackManageToolOptions } from './fallback-manage-tool-options.js';

export const LEADER_EFFORT_SET_TOOL_NAME = 'leader_effort_set';

export interface LeaderEffortSetToolOptions {
  /**
   * Reasoning profile of a provider/model pair, from the models catalog. Used
   * to show the levels the leader's model supports and to map a request onto
   * the nearest one. Absent or unknown → any documented level is accepted and
   * the request pipeline does the gating.
   */
  getReasoningConfig?:
    | ((providerId: string, modelId: string) => Promise<ReasoningConfig | undefined>)
    | undefined;
  /**
   * Observer for UIs (the host emits `leader.effort_changed`). `effort`
   * undefined = reset to the user's setting.
   */
  onEffortChanged?:
    | ((change: {
        sessionId: string;
        effort?: ReasoningEffort | undefined;
        reason?: string | undefined;
      }) => void)
    | undefined;
}

const SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['show', 'set', 'reset'],
      description:
        "show — your current effort, where it comes from, and the levels your model supports. set — change your own effort. reset — drop your change so the user's setting applies again.",
    },
    effort: {
      type: 'string',
      enum: [...REASONING_EFFORT_LEVELS],
      description: 'Required for "set". Mapped onto the nearest level your model supports.',
    },
    reason: {
      type: 'string',
      description: 'For "set": one short line on why the work now needs this effort.',
    },
  },
  required: ['action'],
  additionalProperties: false,
};

interface Input {
  action: 'show' | 'set' | 'reset';
  effort?: string | undefined;
  reason?: string | undefined;
}

interface Output {
  status: 'ok';
  message: string;
  effort?: ReasoningEffort | undefined;
}

export function createLeaderEffortSetTool(
  opts: FallbackManageToolOptions & LeaderEffortSetToolOptions,
): Tool<Input, Output> {
  // Journaled so `/resume` brings the override back (last event wins).
  const journal = async (
    ctx: { session?: { append?: (event: SessionEvent) => unknown } | undefined },
    override: LeaderEffortOverride | null,
  ): Promise<void> => {
    try {
      await ctx.session?.append?.({
        type: 'leader_effort',
        ts: new Date().toISOString(),
        override,
      });
    } catch {
      // Best-effort like every journal append: the live change already applied.
    }
  };
  const notify = (
    ctx: { eventSessionId?: (() => string) | undefined },
    effort: ReasoningEffort | undefined,
    reason?: string | undefined,
  ): void => {
    if (!opts.onEffortChanged) return;
    try {
      opts.onEffortChanged({
        sessionId: ctx.eventSessionId?.() ?? '',
        ...(effort ? { effort } : {}),
        ...(reason ? { reason } : {}),
      });
    } catch {
      // A UI observer failing must not undo or fail the change itself.
    }
  };
  return {
    name: LEADER_EFFORT_SET_TOOL_NAME,
    description:
      'Change YOUR OWN reasoning effort for the rest of this conversation when the work changes shape: raise it before deep debugging, design, security or review work where being wrong is costly; lower it for a run of mechanical, well-specified steps. Takes effect on your next model call and is mapped onto the levels your model supports. Session-only and never persisted; if the user changes effort themselves afterwards, their choice wins. Change it at phase boundaries, not every step — on some providers each change re-reads the cached prompt. Worker effort is chosen separately, per delegation.',
    usageHint:
      '"show" first if unsure what you run at. "set" with effort (+ a one-line reason). "reset" returns to the user\'s setting.',
    category: 'config',
    inputSchema: SCHEMA,
    permission: 'auto',
    // Conversation state only — no files, no config. Keeping it non-mutating
    // means plan mode and the required-skills gate do not block it.
    mutating: false,
    riskTier: 'standard',
    icon: 'settings',
    async execute(input, ctx) {
      const meta = ctx.meta;
      const projectEffort = opts.getConfig().modelRuntime?.reasoning?.effort;
      const conversationEffort =
        typeof meta['reasoningEffort'] === 'string' && meta['reasoningEffort'] !== 'auto'
          ? (meta['reasoningEffort'] as string)
          : undefined;
      const leader = activeLeaderEffort(meta, projectEffort);
      const current = leader ?? conversationEffort ?? projectEffort;
      const source = leader
        ? 'set by you (leader_effort_set)'
        : conversationEffort
          ? "this conversation's setting (user)"
          : projectEffort
            ? 'project setting (user)'
            : 'provider default';

      let rc: ReasoningConfig | undefined;
      try {
        rc = await opts.getReasoningConfig?.(ctx.provider.id, ctx.model);
      } catch {
        rc = undefined;
      }
      const levels = rc?.effortSupported === true && rc.effortLevels.length ? rc.effortLevels : [];

      if (input.action === 'show') {
        const rec = readLeaderEffortOverride(meta);
        const lines = [
          `  model: ${ctx.provider.id}/${ctx.model}`,
          `  effort: ${current ?? '(not set)'} — ${source}`,
          `  levels: ${
            rc?.effortSupported === false
              ? 'none (this model has no effort control)'
              : levels.length
                ? levels.join(', ')
                : 'not documented (any level is forwarded; the transport gates it)'
          }`,
        ];
        if (rec && !leader) {
          lines.push(
            `  your earlier change (${rec.effort}) no longer applies — the user changed effort since`,
          );
        } else if (rec?.reason) {
          lines.push(`  reason: ${rec.reason}`);
        }
        return {
          status: 'ok',
          message: lines.join('\n'),
          ...(isReasoningEffort(current) ? { effort: current } : {}),
        };
      }

      if (input.action === 'reset') {
        const had = clearLeaderEffortOverride(meta);
        if (had) {
          await journal(ctx, null);
          notify(ctx, undefined);
        }
        const userEffort = conversationEffort ?? projectEffort;
        return {
          status: 'ok',
          message: had
            ? `✓ Effort back to the user's setting (${userEffort ?? 'provider default'}).`
            : `No change of yours to reset — effort is ${userEffort ?? 'the provider default'}.`,
          ...(isReasoningEffort(userEffort) ? { effort: userEffort } : {}),
        };
      }

      if (input.action !== 'set') {
        throw new ToolValidationError({
          message: `Unknown action "${String(input.action)}". Use show, set or reset.`,
          field: 'action',
        });
      }
      if (!isReasoningEffort(input.effort)) {
        throw new ToolValidationError({
          message: `"set" needs effort, one of: ${REASONING_EFFORT_LEVELS.join(', ')}.`,
          field: 'effort',
        });
      }
      if (rc?.effortSupported === false) {
        throw new Error(
          `${ctx.provider.id}/${ctx.model} has no effort control, so there is nothing to change.`,
        );
      }
      let applied: ReasoningEffort = input.effort;
      let note = '';
      if (levels.length && !levels.includes(applied)) {
        const nearest = nearestSupportedEffort(applied, levels);
        if (!nearest) {
          throw new ToolValidationError({
            message: `${ctx.provider.id}/${ctx.model} does not support "${applied}" (supported: ${levels.join(', ')}).`,
            field: 'effort',
          });
        }
        note = ` (asked for ${applied}; nearest this model supports)`;
        applied = nearest;
      }
      if (applied === current && leader === applied) {
        return { status: 'ok', message: `Effort is already ${applied}.`, effort: applied };
      }
      const reason = input.reason?.trim().slice(0, 200) || undefined;
      const rec = writeLeaderEffortOverride(meta, applied, projectEffort, reason);
      await journal(ctx, rec);
      notify(ctx, applied, reason);
      return {
        status: 'ok',
        message: `✓ Your effort → ${applied}${note}, from your next call. Was ${current ?? 'provider default'}.`,
        effort: applied,
      };
    },
  };
}
