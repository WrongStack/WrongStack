import type { BrainDecisionRequest, BrainRisk } from './brain.js';
import { BRAIN_RISK_LEVELS } from './brain.js';

/** Runtime-adjustable autonomy ceiling for the tiered brain. */
export type BrainAutoRisk = 'off' | 'low' | 'medium' | 'high' | 'all';

/** Resolve an autonomy ceiling to a level comparable against `BRAIN_RISK_LEVELS`. */
export function resolveRiskCeiling(ceiling: BrainAutoRisk | undefined): number {
  if (ceiling === 'off') return -1;
  if (ceiling === 'all') return 3;
  return BRAIN_RISK_LEVELS[ceiling ?? 'medium'] ?? 1;
}

/** Shared eligibility for real arbitration and side-effect-free explanation. */
export function brainTierEligibility(
  request: BrainDecisionRequest,
  ceiling: BrainAutoRisk | BrainRisk | undefined,
  councilEnabled: boolean,
  councilMinRisk: 'medium' | 'high' | 'critical' = 'high',
): { autonomous: boolean; council: boolean; systemOne: boolean } {
  const risk = BRAIN_RISK_LEVELS[request.risk] ?? 2;
  const autonomous = risk <= (ceiling === 'critical' ? 3 : resolveRiskCeiling(ceiling));
  const floor = BRAIN_RISK_LEVELS[councilEnabled ? councilMinRisk : 'high'] ?? 2;
  return {
    autonomous,
    council: autonomous && councilEnabled && risk >= floor,
    systemOne: autonomous && risk < floor && (request.options?.length ?? 0) > 1,
  };
}
