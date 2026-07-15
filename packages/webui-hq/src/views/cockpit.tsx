/**
 * Cockpit view — compact HQ overview for Fleet, Alerts, and Cost.
 * Pulls the same data the dedicated views consume (snapshot +
 * alert envelope stream + alert API history) and renders a
 * single at-a-glance card grid so the operator can triage the
 * fleet without bouncing between tabs.
 */

import type { HqAlert } from '@wrongstack/core';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { fetchJson, postCommand, useHqStore, type ViewId } from '../store.js';

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
}

type CockpitQuickAction = 'pause-noisy' | 'status-request';

export function CockpitView(): React.ReactElement {
  const { snapshot: snap, alerts, selectedClientId, connected } = useHqStore(
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
        ruleId: 'live',
        message: 'Live alert envelope received.',
        timestamp: typeof alert.timestamp === 'string' ? alert.timestamp : new Date().toISOString(),
      }));
    const fromApi = [...apiActive, ...apiHistory]
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

  const fleetSections: CockpitSection[] = [
    {
      title: 'Fleet',
      view: 'fleet',
      cta: 'open fleet',
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
        </div>
      ),
    },
  ];

  const alertSection: CockpitSection = {
    title: 'Alerts',
    view: 'alerts',
    cta: 'open alerts',
    body:
      liveAlerts.length === 0 ? (
        <div className="hq-empty hq-cockpit-empty">
          No alerts in the last few minutes.
        </div>
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
              <span className="hq-mono hq-text-dim hq-ml-auto">
                {formatTime(alert.timestamp)}
              </span>
            </div>
          ))}
        </div>
      ),
  };

  const costSection: CockpitSection = {
    title: 'Cost',
    view: 'cost',
    cta: 'open cost',
    body:
      topProjects.length === 0 ? (
        <div className="hq-empty hq-cockpit-empty">
          No cost data yet — connect some clients.
        </div>
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
                  <span className="hq-mono hq-text-dim">
                    {project.projectId}
                  </span>
                  <span className="hq-mono hq-cockpit-cost-amount hq-ml-auto">
                    ${project.totalCostUsd.toFixed(4)}
                  </span>
                  <span className="hq-mono hq-text-dim">
                    {pct.toFixed(1)}%
                  </span>
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

  return (
    <div>
      <div className="hq-card-title">Cockpit</div>
      <div className="hq-card hq-cockpit-summary">
        <div className="hq-row">
          <span className="hq-pill info">{connected ? 'connected' : 'reconnecting'}</span>
          <span className="hq-pill">{totals?.activeMachines ?? 0} machines</span>
          <span className="hq-pill">{totals?.activeSessions ?? 0} sessions</span>
          <span className="hq-pill">{totals?.activeAgents ?? 0} agents</span>
          <span className="hq-pill green">${(totals?.totalCostUsd ?? 0).toFixed(2)}</span>
          {apiActive.length > 0 && (
            <span className="hq-pill error">{apiActive.length} active alerts</span>
          )}
          {alertsError !== null && <span className="hq-pill error">{alertsError}</span>}
          <button
            type="button"
            className="hq-btn secondary hq-ml-auto"
            onClick={() => useHqStore.getState().setActiveView('fleet')}
          >
            Open Fleet
          </button>
        </div>
        <section className="hq-cockpit-actions" aria-label="Cockpit quick actions">
          <div className="hq-cockpit-actions-copy">
            <span className="hq-cockpit-section-title">
              Quick Actions
            </span>
            <span className="hq-mono">
              {quickActionClient === null
                ? 'no controllable client connected'
                : `target ${shortId(quickActionClient.clientId)}`}
            </span>
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
              {quickActionBusy === 'status-request' ? 'Queuing…' : 'Broadcast status request'}
            </button>
            <button
              type="button"
              className="hq-btn secondary"
              onClick={() => useHqStore.getState().setActiveView('control')}
            >
              Open Control
            </button>
          </div>
          {quickActionStatus !== null && <span className="hq-pill info">{quickActionStatus}</span>}
          {quickActionError !== null && <span className="hq-pill error">{quickActionError}</span>}
        </section>
      </div>

      {[...fleetSections, alertSection, costSection].map((section) => (
        <div key={section.title} className="hq-card hq-cockpit-section">
          <div className="hq-row">
            <span className="hq-cockpit-section-title">
              {section.title}
            </span>
            <button
              type="button"
              className="hq-btn secondary hq-ml-auto"
              onClick={() => useHqStore.getState().setActiveView(section.view)}
            >
              {section.cta}
            </button>
          </div>
          {section.body}
        </div>
      ))}
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
