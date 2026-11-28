import { acpAgentName } from '@wrongstack/contracts/types/agent-identity';
import type { QuotaSnapshot } from '@wrongstack/project-surfaces/providers/provider-quota-store';
import { quotaWindowLabel } from '@wrongstack/project-surfaces/providers/provider-quota-store';
import { quotaLevel, worstWindow } from '@wrongstack/project-surfaces/providers/quota-model';
import type { RecentModel } from './model-recents';
import { providerDisabled } from './model-visibility';
import type { ProviderChoice } from './provider-settings-model';

/** What a switcher row says on its right: the one fact that decides whether to pick it. */
export type SwitcherStatus =
  | { kind: 'none' }
  | { kind: 'needs-key' }
  | {
      kind: 'quota';
      /** Share of the busiest window still left, 0-100. */
      left: number;
      window: string;
      level: 'ok' | 'warn' | 'critical';
      /** The window's reset, epoch seconds. */
      resetsAt?: number | undefined;
    }
  | { kind: 'reached'; window: string; resetsAt?: number | undefined };

export interface SwitcherRow {
  /** Stable key: the provider id, or `acp/<agent>` for an ACP agent. */
  key: string;
  provider: string;
  /** The model a click switches to; unknown rows expand instead of guessing. */
  model?: string | undefined;
  name: string;
  /** The model shown under the name: the session's, else the last one picked here. */
  subtitle?: string | undefined;
  agent: boolean;
  current: boolean;
  status: SwitcherStatus;
}

export interface SwitcherInput {
  choices: readonly ProviderChoice[];
  session: { provider: string; model: string };
  recents: readonly RecentModel[];
  /** The ACP agents the engine offers (the `acp` provider's model ids). */
  acpAgents: readonly string[];
  quota: readonly QuotaSnapshot[];
  policy: Record<string, unknown>;
}

const ACP = 'acp';

/** A saved provider with nothing to sign in with: the engine cannot call it yet. */
export function needsKey(choice: ProviderChoice): boolean {
  return choice.saved && !choice.hostServed && choice.keys.length === 0;
}

/** The status a provider's meters give it: a cut-off window first, else the busiest one. */
function quotaStatus(provider: string, quota: readonly QuotaSnapshot[]): SwitcherStatus {
  // A gateway pool account running out does not cut the session off: the gateway rotates.
  const meters = quota.filter((meter) => meter.providerId === provider && meter.via === undefined);
  const worst = worstWindow(meters);
  if (!worst) return { kind: 'none' };
  const window = quotaWindowLabel(worst.window);
  if (worst.reached) return { kind: 'reached', window, resetsAt: worst.window.resetsAt };
  const used = Math.min(100, Math.max(0, worst.window.usedPercent));
  return {
    kind: 'quota',
    left: Math.round(100 - used),
    window,
    level: quotaLevel(used, false),
    resetsAt: worst.window.resetsAt,
  };
}

/**
 * The rows of the composer's model switcher: one per usable provider, with each ACP agent as a
 * row of its own. Providers the profile hides are left out unless the session is on them.
 */
export function switcherRows(input: SwitcherInput): SwitcherRow[] {
  const { choices, session, recents, acpAgents, quota, policy } = input;
  const lastPicked = (provider: string) => recents.find((item) => item.provider === provider);
  const rows: SwitcherRow[] = [];
  const offered = (choice: ProviderChoice) =>
    (choice.saved || choice.hostServed === true) &&
    !providerDisabled(policy['disabledProviders'], choice.id);
  for (const choice of choices) {
    if (choice.id === ACP) continue;
    const current = choice.id === session.provider;
    if (!current && !offered(choice)) continue;
    const model = current ? session.model : lastPicked(choice.id)?.model;
    rows.push({
      key: choice.id,
      provider: choice.id,
      model: model || undefined,
      name: choice.name,
      subtitle: model || undefined,
      agent: false,
      current,
      status: needsKey(choice) ? { kind: 'needs-key' } : quotaStatus(choice.id, quota),
    });
  }
  const acp = choices.find((choice) => choice.id === ACP);
  if (acp && (offered(acp) || session.provider === ACP)) {
    const agents = [...acpAgents];
    if (session.provider === ACP && session.model && !agents.includes(session.model))
      agents.unshift(session.model);
    for (const agent of agents)
      rows.push({
        key: `${ACP}/${agent}`,
        provider: ACP,
        model: agent,
        name: acpAgentName(agent),
        agent: true,
        current: session.provider === ACP && session.model === agent,
        status: quotaStatus(`${ACP}/${agent}`, quota),
      });
  }
  // Two groups, the session's kind first (agents for an ACP session); its own row leads.
  const agentsFirst = session.provider === ACP;
  const group = (row: SwitcherRow) => (row.agent === agentsFirst ? 0 : 1);
  return rows.sort((a, b) => group(a) - group(b) || Number(b.current) - Number(a.current));
}
