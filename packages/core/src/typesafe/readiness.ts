import type { Config } from '@wrongstack/contracts/types/config/root';

export type JevReadiness = 'disabled' | 'account-required' | 'blocked' | 'conditional';
export interface JevFeatureReadiness {
  state: JevReadiness;
  reason:
    | 'disabled'
    | 'account-required'
    | 'selective-required'
    | 'tiers-disabled'
    | 'tiers-required'
    | 'skills-disabled'
    | 'memory-disabled'
    | 'recall-injection-required'
    | 'trigger-required';
}

/** Configuration eligibility, not proof that a session installed or used the consumer. */
export function jevFeatureReadiness(
  config: Readonly<Config>,
  features: Record<string, boolean>,
  accountReady: boolean,
): Record<string, JevFeatureReadiness> {
  const strategy =
    config.context?.strategy ?? (config.context?.llmSelector ? 'selective' : 'hybrid');
  return Object.fromEntries(
    Object.entries(features).map(([feature, enabled]) => {
      let reason: JevFeatureReadiness['reason'] = 'trigger-required';
      if (config.typesafe?.enabled !== true || !enabled) reason = 'disabled';
      else if (!accountReady) reason = 'account-required';
      else if (
        (feature === 'memoryRecall' || feature === 'memoryTriage') &&
        (config.features?.memory === false || config.Sage?.enabled === false)
      )
        reason = 'memory-disabled';
      else if (feature === 'memoryRecall' && config.Sage?.inject?.turnContext !== true)
        reason = 'recall-injection-required';
      else if (feature === 'compaction' && strategy !== 'selective') reason = 'selective-required';
      else if (feature === 'modelTier' && config.modelTiers?.enabled !== true)
        reason = 'tiers-disabled';
      else if (feature === 'modelTier' && Object.keys(config.modelTiers?.levels ?? {}).length < 2)
        reason = 'tiers-required';
      else if (feature === 'skillSuggestion' && config.features?.skills === false)
        reason = 'skills-disabled';
      const state: JevReadiness =
        reason === 'trigger-required'
          ? 'conditional'
          : reason === 'disabled'
            ? 'disabled'
            : reason === 'account-required'
              ? 'account-required'
              : 'blocked';
      return [feature, { state, reason }];
    }),
  );
}
