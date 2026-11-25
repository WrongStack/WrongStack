import type { BrainDecisionRequest, BrainRisk } from './brain.js';
import { BRAIN_RISK_LEVELS } from './brain.js';

/** Runtime-adjustable autonomy ceiling for the tiered brain. */
export type BrainAutoRisk = 'off' | 'low' | 'medium' | 'high' | 'all';

function riskLevelOf(key: string | undefined, fallback: number): number {
  return key && Object.hasOwn(BRAIN_RISK_LEVELS, key)
    ? (BRAIN_RISK_LEVELS[key as BrainRisk] ?? fallback)
    : fallback;
}

/** Resolve an autonomy ceiling to a level comparable against `BRAIN_RISK_LEVELS`. */
export function resolveRiskCeiling(ceiling: BrainAutoRisk | undefined): number {
  if (ceiling === 'off') return -1;
  if (ceiling === 'all') return 3;
  return riskLevelOf(ceiling ?? 'medium', 1);
}

/** Shared eligibility for real arbitration and side-effect-free explanation. */
export function brainTierEligibility(
  request: BrainDecisionRequest,
  ceiling: BrainAutoRisk | BrainRisk | undefined,
  councilEnabled: boolean,
  councilMinRisk: 'medium' | 'high' | 'critical' = 'high',
): { autonomous: boolean; council: boolean; systemOne: boolean } {
  // Unknown/malformed risk labels fail closed as critical (3) so they cannot
  // bypass a 'high' autonomy ceiling.
  const risk = riskLevelOf(request.risk, 3);
  const autonomous = risk <= (ceiling === 'critical' ? 3 : resolveRiskCeiling(ceiling));
  const floor = riskLevelOf(councilEnabled ? councilMinRisk : 'high', 2);
  return {
    autonomous,
    council: autonomous && councilEnabled && risk >= floor,
    systemOne: autonomous && risk < floor && (request.options?.length ?? 0) > 1,
  };
}
