import type { Config, Provider, Usage } from '@wrongstack/contracts/types';
import type { EnhanceFailureKind } from '@wrongstack/core/execution';
import {
  type RefinedMission,
  refineGoalWithProvider,
  resolveRefinerTarget,
} from '@wrongstack/goal';

/** Goal-path refinement outcome, enriched for the emitting surface:
 * failures carry the EnhanceFailureKind and the refiner's reason text. */
export interface GoalRefineOutcome {
  result: 'success' | 'timeout' | 'provider_error' | 'empty' | 'cancelled';
  providerId: string;
  model: string;
  durationMs: number;
  reason?: string | undefined;
  failureKind?: EnhanceFailureKind | undefined;
}

/** Bind Goal refinement to the requesting session, then follow CLI fallback order. */
export function createGoalRefinerAdapter(opts: {
  config?: Config | undefined;
  primaryProvider?: Provider | undefined;
  primaryModel?: string | undefined;
  activeProviderId?: string | undefined;
  createProvider?: ((providerId: string) => Provider | undefined) | undefined;
  /** Token-usage hook: fired by the serving tier with the reported usage. */
  onUsage?: ((usage: Usage, source: { providerId: string; model: string }) => void) | undefined;
  /** Terminal-disposition hook: fired exactly once per refine attempt. */
  onOutcome?: ((outcome: GoalRefineOutcome) => void) | undefined;
}): ((goal: string) => Promise<RefinedMission | null>) | undefined {
  const { config, primaryProvider, primaryModel } = opts;
  if (!primaryProvider || !primaryModel) return undefined;
  /** Captures the failure kind+reason from onError, then re-emits the core
   * outcome enriched with the serving provider/model for the surface. */
  const bindOutcome = (providerId: string, model: string) => {
    let failure: { kind: EnhanceFailureKind | undefined; reason: string } | undefined;
    return {
      onError: (reason: string, kind?: EnhanceFailureKind): void => {
        failure = { kind, reason };
      },
      onOutcome: (o: {
        result: 'success' | 'timeout' | 'provider_error' | 'empty' | 'cancelled';
        durationMs: number;
      }): void => {
        if (o.result === 'success') {
          opts.onOutcome?.({ result: 'success', providerId, model, durationMs: o.durationMs });
          return;
        }
        opts.onOutcome?.({
          result: o.result,
          providerId,
          model,
          durationMs: o.durationMs,
          reason: failure?.reason,
          failureKind: failure?.kind,
        });
      },
    };
  };
  const target = config
    ? resolveRefinerTarget(
        config,
        opts.createProvider,
        opts.activeProviderId ?? config.provider ?? primaryProvider.id,
        primaryModel,
      )
    : undefined;
  return async (goal) => {
    if (target) {
      const outcome = bindOutcome(target.provider.id, target.model);
      const result = await refineGoalWithProvider(goal, target.provider, target.model, {
        onUsage: opts.onUsage,
        onError: outcome.onError,
        onOutcome: outcome.onOutcome,
      });
      if (result) return result;
      if (target.provider === primaryProvider && target.model === primaryModel) return null;
    }
    const primaryOutcome = bindOutcome(primaryProvider.id, primaryModel);
    return refineGoalWithProvider(goal, primaryProvider, primaryModel, {
      onUsage: opts.onUsage,
      onError: primaryOutcome.onError,
      onOutcome: primaryOutcome.onOutcome,
    });
  };
}
