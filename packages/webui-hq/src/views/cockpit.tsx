/**
 * Cockpit view — compact HQ overview for Fleet, Alerts, and Cost.
 * Pulls the same data the dedicated views consume (snapshot +
 * alert envelope stream + alert API history) and renders a
 * single at-a-glance card grid so the operator can triage the
 * fleet without bouncing between tabs.
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
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { fetchJson, postCommand, useHqStore, type ViewId } from '../store.js';

interface SystemHealth {
  status: 'healthy' | 'degraded';
  uptime: { serverTime: string; eventLogSize: number };
  stores: { events: string; timeseries: string; kanban: string };
  connections: { total: number; active: number; stale: number };
}

interface CockpitAlertEntry {
  severity: 'info' | 'warn' | 'error' | 'critical' | string;
  ruleId: string;
  message: string;
  timestamp: string;
}

interface CockpitAlertsResponse {
  active: HqAlert[];
  history: HqAlert[];
}

interface CockpitSection {
  title: string;
  view: ViewId;
  cta: string;
  body: React.ReactNode;
  icon: LucideIcon;
  tone?: 'attention' | 'positive' | undefined;
  wide?: boolean | undefined;
}

type CockpitQuickAction = 'pause-noisy' | 'status-request';

export function CockpitView(): React.ReactElement {
  const {
    snapshot: snap,
    alerts,
    selectedClientId,
    connected,
  } = useHqStore(
    useShallow((s) => ({
      snapshot: s.snapshot,
      alerts: s.alerts,
      selectedClientId: s.selectedClientId,
      connected: s.connected,
    })),
  );
  const snapshot = snap;
  const totals = snapshot?.totals;
  const machines = snapshot?.machines ?? [];
  const projects = snapshot?.projects ?? [];
  const clients = snapshot?.clients ?? [];
  const sessions = snapshot?.liveSessions ?? [];
  const governanceProjects = projects.filter((project) => project.governance !== undefined);
  const governanceWarnings = governanceProjects.filter(
    (project) =>
      project.governance?.signal.level === 'warning' ||
      project.governance?.signal.level === 'unavailable',
  );

  const controllableClients = clients.filter((client) =>
    client.capabilities.includes('control.receive'),
  );
  const quickActionClientId = selectedClientId ?? controllableClients[0]?.clientId ?? null;
  const quickActionClient =
    controllableClients.find((client) => client.clientId === quickActionClientId) ??
    controllableClients[0] ??
    null;

  const [apiActive, setApiActive] = useState<HqAlert[]>([]);
  const [apiHistory, setApiHistory] = useState<HqAlert[]>([]);
  const [alertsError, setAlertsError] = useState<string | null>(null);
  const [quickActionBusy, setQuickActionBusy] = useState<CockpitQuickAction | null>(null);
  const [quickActionStatus, setQuickActionStatus] = useState<string | null>(null);
  const [quickActionError, setQuickActionError] = useState<string | null>(null);
  const [systemHealth, setSystemHealth] = useState<SystemHealth | null>(null);
  const [systemHealthError, setSystemHealthError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadHealth = (): void => {
      fetchJson<SystemHealth>('/api/system/health')
        .then((data) => {
          if (!cancelled) {
            setSystemHealth(data);
            setSystemHealthError(null);
          }
        })
        .catch((err: unknown) => {
          if (!cancelled) setSystemHealthError(err instanceof Error ? err.message : String(err));
        });
    };
    loadHealth();
    const healthTimer = setInterval(loadHealth, 30_000);
    return () => {
      cancelled = true;
      clearInterval(healthTimer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      fetchJson<CockpitAlertsResponse>('/api/alerts')
        .then((data) => {
          if (!cancelled) {
            setApiActive(data.active);
            setApiHistory(data.history);
            setAlertsError(null);
          }
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            setAlertsError(err instanceof Error ? err.message : String(err));
          }
        });
    };
    load();
    const timer = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const liveAlerts: CockpitAlertEntry[] = useMemo(() => {
    const liveRecent = alerts
      .slice(-30)
      .reverse()
      .map<CockpitAlertEntry>((alert) => ({
        severity: typeof alert.severity === 'string' ? alert.severity : 'info',
        ruleId: alert.type ?? 'hq.alert',
        message: typeof alert.message === 'string' ? alert.message : 'Alert envelope received',
        timestamp: typeof alert.timestamp === 'string' ? alert.timestamp : new Date().toISOString(),
      }));
    const fromApi = [...(apiActive ?? []), ...(apiHistory ?? [])]
      .slice(-30)
      .reverse()
      .map<CockpitAlertEntry>((entry) => ({
        severity: typeof entry.severity === 'string' ? entry.severity : 'info',
        ruleId: typeof entry.ruleId === 'string' ? entry.ruleId : 'alert',
        message: typeof entry.message === 'string' ? entry.message : '',
        timestamp:
          typeof entry.lastFiredAt === 'string'
            ? entry.lastFiredAt
            : typeof entry.firstFiredAt === 'string'
              ? entry.firstFiredAt
              : new Date().toISOString(),
      }));
    const merged = [...liveRecent, ...fromApi];
    const seen = new Set<string>();
    const deduped: CockpitAlertEntry[] = [];
    for (const entry of merged) {
      const key = `${entry.ruleId}|${entry.message}|${entry.timestamp}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(entry);
      if (deduped.length >= 12) break;
    }
    return deduped;
  }, [alerts, apiActive, apiHistory]);

  const agentRollup = useMemo(() => {
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
    () => [...projects].sort((a, b) => b.totalCostUsd - a.totalCostUsd).slice(0, 4),
    [projects],
  );

  async function dispatchQuickAction(action: CockpitQuickAction): Promise<void> {
    if (quickActionClient === null) return;
    setQuickActionBusy(action);
    setQuickActionStatus(null);
    setQuickActionError(null);
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
      const res = await postCommand(quickActionClient.clientId, 'broadcast', payload);
      setQuickActionStatus(`queued ${res.commandId}`);
    } catch (err) {
      setQuickActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setQuickActionBusy(null);
    }
  }

  const fleets = snapshot?.fleets ?? [];
  const spawnBudget = useMemo(() => {
    let used = 0;
    let max = 0;
    let remaining = 0;
    let known = 0;
    let mismatch = 0;
    for (const f of fleets) {
      if (typeof f.usedSpawns === 'number' && typeof f.maxSpawns === 'number') {
        known += 1;
        used += f.usedSpawns;
        if (Number.isFinite(f.maxSpawns)) max += f.maxSpawns;
        if (typeof f.remainingSpawns === 'number' && Number.isFinite(f.remainingSpawns)) {
          remaining += f.remainingSpawns;
        }
        if (f.ceilingMismatch) mismatch += 1;
      }
    }
    return known > 0 ? { used, max, remaining, known, mismatch } : null;
  }, [fleets]);

  const fleetSections: CockpitSection[] = [
    {
      title: 'Fleet',
      view: 'fleet',
      cta: 'open fleet',
      icon: Network,
      wide: true,
      body: (
        <div className="hq-cockpit-grid">
          <Stat label="machines" value={machines.length} />
          <Stat label="clients" value={clients.length} />
          <Stat
            label="sessions"
            value={agentRollup.activeSessions}
            accent={agentRollup.activeSessions > 0 ? 'green' : undefined}
          />
          <Stat label="agents" value={agentRollup.total} />
          <Stat
            label="busy"
            value={agentRollup.busy}
            accent={agentRollup.busy > 0 ? 'green' : undefined}
          />
          <Stat
            label="waiting"
            value={agentRollup.waiting}
            accent={agentRollup.waiting > 0 ? 'warn' : undefined}
          />
          <Stat
            label="errored"
            value={agentRollup.errored}
            accent={agentRollup.errored > 0 ? 'error' : undefined}
          />
          <Stat label="cost $" value={(totals?.totalCostUsd ?? 0).toFixed(2)} accent="green" />
          {spawnBudget && (
            <Stat
              label="spawns"
              value={`${spawnBudget.used}/${Number.isFinite(spawnBudget.max) ? spawnBudget.max : '∞'}`}
              accent={spawnBudget.mismatch > 0 ? 'warn' : undefined}
            />
          )}
          {spawnBudget && (
            <Stat
              label="spawns left"
              value={Number.isFinite(spawnBudget.remaining) ? spawnBudget.remaining : '∞'}
              accent={spawnBudget.remaining === 0 ? 'error' : undefined}
            />
          )}
        </div>
      ),
    },
  ];

  const tokenStatsSection: CockpitSection = {
    title: 'Auth Tokens',
    view: 'settings',
    cta: 'open settings',
    icon: ShieldCheck,
    body: <TokenStatsCard tokenStats={totals?.tokenStats} />,
  };

  const governanceSection: CockpitSection = {
    title: 'Governance Advisory',
    view: 'fleet',
    cta: 'open fleet',
    icon: Gauge,
    tone: governanceWarnings.length > 0 ? 'attention' : 'positive',
    body:
      governanceProjects.length === 0 ? (
        <div className="hq-empty hq-cockpit-empty">No project governance snapshots yet.</div>
      ) : (
        <div className="hq-cockpit-alert-list">
          {governanceProjects.map((project) => {
            const governance = project.governance;
            if (governance === undefined) return null;
            const tone =
              governance.signal.level === 'healthy'
                ? 'green'
                : governance.signal.level === 'notice'
                  ? 'warn'
                  : 'error';
            return (
              <div key={project.projectId} className="hq-cockpit-alert-row">
                <span className={`hq-pill ${tone}`}>{governance.signal.level}</span>
                <span>{project.projectName}</span>
                <span className="hq-mono hq-cockpit-alert-msg">{governance.signal.code}</span>
                <span className="hq-mono hq-text-dim hq-ml-auto">
                  {governance.signal.executionDisposition}
                </span>
              </div>
            );
          })}
        </div>
      ),
  };

  const alertSection: CockpitSection = {
    title: 'Alerts',
    view: 'alerts',
    cta: 'open alerts',
    icon: BellRing,
    tone: liveAlerts.length > 0 ? 'attention' : 'positive',
    wide: true,
    body:
      liveAlerts.length === 0 ? (
        <div className="hq-empty hq-cockpit-empty">No alerts in the last few minutes.</div>
      ) : (
        <div className="hq-cockpit-alert-list">
          {liveAlerts.map((alert, index) => (
            <div
              key={`${alert.ruleId}-${alert.timestamp}-${index}`}
              className="hq-cockpit-alert-row"
            >
              <span className={'hq-pill ' + alertTone(alert.severity)}>{alert.severity}</span>
              <span className="hq-mono">{alert.ruleId}</span>
              <span className="hq-cockpit-alert-msg">{alert.message}</span>
              <span className="hq-mono hq-text-dim hq-ml-auto">{formatTime(alert.timestamp)}</span>
            </div>
          ))}
        </div>
      ),
  };

  const costSection: CockpitSection = {
    title: 'Cost',
    view: 'cost',
    cta: 'open cost',
    icon: CircleDollarSign,
    wide: true,
    body:
      topProjects.length === 0 ? (
        <div className="hq-empty hq-cockpit-empty">No cost data yet — connect some clients.</div>
      ) : (
        <div className="hq-cockpit-cost-list">
          {topProjects.map((project) => {
            const pct =
              (totals?.totalCostUsd ?? 0) > 0
                ? (project.totalCostUsd / totals!.totalCostUsd) * 100
                : 0;
            return (
              <div key={project.projectId} className="hq-cockpit-cost-row">
                <div className="hq-cockpit-cost-line">
                  <span className="hq-cockpit-cost-name">{project.projectName}</span>
                  <span className="hq-mono hq-text-dim">{project.projectId}</span>
                  <span className="hq-mono hq-cockpit-cost-amount hq-ml-auto">
                    ${project.totalCostUsd.toFixed(4)}
                  </span>
                  <span className="hq-mono hq-text-dim">{pct.toFixed(1)}%</span>
                </div>
                <div
                  className="hq-cockpit-cost-bar"
                  role="progressbar"
                  aria-label={`${project.projectName} share of fleet cost`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Number(pct.toFixed(1))}
                >
                  <span style={{ width: `${Math.max(2, pct)}%` }} />
                </div>
                <div className="hq-cockpit-cost-meta">
                  <span>{project.activeSessions} sessions</span>
                  <span>{project.activeSubagents} subagents</span>
                  <span>{project.activeClients} clients</span>
                </div>
              </div>
            );
          })}
        </div>
      ),
  };

  const attentionCount = (apiActive?.length ?? 0) + governanceWarnings.length;
  const operationalTone =
    !connected || systemHealth?.status === 'degraded'
      ? 'degraded'
      : attentionCount > 0
        ? 'attention'
        : 'nominal';
  const operationalLabel =
    operationalTone === 'degraded'
      ? 'Link degraded'
      : operationalTone === 'attention'
        ? 'Attention needed'
        : 'Systems nominal';

  return (
    <div className="hq-cockpit-screen">
      <section className="hq-cockpit-hero" data-tone={operationalTone}>
        <div className="hq-cockpit-hero-copy">
          <div className="hq-cockpit-kicker">
            <span className="hq-cockpit-pulse" aria-hidden="true" />
            {operationalLabel}
          </div>
          <h2>Operational picture</h2>
          <p>
            Live fleet health, agent activity, governance and spend — resolved into one command
            surface.
          </p>
          <div className="hq-cockpit-hero-meta">
            <span>
              {snapshot?.generatedAt
                ? `Snapshot ${formatTime(snapshot.generatedAt)}`
                : 'Awaiting first snapshot'}
            </span>
            <span>{controllableClients.length} command-ready clients</span>
          </div>
          <div className="hq-cockpit-signals" role="status" aria-label="Operational signals">
            {(apiActive?.length ?? 0) > 0 && (
              <span className="hq-pill error">{apiActive?.length ?? 0} active alerts</span>
            )}
            {governanceWarnings.length > 0 && (
              <span className="hq-pill error">
                {governanceWarnings.length} governance advisories
              </span>
            )}
            {alertsError !== null && <span className="hq-pill error">{alertsError}</span>}
          </div>
        </div>
        <fieldset className="hq-cockpit-hero-metrics" aria-label="Fleet headline metrics">
          <HeroMetric
            icon={Bot}
            label="Active agents"
            value={totals?.activeAgents ?? 0}
            detail={`${agentRollup.busy} working`}
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
            value={attentionCount}
            detail={attentionCount > 0 ? 'review signals' : 'all clear'}
            tone={attentionCount > 0 ? 'attention' : 'positive'}
          />
          <HeroMetric
            icon={CircleDollarSign}
            label="Total cost"
            value={`$${(totals?.totalCostUsd ?? 0).toFixed(2)}`}
            detail={`${projects.length} projects`}
            tone="positive"
          />
        </fieldset>
      </section>

      <section className="hq-cockpit-command-bar" aria-label="Cockpit quick actions">
        <div className="hq-cockpit-command-copy">
          <span className="hq-cockpit-command-icon">
            <Command size={17} />
          </span>
          <div>
            <strong>Command strip</strong>
            <span className="hq-mono">
              {quickActionClient === null
                ? 'No controllable client connected'
                : `Target ${shortId(quickActionClient.clientId)}`}
            </span>
          </div>
        </div>
        <div className="hq-cockpit-actions-buttons">
          <button
            type="button"
            className="hq-btn secondary"
            disabled={quickActionClient === null || quickActionBusy !== null}
            onClick={() => void dispatchQuickAction('pause-noisy')}
          >
            {quickActionBusy === 'pause-noisy' ? 'Queuing…' : 'Pause noisy agents'}
          </button>
          <button
            type="button"
            className="hq-btn secondary"
            disabled={quickActionClient === null || quickActionBusy !== null}
            onClick={() => void dispatchQuickAction('status-request')}
          >
            {quickActionBusy === 'status-request' ? 'Queuing…' : 'Request fleet status'}
          </button>
          <button
            type="button"
            className="hq-btn hq-cockpit-primary-action"
            onClick={() => useHqStore.getState().setActiveView('control')}
          >
            <RadioTower size={13} /> Open control
          </button>
        </div>
        {quickActionStatus !== null && <span className="hq-pill info">{quickActionStatus}</span>}
        {quickActionError !== null && <span className="hq-pill error">{quickActionError}</span>}
      </section>

      <div className="hq-cockpit-section-label">
        <span>Live intelligence</span>
        <span>{alertsError !== null ? alertsError : `${projects.length} projects in scope`}</span>
      </div>

      <div className="hq-cockpit-bento">
        {(systemHealth !== null || systemHealthError !== null) && (
          <div
            className="hq-card hq-cockpit-section"
            data-tone={systemHealth?.status === 'degraded' ? 'attention' : 'positive'}
          >
            <CockpitCardHeader
              icon={Server}
              title="System Health"
              cta="open settings"
              onClick={() => useHqStore.getState().setActiveView('settings')}
            />
            {systemHealthError !== null ? (
              <div className="hq-empty hq-cockpit-empty">{systemHealthError}</div>
            ) : systemHealth !== null ? (
              <div className="hq-cockpit-grid">
                <Stat
                  label="status"
                  value={systemHealth.status}
                  accent={systemHealth.status === 'healthy' ? 'green' : 'error'}
                />
                <Stat label="event log" value={systemHealth.uptime?.eventLogSize ?? 0} />
                <Stat label="connections" value={systemHealth.connections?.total ?? 0} />
                <Stat
                  label="active"
                  value={systemHealth.connections?.active ?? 0}
                  accent={(systemHealth.connections?.active ?? 0) > 0 ? 'green' : undefined}
                />
                <Stat
                  label="stale"
                  value={systemHealth.connections?.stale ?? 0}
                  accent={(systemHealth.connections?.stale ?? 0) > 3 ? 'warn' : undefined}
                />
              </div>
            ) : null}
          </div>
        )}

        {[...fleetSections, governanceSection, tokenStatsSection, alertSection, costSection].map(
          (section) => (
            <div
              key={section.title}
              className="hq-card hq-cockpit-section"
              data-tone={section.tone}
              data-wide={section.wide}
            >
              <CockpitCardHeader
                icon={section.icon}
                title={section.title}
                cta={section.cta}
                onClick={() => useHqStore.getState().setActiveView(section.view)}
              />
              {section.body}
            </div>
          ),
        )}
      </div>
    </div>
  );
}

function CockpitCardHeader({
  icon: Icon,
  title,
  cta,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  cta: string;
  onClick: () => void;
}): React.ReactElement {
  return (
    <div className="hq-cockpit-card-head">
      <span className="hq-cockpit-card-icon">
        <Icon size={15} />
      </span>
      <span className="hq-cockpit-section-title">{title}</span>
      <button type="button" className="hq-cockpit-card-link" onClick={onClick}>
        {cta}
        <ArrowUpRight size={13} />
      </button>
    </div>
  );
}

function HeroMetric({
  icon: Icon,
  label,
  value,
  detail,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  value: string | number;
  detail: string;
  tone?: 'attention' | 'positive';
}): React.ReactElement {
  return (
    <div className="hq-cockpit-hero-metric" data-tone={tone}>
      <Icon size={15} />
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number;
  accent?: 'green' | 'warn' | 'error';
}): React.ReactElement {
  return (
    <div className={'hq-stat' + (accent ? ` ${accent}` : '')}>
      <span className="hq-stat-num">{value}</span>
      <span className="hq-stat-label">{label}</span>
    </div>
  );
}

type TokenStats = NonNullable<HqSnapshot['totals']['tokenStats']>;

function TokenStatsCard({
  tokenStats,
}: {
  tokenStats: TokenStats | undefined;
}): React.ReactElement {
  // Absent on older snapshots — additive field, default undefined. Show a
  // neutral placeholder instead of zeros so the operator can tell "no data
  // yet" apart from "zero tokens issued".
  if (tokenStats === undefined) {
    return (
      <div className="hq-empty hq-cockpit-empty">
        Token expiry stats unavailable on this HQ version.
      </div>
    );
  }
  const { browserTotal, clientTotal, expired, expiringSoon } = tokenStats;
  const total = browserTotal + clientTotal;
  return (
    <fieldset
      className="hq-cockpit-grid"
      aria-label="Auth token stats"
      style={{ border: 0, margin: 0, padding: 0 }}
    >
      <Stat label="browser" value={browserTotal} />
      <Stat label="client" value={clientTotal} />
      <Stat label="total" value={total} />
      <Stat label="expired" value={expired} accent={expired > 0 ? 'error' : undefined} />
      <Stat
        label="expiring soon"
        value={expiringSoon}
        accent={expiringSoon > 0 ? 'warn' : undefined}
      />
    </fieldset>
  );
}

function shortId(id: string): string {
  if (id.length <= 18) return id;
  return `${id.slice(0, 9)}…${id.slice(-6)}`;
}

function formatTime(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  return date.toLocaleTimeString();
}

function alertTone(severity: string): 'info' | 'warn' | 'error' | 'idle' {
  if (severity === 'critical' || severity === 'error' || severity === 'high') return 'error';
  if (severity === 'warn' || severity === 'warning' || severity === 'medium') return 'warn';
  if (severity === 'info' || severity === 'low') return 'info';
  return 'idle';
}
