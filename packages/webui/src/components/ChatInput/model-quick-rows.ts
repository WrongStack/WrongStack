import { acpAgentName } from '@wrongstack/contracts/types/agent-identity';
import { resolveProviderBrand } from '@wrongstack/project-surfaces/lib/provider-brand';
import type { QuotaSnapshot } from '@wrongstack/project-surfaces/providers/provider-quota-store';
import {
  providerQuotaStatus,
  type SwitcherStatus,
} from '@wrongstack/project-surfaces/providers/switcher-status';
import type { ModelCandidate } from '@/hooks/useProviderModels';

const ACP = 'acp';

/** One row of the composer's quick switcher: a provider (expands to its models) or an ACP agent. */
export interface QuickRow {
  /** Stable key: the provider id, or `acp/<agent>` for an ACP agent. */
  key: string;
  provider: string;
  providerType?: string | undefined;
  name: string;
  /** The model a pick switches to: an agent's id, or the session's model on its own provider. */
  model?: string | undefined;
  agent: boolean;
  current: boolean;
  status: SwitcherStatus;
  /** The provider's models, favourites first; empty for an agent row. */
  models: ModelCandidate[];
}

export interface QuickRowsInput {
  candidates: readonly ModelCandidate[];
  session: { provider: string; model: string };
  quota: readonly QuotaSnapshot[];
}

/**
 * The provider's display name: its brand when known, else the profile id. A second profile of
 * one vendor (`openai-2`) keeps its id beside the brand, so two profiles never read the same.
 */
export function providerName(provider: string, providerType?: string): string {
  const brand = resolveProviderBrand(provider, undefined, providerType);
  if (!brand) return provider;
  return provider.toLowerCase() === brand.id ? brand.name : `${brand.name} · ${provider}`;
}

/**
 * Rows for the composer's quick switcher: one per provider with models, each ACP agent as a row
 * of its own. Two groups, the session's kind first (agents for an ACP session); the session's
 * row leads its group, then providers with favourites, then by name.
 */
export function quickRows({ candidates, session, quota }: QuickRowsInput): QuickRow[] {
  const byProvider = new Map<string, ModelCandidate[]>();
  for (const candidate of candidates) {
    const list = byProvider.get(candidate.provider) ?? [];
    list.push(candidate);
    byProvider.set(candidate.provider, list);
  }
  const rows: QuickRow[] = [];
  for (const [provider, models] of byProvider) {
    if (provider === ACP) continue;
    const current = provider === session.provider;
    rows.push({
      key: provider,
      provider,
      providerType: models[0]?.providerType,
      name: providerName(provider, models[0]?.providerType),
      model: current ? session.model : undefined,
      agent: false,
      current,
      status: providerQuotaStatus(provider, quota),
      models: [...models].sort(
        (a, b) =>
          Number(b.model === session.model && current) -
            Number(a.model === session.model && current) ||
          Number(b.isFavorite) - Number(a.isFavorite),
      ),
    });
  }
  if (session.provider && session.provider !== ACP && !byProvider.has(session.provider))
    rows.push({
      key: session.provider,
      provider: session.provider,
      name: providerName(session.provider),
      model: session.model || undefined,
      agent: false,
      current: true,
      status: providerQuotaStatus(session.provider, quota),
      models: [],
    });
  const agents = (byProvider.get(ACP) ?? []).map((candidate) => candidate.model);
  if (session.provider === ACP && session.model && !agents.includes(session.model))
    agents.unshift(session.model);
  for (const agent of agents)
    rows.push({
      key: `${ACP}/${agent}`,
      provider: ACP,
      name: acpAgentName(agent),
      model: agent,
      agent: true,
      current: session.provider === ACP && session.model === agent,
      status: providerQuotaStatus(`${ACP}/${agent}`, quota),
      models: [],
    });
  const agentsFirst = session.provider === ACP;
  const group = (row: QuickRow) => (row.agent === agentsFirst ? 0 : 1);
  const favourite = (row: QuickRow) => Number(row.models.some((model) => model.isFavorite));
  return rows.sort(
    (a, b) =>
      group(a) - group(b) ||
      Number(b.current) - Number(a.current) ||
      favourite(b) - favourite(a) ||
      a.name.localeCompare(b.name),
  );
}
