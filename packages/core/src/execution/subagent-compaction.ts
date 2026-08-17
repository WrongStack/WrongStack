import type { AgentPipelines } from '../core/agent-types.js';
import type { Context } from '../core/context.js';
import type { EventBus } from '../kernel/events.js';
import {
  type ContextWindowConfigLike,
  resolveContextWindowPolicy,
} from '../types/context-window.js';
import { AutoCompactionMiddleware } from './auto-compaction-middleware.js';
import { HybridCompactor } from './compactor.js';

/**
 * Install proactive auto-compaction into a subagent's context-window pipeline.
 *
 * Subagents (CLI fleet host, the light webui/SDD factory) build their pipelines
 * with `createDefaultPipelines()` and historically registered nothing on
 * `contextWindow`, so they had **no proactive compaction** — they grew until a
 * provider rejected the request and only then recovered reactively. This wires
 * the same rule-based `HybridCompactor` + `AutoCompactionMiddleware` the leader
 * uses, so a subagent shrinks on the warn/soft/hard thresholds (and gets the
 * last-resort emergency trim) exactly like the leader.
 *
 * No custom estimator is passed: the middleware's internal
 * `estimateRequestTokensCalibrated` default already applies per-(provider,model)
 * calibration, which is what a subagent wants. Returns the middleware (so the
 * caller could toggle it) or `undefined` when the provider window is unknown
 * (0), in which case compaction is skipped rather than guessing a denominator.
 */
export function installSubagentAutoCompaction(
  pipelines: AgentPipelines,
  ctx: Context,
  contextConfig: ContextWindowConfigLike | undefined,
  events?: EventBus | undefined,
): AutoCompactionMiddleware | undefined {
  const maxContext = ctx.provider?.capabilities?.maxContext ?? 0;
  if (!(maxContext > 0)) return undefined;

  const policy = resolveContextWindowPolicy(contextConfig ?? {}, undefined, maxContext);
  ctx.meta ??= {};
  // Publish the policy so the compactor (preserveK/eliseThreshold) and the
  // middleware's policyProvider + emergency-trim preserveK all read it.
  ctx.meta['contextWindowPolicy'] = policy;

  const compactor = new HybridCompactor({
    preserveK: policy.preserveK,
    eliseThreshold: policy.eliseThreshold,
    smart: true,
  });

  const middleware = new AutoCompactionMiddleware(
    compactor,
    maxContext,
    undefined,
    policy.thresholds,
    {
      aggressiveOn: policy.aggressiveOn,
      failureMode: 'throw_on_hard',
      events,
      policyProvider: (c) => {
        const p = c.meta?.['contextWindowPolicy'];
        return p && typeof p === 'object'
          ? (p as {
              thresholds: { warn: number; soft: number; hard: number };
              aggressiveOn: 'hard' | 'soft' | 'warn';
              targetLoad: number;
            })
          : null;
      },
    },
  );

  pipelines.contextWindow.use({ name: 'AutoCompaction', handler: middleware.handler() });
  return middleware;
}
