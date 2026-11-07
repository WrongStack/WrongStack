import type { Usage } from '@wrongstack/contracts/types';
import type { AgentServicesInput } from './backend-services-types.js';
import { resolveProviderModelMetadata } from './model-catalog.js';
import { computeUsageCost, getCostRates } from './usage-cost.js';

const LEGACY_CONTEXT_TIER = 200_000;

function finiteRate(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function consumed(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Largest context tier a single request is over. Same thresholds as `getCostRates`. */
function contextTier(
  cost: Record<string, unknown>,
  contextTokens: number,
): Record<string, unknown> | undefined {
  if (!(contextTokens > 0)) return undefined;
  let best: { size: number; rates: Record<string, unknown> } | undefined;
  const consider = (size: number, rates: Record<string, unknown>) => {
    if (contextTokens > size && (!best || size > best.size)) best = { size, rates };
  };
  if (Array.isArray(cost['tiers'])) {
    for (const row of cost['tiers'] as Array<Record<string, unknown>>) {
      const tier = row?.['tier'] as { type?: unknown; size?: unknown } | undefined;
      if (tier?.type === 'context' && typeof tier.size === 'number' && tier.size > 0) {
        consider(tier.size, row);
      }
    }
  }
  const legacy = cost['context_over_200k'];
  if (typeof legacy === 'number') consider(LEGACY_CONTEXT_TIER, { input: legacy });
  else if (legacy && typeof legacy === 'object') {
    consider(LEGACY_CONTEXT_TIER, legacy as Record<string, unknown>);
  }
  return best?.rates;
}

function pickedRate(
  tier: Record<string, unknown> | undefined,
  cost: Record<string, unknown>,
  key: string,
): number | undefined {
  const tierValue = tier?.[key];
  return finiteRate(tierValue !== undefined && tierValue !== null ? tierValue : cost[key]);
}

/** Goal budgets use live catalog/custom rates, retaining unknown prices as null. */
export function createGoalUsagePricer(
  input: Pick<AgentServicesInput, 'modelsRegistry' | 'config' | 'getConfig'>,
) {
  return async (
    usage: Usage,
    source: { providerId: string; model: string },
  ): Promise<number | null> => {
    if (!source.providerId || !source.model) return null;
    const metadata = await resolveProviderModelMetadata(
      input.modelsRegistry,
      source.providerId,
      source.model,
      (input.getConfig?.() ?? input.config).providers?.[source.providerId],
    ).catch(() => undefined);
    const cost = (metadata as { cost?: unknown } | undefined)?.cost;
    if (!metadata || !cost || typeof cost !== 'object') return null;
    // One response is one request: its context selects the catalog's context price tier.
    const context = usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
    const rates = cost as Record<string, unknown>;
    const tier = contextTier(rates, context);
    const inputRate = pickedRate(tier, rates, 'input');
    const outputRate = pickedRate(tier, rates, 'output');
    // Explicit 0 is free. A missing rate on tokens that were consumed is unknown,
    // not $0 — a goal budget would otherwise treat paid output as a free model.
    if (consumed(usage.input) > 0 && inputRate === undefined) return null;
    if (consumed(usage.output) > 0 && outputRate === undefined) return null;
    return computeUsageCost(usage, getCostRates(metadata, context));
  };
}
