/** Cockpit header sections: the operational hero, the attention strip and the command strip. */
import type { HqSnapshot } from '@wrongstack/hq';
import {
  Activity,
  ArrowUpRight,
  BellRing,
  Bot,
  CircleDollarSign,
  Command,
  type LucideIcon,
  RadioTower,
} from 'lucide-react';
import type * as React from 'react';
import { Mono, StatusDot } from '../components/hq/primitives.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Select } from '../components/ui/input.js';
import { type HqViewId, useHqStore } from '../data/store/index.js';
import { controlClientLabel } from '../domain/control-format.js';
import { formatClock, formatUsd, shortenId } from '../lib/format.js';
import { cn } from '../lib/utils.js';
import { HeroMetric } from './cockpit-cards.js';
import { useCockpitQuickActions } from './use-cockpit-data.js';

export type OperationalTone = 'degraded' | 'attention' | 'nominal';

export interface CockpitReviewItem {
  label: string;
  count: number;
  view: HqViewId;
  icon: LucideIcon;
}

type HqClient = HqSnapshot['clients'][number];

export function CockpitHero({
  operationalTone,
  operationalLabel,
  connected,
  snapshot,
  commandReadyClients,
  activeAlertCount,
  governanceWarningCount,
  alertsError,
  busyAgents,
  machineCount,
  projectCount,
  attention,
}: {
  operationalTone: OperationalTone;
  operationalLabel: string;
  connected: boolean;
  snapshot: HqSnapshot | null;
  commandReadyClients: number;
  activeAlertCount: number;
  governanceWarningCount: number;
  alertsError: string | null;
  busyAgents: number;
  machineCount: number;
  projectCount: number;
  attention: number;
}): React.ReactElement {
  const totals = snapshot?.totals;
  return (
    <section
      data-testid="cockpit-hero"
      data-tone={operationalTone}
      className={cn(
        'flex flex-wrap items-start gap-x-10 gap-y-4 border-l-2 bg-card/40 py-1 pl-4',
        operationalTone === 'degraded'
          ? 'border-destructive'
          : operationalTone === 'attention'
            ? 'border-warning'
            : 'border-success',
      )}
    >
      <div className="min-w-64 flex-1 space-y-1">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.11em] text-muted-foreground">
          <StatusDot
            tone={
              operationalTone === 'degraded'
                ? 'error'
                : operationalTone === 'attention'
                  ? 'warn'
                  : 'active'
            }
            pulse={operationalTone === 'nominal' && connected}
          />
          {operationalLabel}
        </div>
        <h2 className="font-display text-2xl leading-none">Operational picture</h2>
        <p className="max-w-prose text-xs text-muted-foreground">
          Live fleet health, agent activity, governance and spend on one surface.
        </p>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Mono>
            {snapshot?.generatedAt !== undefined
              ? `Snapshot ${formatClock(snapshot.generatedAt)}`
              : 'Awaiting first snapshot'}
          </Mono>
          <Mono>{commandReadyClients} command-ready clients</Mono>
          {activeAlertCount > 0 && <Badge tone="error">{activeAlertCount} active alerts</Badge>}
          {governanceWarningCount > 0 && (
            <Badge tone="error">{governanceWarningCount} governance advisories</Badge>
          )}
          {alertsError !== null && <Badge tone="error">{alertsError}</Badge>}
        </div>
      </div>

      <div className="flex flex-wrap gap-x-8 gap-y-4">
        <HeroMetric
          icon={Bot}
          label="Active agents"
          value={totals?.activeAgents ?? totals?.activeSubagents ?? '—'}
          detail={`${busyAgents} working`}
        />
        <HeroMetric
          icon={Activity}
          label="Live sessions"
          value={totals?.activeSessions ?? '—'}
          detail={`${machineCount} machines`}
        />
        <HeroMetric
          icon={BellRing}
          label="Attention"
          value={attention}
          detail={attention > 0 ? 'review signals' : 'all clear'}
          tone={attention > 0 ? 'warn' : 'active'}
        />
        <HeroMetric
          icon={CircleDollarSign}
          label="Total cost"
          value={totals === undefined ? '—' : formatUsd(totals.totalCostUsd)}
          detail={`${projectCount} projects`}
        />
      </div>
    </section>
  );
}

export function CockpitAttentionStrip({
  reviewItems,
}: {
  reviewItems: CockpitReviewItem[];
}): React.ReactElement {
  return (
    <section aria-label="Needs your attention" className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
      {reviewItems
        .filter((item) => item.count > 0)
        .map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.label}
              type="button"
              aria-label={`${item.label} ${item.count}`}
              onClick={() => useHqStore.getState().setActiveView(item.view)}
              className="flex items-center gap-2 border border-warning/35 bg-warning/5 px-3 py-2 text-left hover:bg-warning/10"
            >
              <Icon className="size-4 shrink-0 text-warning" />
              <span className="flex-1 text-xs">{item.label}</span>
              <span className="tabular font-display text-lg font-semibold">{item.count}</span>
              <ArrowUpRight className="size-3 shrink-0 text-muted-foreground" />
            </button>
          );
        })}
    </section>
  );
}

export function CockpitCommandStrip({
  quickActionClient,
  controllableClients,
  snapshot,
}: {
  quickActionClient: HqClient | null;
  controllableClients: HqClient[];
  snapshot: HqSnapshot | null;
}): React.ReactElement {
  const { busyAction, actionResult, actionError, dispatchQuickAction } = useCockpitQuickActions(
    quickActionClient?.clientId ?? null,
  );
  return (
    <section
      aria-label="Cockpit quick actions"
      className="flex flex-wrap items-center gap-2 border border-border bg-card px-3 py-2"
    >
      <Command className="size-4 shrink-0 text-muted-foreground" />
      <div className="flex flex-col leading-tight">
        <strong className="text-xs">Command strip</strong>
        <Mono>
          {quickActionClient === null
            ? 'No controllable client connected'
            : `Target ${shortenId(quickActionClient.clientId, 9, 6)}`}
        </Mono>
      </div>

      <Select
        aria-label="Quick action target"
        className="w-full sm:w-64"
        value={quickActionClient?.clientId ?? ''}
        disabled={busyAction !== null || controllableClients.length === 0}
        onChange={(event) => useHqStore.getState().selectClient(event.target.value || null)}
      >
        {quickActionClient === null && <option value="">Select a command target</option>}
        {controllableClients.map((client) => (
          <option key={client.clientId} value={client.clientId}>
            {controlClientLabel(client, snapshot)}
          </option>
        ))}
      </Select>

      <div className="ml-auto flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={quickActionClient === null || busyAction !== null}
          onClick={() => void dispatchQuickAction('pause-noisy')}
          // A mailbox broadcast the agents read and may act on — nothing is
          // halted. The label used to promise a pause the command never did;
          // a hard stop is Control → abort.
          title="Broadcasts a high-priority request to reduce activity. Agents are not stopped; use Control → abort for that."
        >
          {busyAction === 'pause-noisy' ? 'Queuing…' : 'Ask agents to quiet down'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={quickActionClient === null || busyAction !== null}
          onClick={() => void dispatchQuickAction('status-request')}
        >
          {busyAction === 'status-request' ? 'Queuing…' : 'Request fleet status'}
        </Button>
        <Button size="sm" onClick={() => useHqStore.getState().setActiveView('control')}>
          <RadioTower />
          Open control
        </Button>
      </div>
      {actionResult !== null && <Badge tone="info">{actionResult}</Badge>}
      {actionError !== null && <Badge tone="error">{actionError}</Badge>}
    </section>
  );
}
