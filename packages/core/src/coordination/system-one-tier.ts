/**
 * System One tier suggestion for a delegated task.
 *
 * The tier ladder (`classifyTier`) is deterministic: an explicit tier, then the
 * routing table by role and phase, then the `*` default. For a delegation with
 * no explicit tier and no role/phase route, every task lands on the same
 * default level — a one-line rename and a cross-package refactor cost the
 * same. Which level a task needs is a judgment about the TASK TEXT, which is
 * what a System One `Choice` over the configured levels answers.
 *
 * It fills exactly that gap and nothing else:
 *
 *   - only when `modelTiers` is enabled with at least two levels,
 *   - only when the ladder would fall to its default (a role or phase route
 *     the user configured is a decision, not a gap),
 *   - only when the caller named neither a tier nor a model/provider,
 *   - only when the Choice is concentrated; otherwise the default stands.
 *
 * The chosen id then travels as the spawn's tier and goes through the same
 * resolution, budget tightening and ceilings as a tier the leader named.
 */

import type { Config } from '@wrongstack/contracts/types/config';
import type { TypeSafeJudge } from '../typesafe/judgments.js';
import { activeTierConfig, classifyTier, listTierIds, tierLevel } from './model-tier.js';

export interface SystemOneTierSuggesterOptions {
  getConfig: () => Config | undefined;
  getJudge: () => TypeSafeJudge | undefined;
  /** Minimum Choice confidence to override the default. Default 0.6. */
  minConfidence?: number | undefined;
  timeoutMs?: number | undefined;
}

export type SystemOneTierSuggester = (input: {
  task: string | undefined;
  role?: string | undefined;
}) => Promise<string | undefined>;

export function createSystemOneTierSuggester(
  opts: SystemOneTierSuggesterOptions,
): SystemOneTierSuggester {
  const minConfidence = opts.minConfidence ?? 0.6;
  const timeoutMs = opts.timeoutMs ?? 3_000;

  return async ({ task, role }) => {
    try {
      const config = opts.getConfig();
      if (!config || !task?.trim() || !activeTierConfig(config)) return undefined;
      const ids = listTierIds(config);
      if (ids.length < 2) return undefined;
      const decision = classifyTier(config, { role });
      if (!decision || decision.source === 'role' || decision.source === 'phase') return undefined;
      const judge = opts.getJudge();
      if (!judge) return undefined;

      // Declaration order IS the ladder (cheapest first), so say so: a level
      // name the user invented carries no meaning of its own.
      const criteria: Record<string, string> = {};
      ids.forEach((id, i) => {
        const description = tierLevel(config, id)?.description?.trim();
        const position =
          i === 0
            ? 'the cheapest level'
            : i === ids.length - 1
              ? 'the most capable and most expensive level'
              : `level ${i + 1} of ${ids.length} by cost and capability`;
        criteria[id] = `${description ? `${description} — ` : ''}${position}.`;
      });

      const result = await judge.client.systemOne(
        {
          activityFeature: judge.feature,
          state: { task: task.slice(0, 6_000), ...(role ? { role } : {}) },
          questions: {
            tier: {
              type: 'choice',
              instructions:
                'Which model level does `task` need? Mechanical, well-specified or small work ' +
                'fits a cheaper level; ambiguous, cross-cutting or costly-to-get-wrong work ' +
                'needs a more capable one.',
              criteria,
            },
          },
          model: judge.model,
        },
        AbortSignal.timeout(timeoutMs),
      );
      const answer = result.answers['tier'];
      if (answer?.type !== 'choice' || !ids.includes(answer.choice)) return undefined;
      if (answer.confidence < minConfidence) return undefined;
      return answer.choice === decision.tier ? undefined : answer.choice;
    } catch {
      return undefined;
    }
  };
}
