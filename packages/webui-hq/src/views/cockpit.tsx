/**
 * Cockpit — the whole fleet on one screen.
 *
 * Every card here duplicates a dedicated view on purpose: the point is triage
 * without navigation. Each one therefore ends in a jump to the surface that
 * can act on it, so the Cockpit is a starting point rather than a dead end.
 */
import type { HqAlert, HqSnapshot } from '@wrongstack/core/hq';
import {
  Activity,
  ArrowUpRight,
  BellRing,
  Bot,
  CircleDollarSign,
  Command,
  Gauge,
  type LucideIcon,
  Network,
  RadioTower,
  Server,
  ShieldCheck,
} from 'lucide-react';
import type * as React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { EmptyState, Mono, StatTile, StatusDot } from '../components/hq/primitives.js';
import { ShareBar } from '../components/hq/view-chrome.js';
import { Badge, type BadgeTone } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import { fetchJson, postCommand } from '../data/api.js';
import { type HqViewId, useHqStore } from '../data/store/index.js';
import type { HqTone } from '../domain/status-tone.js';
import { shortenId } from '../lib/format.js';
import { formatClock, formatPercent, formatUsd } from '../lib/format.js';
import { cn } from '../lib/utils.js';

const HEALTH_POLL_MS = 30_000;
const ALERTS_POLL_MS = 15_000;
/** Cockpit shows a digest, not the archive — the Attention view has the rest. */
const ALERT_DIGEST_LIMIT = 12;
const TOP_PROJECTS = 4;

interface SystemHealth {
  status: 'healthy' | 'degraded';
  uptime: { serverTime: string; eventLogSize: number };
  stores: { events: string; timeseries: string; kanban: string };
  connections: { total: number; active: number; stale: number };
}

interface AlertsResponse {
  active: HqAlert[];
  history: HqAlert[];
}

interface AlertDigestEntry {
  severity: string;
  ruleId: string;
  message: string;
  /**
   * ISO string from the live WS feed, epoch ms from `/api/alerts`. Kept as a
   * union rather than normalised: the previous implementation tested
   * `typeof … === 'string'` on the API's NUMBER and silently fell back to
   * `Date.now()`, so every polled alert claimed to have just fired.
   */
  timestamp: string | number;
}

type QuickAction = 'pause-noisy' | 'status-request';

function alertTone(severity: string): BadgeTone {
  if (severity === 'critical' || severity === 'error' || severity === 'high') return 'error';
  if (severity === 'warn' || severity === 'warning' || severity === 'medium') return 'warn';
  if (severity === 'info' || severity === 'low') return 'info';
  return 'idle';
}

function CockpitCard({
  icon: Icon,
  title,
  cta,
  view,
  tone,
  className,
  children,
}: {
  icon: LucideIcon;
  title: string;
  cta: string;
  view: HqViewId;
  tone?: 'attention' | 'positive';
  className?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Card
      data-testid="cockpit-card"
      data-tone={tone}
      className={cn(tone === 'attention' && 'border-warning/50', className)}
    >
      <CardHeader>
        <Icon />
        <CardTitle>{title}</CardTitle>
        <CardAction>
          <Button
            variant="ghost"
            size="sm"
            className="text-[11px] text-muted-foreground"
            onClick={() => useHqStore.getState().setActiveView(view)}
          >
            {cta}
            <ArrowUpRight className="size-3" />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function HeroMetric({
  icon: Icon,
  label,
  value,
  detail,
  tone = 'idle',
}: {
  icon: LucideIcon;
  label: string;
  value: string | number;
  detail: string;
  tone?: HqTone;
}): React.ReactElement {
  return (
    <div className="flex min-w-32 flex-col gap-0.5">
      <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.09em] text-muted-foreground">
        <Icon className="size-3" />
        {label}
      </span>
      <span
        className={cn(
          'tabular font-display text-2xl leading-none',
          tone === 'error'
            ? 'text-destructive'
            : tone === 'warn'
              ? 'text-warning'
              : tone === 'active'
                ? 'text-success'
                : 'text-foreground',
        )}
      >
        {value}
      </span>
      <span className="text-[10px] text-muted-foreground">{detail}</span>
    </div>
  );
}

function TokenStats({
  tokenStats,
}: {
  tokenStats: NonNullable<HqSnapshot['totals']['tokenStats']> | undefined;
}): React.ReactElement {
  // Absent on older snapshots — an additive field. Show a placeholder rather
  // than zeros, so "no data yet" is distinguishable from "zero tokens issued".
  if (tokenStats === undefined) {
    return <EmptyState title="Token stats unavailable on this HQ version" />;
  }
  const { browserTotal, clientTotal, expired, expiringSoon } = tokenStats;
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-3">
      <StatTile label="browser" value={browserTotal} />
      <StatTile label="client" value={clientTotal} />
      <StatTile label="total" value={browserTotal + clientTotal} />
      <StatTile label="expired" value={expired} tone={expired > 0 ? 'error' : 'idle'} />
      <StatTile
        label="expiring soon"
        value={expiringSoon}
        tone={expiringSoon > 0 ? 'warn' : 'idle'}
      />
    </div>
  );
}

export function CockpitView(): React.ReactElement {
  const { snapshot, alerts, selectedClientId, connected } = useHqStore(
    useShallow((state) => ({
      snapshot: state.snapshot,
      alerts: state.alerts,
      selectedClientId: state.selectedClientId,
      connected: state.connected,
    })),
  );

  const totals = snapshot?.totals;
  const machines = snapshot?.machines ?? [];
  const projects = snapshot?.projects ?? [];
  const clients = snapshot?.clients ?? [];
  const sessions = snapshot?.liveSessions ?? [];
  const fleets = snapshot?.fleets ?? [];

  const governanceProjects = projects.filter((project) => project.governance !== undefined);
  const governanceWarnings = governanceProjects.filter(
    (project) =>
      project.governance?.signal.level === 'warning' ||
      project.governance?.signal.level === 'unavailable',
  );

  const controllableClients = clients.filter((client) =>
    client.capabilities.includes('control.receive'),
  );
  const quickActionClient =
    controllableClients.find((client) => client.clientId === selectedClientId) ??
    controllableClients[0] ??
    null;

  const [activeAlerts, setActiveAlerts] = useState<HqAlert[]>([]);
  const [alertHistory, setAlertHistory] = useState<HqAlert[]>([]);
  const [alertsError, setAlertsError] = useState<string | null>(null);
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<QuickAction | null>(null);
  const [actionResult, setActionResult] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      fetchJson<SystemHealth>('/api/system/health')
        .then((data) => {
          if (cancelled) return;
          setHealth(data);
          setHealthError(null);
        })
        .catch((cause: unknown) => {
          if (!cancelled) setHealthError(cause instanceof Error ? cause.message : String(cause));
        });
    };
    load();
    const timer = window.setInterval(load, HEALTH_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      fetchJson<AlertsResponse>('/api/alerts')
        .then((data) => {
          if (cancelled) return;
          setActiveAlerts(data.active);
          setAlertHistory(data.history);
          setAlertsError(null);
        })
        .catch((cause: unknown) => {
          if (!cancelled) setAlertsError(cause instanceof Error ? cause.message : String(cause));
        });
    };
    load();
    const timer = window.setInterval(load, ALERTS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  /**
   * The digest merges the live WS feed with the polled API and dedupes on
   * (rule, message, time): the same alert legitimately arrives through both
   * channels, and showing it twice makes the fleet look worse than it is.
   */
  const alertDigest = useMemo<AlertDigestEntry[]>(() => {
    const fromLive = alerts
      .slice(-30)
      .reverse()
      .map<AlertDigestEntry>((alert) => ({
        severity: alert.severity,
        ruleId: alert.type ?? 'hq.alert',
        message: alert.message,
        timestamp: alert.timestamp,
      }));
    const fromApi = [...activeAlerts, ...alertHistory]
      .slice(-30)
      .reverse()
      .map<AlertDigestEntry>((entry) => ({
        severity: entry.severity,
        ruleId: entry.ruleId,
        message: entry.message,
        timestamp: entry.lastFiredAt ?? entry.firstFiredAt,
      }));

    const seen = new Set<string>();
    const digest: AlertDigestEntry[] = [];
    for (const entry of [...fromLive, ...fromApi]) {
      const key = `${entry.ruleId}|${entry.message}|${entry.timestamp}`;
      if (seen.has(key)) continue;
      seen.add(key);
      digest.push(entry);
      if (digest.length >= ALERT_DIGEST_LIMIT) break;
    }
    return digest;
  }, [alerts, activeAlerts, alertHistory]);

  const agents = useMemo(() => {
    let total = 0;
    let busy = 0;
    let waiting = 0;
    let errored = 0;
    let activeSessions = 0;
    for (const session of sessions) {
      if (session.status === 'active') activeSessions += 1;
      for (const agent of session.agents ?? []) {
        total += 1;
        if (agent.status === 'running' || agent.status === 'streaming') busy += 1;
        else if (agent.status === 'waiting_user') waiting += 1;
        else if (agent.status === 'error') errored += 1;
      }
    }
    return { total, busy, waiting, errored, activeSessions };
  }, [sessions]);

  const topProjects = useMemo(
    () =>
      [...projects]
        .sort((left, right) => right.totalCostUsd - left.totalCostUsd)
        .slice(0, TOP_PROJECTS),
    [projects],
  );

  /** Spawn ceilings, summed over the fleets that actually report them. */
  const spawnBudget = useMemo(() => {
    let used = 0;
    let max = 0;
    let remaining = 0;
    let known = 0;
    let mismatch = 0;
    for (const fleet of fleets) {
      if (typeof fleet.usedSpawns !== 'number' || typeof fleet.maxSpawns !== 'number') continue;
      known += 1;
      used += fleet.usedSpawns;
      if (Number.isFinite(fleet.maxSpawns)) max += fleet.maxSpawns;
      if (typeof fleet.remainingSpawns === 'number' && Number.isFinite(fleet.remainingSpawns)) {
        remaining += fleet.remainingSpawns;
      }
      if (fleet.ceilingMismatch) mismatch += 1;
    }
    return known > 0 ? { used, max, remaining, mismatch } : null;
  }, [fleets]);

  async function dispatchQuickAction(action: QuickAction): Promise<void> {
    if (quickActionClient === null) return;
    setBusyAction(action);
    setActionResult(null);
    setActionError(null);
    try {
      const payload =
        action === 'pause-noisy'
          ? {
              subject: 'HQ quick action: pause noisy agents',
              body: 'HQ operator requests: pause non-critical/noisy agent work, reduce chatter, and keep only essential status updates until resumed.',
              priority: 'high',
            }
          : {
              subject: 'HQ quick action: status request',
              body: 'HQ operator requests a concise status broadcast from active agents: current task, blocker if any, and next expected action.',
              priority: 'normal',
            };
      const result = await postCommand(quickActionClient.clientId, 'broadcast', payload);
      setActionResult(`queued ${result.commandId}`);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyAction(null);
    }
  }

  const attention = activeAlerts.length + governanceWarnings.length;
  const operationalTone: 'degraded' | 'attention' | 'nominal' =
    !connected || health?.status === 'degraded'
      ? 'degraded'
      : attention > 0
        ? 'attention'
        : 'nominal';
  const operationalLabel =
    operationalTone === 'degraded'
      ? 'Link degraded'
      : operationalTone === 'attention'
        ? 'Attention needed'
        : 'Systems nominal';

  return (
    <div className="flex flex-col gap-4 p-4">
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
            <Mono>{controllableClients.length} command-ready clients</Mono>
            {activeAlerts.length > 0 && (
              <Badge tone="error">{activeAlerts.length} active alerts</Badge>
            )}
            {governanceWarnings.length > 0 && (
              <Badge tone="error">{governanceWarnings.length} governance advisories</Badge>
            )}
            {alertsError !== null && <Badge tone="error">{alertsError}</Badge>}
          </div>
        </div>

        <div className="flex flex-wrap gap-x-8 gap-y-4">
          <HeroMetric
            icon={Bot}
            label="Active agents"
            value={totals?.activeAgents ?? 0}
            detail={`${agents.busy} working`}
          />
          <HeroMetric
            icon={Activity}
            label="Live sessions"
            value={totals?.activeSessions ?? 0}
            detail={`${machines.length} machines`}
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
            value={formatUsd(totals?.totalCostUsd ?? 0)}
            detail={`${projects.length} projects`}
          />
        </div>
      </section>

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

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={quickActionClient === null || busyAction !== null}
            onClick={() => void dispatchQuickAction('pause-noisy')}
          >
            {busyAction === 'pause-noisy' ? 'Queuing…' : 'Pause noisy agents'}
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

      {/* `grid-flow-row-dense` matters here: the cards have mixed spans and are
          conditionally rendered, so without it a wide card that cannot fit
          beside a narrow one leaves a visible hole in the bento. */}
      <div className="grid grid-flow-row-dense gap-3 xl:grid-cols-2 2xl:grid-cols-3">
        {(health !== null || healthError !== null) && (
          <CockpitCard
            icon={Server}
            title="System health"
            cta="open settings"
            view="settings"
            tone={health?.status === 'degraded' ? 'attention' : 'positive'}
            className="xl:col-span-2"
          >
            {healthError !== null ? (
              <EmptyState title={healthError} />
            ) : health !== null ? (
              <div className="flex flex-wrap gap-x-6 gap-y-3">
                <StatTile
                  label="status"
                  value={health.status}
                  tone={health.status === 'healthy' ? 'active' : 'error'}
                />
                <StatTile label="event log" value={health.uptime?.eventLogSize ?? 0} />
                <StatTile label="connections" value={health.connections?.total ?? 0} />
                <StatTile
                  label="active"
                  value={health.connections?.active ?? 0}
                  tone={(health.connections?.active ?? 0) > 0 ? 'active' : 'idle'}
                />
                <StatTile
                  label="stale"
                  value={health.connections?.stale ?? 0}
                  tone={(health.connections?.stale ?? 0) > 3 ? 'warn' : 'idle'}
                />
              </div>
            ) : null}
          </CockpitCard>
        )}

        <CockpitCard
          icon={Network}
          title="Fleet"
          cta="open fleet"
          view="fleet"
          className="xl:col-span-2"
        >
          <div className="flex flex-wrap gap-x-6 gap-y-3">
            <StatTile label="machines" value={machines.length} />
            <StatTile label="clients" value={clients.length} />
            <StatTile
              label="sessions"
              value={agents.activeSessions}
              tone={agents.activeSessions > 0 ? 'active' : 'idle'}
            />
            <StatTile label="agents" value={agents.total} />
            <StatTile
              label="busy"
              value={agents.busy}
              tone={agents.busy > 0 ? 'running' : 'idle'}
            />
            <StatTile
              label="waiting"
              value={agents.waiting}
              tone={agents.waiting > 0 ? 'warn' : 'idle'}
            />
            <StatTile
              label="errored"
              value={agents.errored}
              tone={agents.errored > 0 ? 'error' : 'idle'}
            />
            <StatTile label="cost" value={formatUsd(totals?.totalCostUsd ?? 0)} tone="active" />
            {spawnBudget !== null && (
              <>
                <StatTile
                  label="spawns"
                  value={`${spawnBudget.used}/${Number.isFinite(spawnBudget.max) ? spawnBudget.max : '∞'}`}
                  tone={spawnBudget.mismatch > 0 ? 'warn' : 'idle'}
                />
                <StatTile
                  label="spawns left"
                  value={Number.isFinite(spawnBudget.remaining) ? spawnBudget.remaining : '∞'}
                  tone={spawnBudget.remaining === 0 ? 'error' : 'idle'}
                />
              </>
            )}
          </div>
        </CockpitCard>

        <CockpitCard
          icon={Gauge}
          title="Governance advisory"
          cta="open fleet"
          view="fleet"
          tone={governanceWarnings.length > 0 ? 'attention' : 'positive'}
        >
          {governanceProjects.length === 0 ? (
            <EmptyState title="No project governance snapshots yet" />
          ) : (
            <div className="space-y-1">
              {governanceProjects.map((project) => {
                const governance = project.governance;
                if (governance === undefined) return null;
                const tone: BadgeTone =
                  governance.signal.level === 'healthy'
                    ? 'active'
                    : governance.signal.level === 'notice'
                      ? 'warn'
                      : 'error';
                return (
                  <div key={project.projectId} className="flex items-center gap-2 text-xs">
                    <Badge tone={tone}>{governance.signal.level}</Badge>
                    <span className="truncate">{project.projectName}</span>
                    <Mono className="truncate">{governance.signal.code}</Mono>
                    <Mono className="ml-auto shrink-0">
                      {governance.signal.executionDisposition}
                    </Mono>
                  </div>
                );
              })}
            </div>
          )}
        </CockpitCard>

        <CockpitCard icon={ShieldCheck} title="Auth tokens" cta="open settings" view="settings">
          <TokenStats tokenStats={totals?.tokenStats} />
        </CockpitCard>

        <CockpitCard
          icon={BellRing}
          title="Alerts"
          cta="open alerts"
          view="alerts"
          tone={alertDigest.length > 0 ? 'attention' : 'positive'}
          className="xl:col-span-2"
        >
          {alertDigest.length === 0 ? (
            <EmptyState title="No alerts in the last few minutes" />
          ) : (
            <div className="space-y-1">
              {alertDigest.map((entry) => (
                <div
                  key={`${entry.ruleId}-${entry.timestamp}-${entry.message}`}
                  className="flex items-center gap-2 text-xs"
                >
                  <Badge tone={alertTone(entry.severity)}>{entry.severity}</Badge>
                  <Mono className="shrink-0">{entry.ruleId}</Mono>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {entry.message}
                  </span>
                  <Mono className="tabular shrink-0">{formatClock(entry.timestamp)}</Mono>
                </div>
              ))}
            </div>
          )}
        </CockpitCard>

        <CockpitCard
          icon={CircleDollarSign}
          title="Cost"
          cta="open cost"
          view="cost"
          className="xl:col-span-2"
        >
          {topProjects.length === 0 ? (
            <EmptyState
              title="No cost data yet"
              hint="Connect a client to start reporting spend."
            />
          ) : (
            <div className="space-y-2.5">
              {topProjects.map((project) => {
                const share =
                  (totals?.totalCostUsd ?? 0) > 0 ? project.totalCostUsd / totals!.totalCostUsd : 0;
                return (
                  <div key={project.projectId} className="space-y-1">
                    <div className="flex items-baseline gap-2 text-xs">
                      <span className="truncate font-medium">{project.projectName}</span>
                      <Mono className="truncate">{project.projectId}</Mono>
                      <span className="tabular ml-auto shrink-0 font-semibold">
                        {formatUsd(project.totalCostUsd)}
                      </span>
                      <Mono className="tabular w-12 shrink-0 text-right">
                        {formatPercent(share, 1)}
                      </Mono>
                    </div>
                    <ShareBar fraction={share} />
                    <div className="flex gap-3 text-[10px] text-muted-foreground">
                      <span>{project.activeSessions} sessions</span>
                      <span>{project.activeSubagents} subagents</span>
                      <span>{project.activeClients} clients</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CockpitCard>
      </div>
    </div>
  );
}
