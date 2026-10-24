/** Cockpit data: health + alert polling, the alert digest, fleet roll-ups and the quick-action dispatcher. */
import type { HqAlert, HqAlertMessage, HqSnapshot } from '@wrongstack/hq';
import { useEffect, useMemo, useState } from 'react';
import { fetchJson, postCommand } from '../data/api.js';
import type { MailboxGatewayHealth, SystemHealth } from './cockpit-health.js';

const HEALTH_POLL_MS = 30_000;
const ALERTS_POLL_MS = 15_000;
/** Cockpit shows a digest, not the archive — the Attention view has the rest. */
const ALERT_DIGEST_LIMIT = 12;
const TOP_PROJECTS = 4;

interface AlertsResponse {
  active: HqAlert[];
  history: HqAlert[];
}

export interface AlertDigestEntry {
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

export type QuickAction = 'pause-noisy' | 'status-request';

/** `/api/system/health` (required) and `/api/health/mailbox` (optional), polled together. */
export function useCockpitHealth() {
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [gatewayHealth, setGatewayHealth] = useState<MailboxGatewayHealth | null>(null);

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
      // Optional detail: an older server without the route simply shows none.
      fetchJson<MailboxGatewayHealth>('/api/health/mailbox')
        .then((data) => {
          if (!cancelled) setGatewayHealth(data);
        })
        .catch(() => {
          if (!cancelled) setGatewayHealth(null);
        });
    };
    load();
    const timer = window.setInterval(load, HEALTH_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return { health, healthError, gatewayHealth };
}

/** Polled `/api/alerts` merged with the live WS feed into one deduped digest. */
export function useCockpitAlerts(alerts: HqAlertMessage[]) {
  const [activeAlerts, setActiveAlerts] = useState<HqAlert[]>([]);
  const [alertHistory, setAlertHistory] = useState<HqAlert[]>([]);
  const [alertsError, setAlertsError] = useState<string | null>(null);

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

  return { activeAlerts, alertsError, alertDigest };
}

/** Agent, client-version, top-project and spawn-budget roll-ups over the snapshot. */
export function useCockpitFleetStats(
  sessions: NonNullable<HqSnapshot['liveSessions']>,
  clients: NonNullable<HqSnapshot['clients']>,
  projects: NonNullable<HqSnapshot['projects']>,
  fleets: NonNullable<HqSnapshot['fleets']>,
) {
  const agents = useMemo(() => {
    let total = 0;
    let busy = 0;
    let waiting = 0;
    let errored = 0;
    let idle = 0;
    let activeSessions = 0;
    for (const session of sessions) {
      if (session.status === 'active') activeSessions += 1;
      for (const agent of session.agents ?? []) {
        total += 1;
        if (agent.status === 'running' || agent.status === 'streaming') busy += 1;
        else if (agent.status === 'waiting_user') waiting += 1;
        else if (agent.status === 'error') errored += 1;
        else idle += 1;
      }
    }
    return { total, busy, waiting, errored, idle, activeSessions };
  }, [sessions]);

  const clientVersions = useMemo(() => {
    const versions = new Set<string>();
    for (const c of clients) {
      if (c.version) versions.add(`v${c.version.replace(/^v/, '')}`);
    }
    return Array.from(versions);
  }, [clients]);

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

  return { agents, clientVersions, topProjects, spawnBudget };
}

/** Mailbox broadcasts from the command strip, sent to the selected controllable client. */
export function useCockpitQuickActions(targetClientId: string | null) {
  const [busyAction, setBusyAction] = useState<QuickAction | null>(null);
  const [actionResult, setActionResult] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function dispatchQuickAction(action: QuickAction): Promise<void> {
    if (targetClientId === null) return;
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
      const result = await postCommand(targetClientId, 'broadcast', payload);
      setActionResult(`queued ${result.commandId}`);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyAction(null);
    }
  }

  return { busyAction, actionResult, actionError, dispatchQuickAction };
}
