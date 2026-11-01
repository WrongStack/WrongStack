/**
 * Overview model — pure derivations from the fleet state.
 *
 * The Overview answers two questions in this order: "does anything need me?"
 * (the shared attention queue, see `../attention/model`) and "what is the
 * fleet doing?". Everything here is a pure function so the rules are testable
 * without a renderer.
 */
import type {
  HqSessionAgentLiveStatus,
  HqSessionSnapshotPayload,
  HqSnapshot,
} from '@wrongstack/hq';
import {
  type MailboxGatewayHealth,
  type SystemHealth,
  summarizeHealthDetail,
} from '../../hq/domain/system-health';
import { type AttentionItem, toMillis } from '../attention/model';

export interface FleetPulse {
  machines: number;
  sessions: number;
  agents: number;
  working: number;
  /** Projects with an open session. */
  projects: number;
  /** Projects where at least one agent is working right now. */
  workingProjects: number;
  costUsd: number;
}

const WORKING: ReadonlySet<HqSessionAgentLiveStatus> = new Set(['running', 'streaming']);

export function fleetPulse(snapshot: HqSnapshot | null): FleetPulse {
  const sessions = snapshot?.liveSessions ?? [];
  let agents = 0;
  let working = 0;
  const workingProjects = new Set<string>();
  for (const session of sessions) {
    for (const agent of session.agents ?? []) {
      agents += 1;
      if (!WORKING.has(agent.status)) continue;
      working += 1;
      workingProjects.add(session.projectId);
    }
  }
  const activeProjects = new Set(sessions.map((session) => session.projectId));
  return {
    machines: snapshot?.machines?.length ?? 0,
    sessions: sessions.length,
    agents,
    working,
    projects: activeProjects.size,
    workingProjects: workingProjects.size,
    costUsd: snapshot?.totals?.totalCostUsd ?? 0,
  };
}

export type HeadlineTone = 'offline' | 'empty' | 'attention' | 'busy' | 'calm';

export interface Headline {
  tone: HeadlineTone;
  title: string;
  detail: string;
}

export const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

/** The one sentence at the top of the screen. */
export function overviewHeadline(input: {
  connected: boolean;
  hasSnapshot: boolean;
  everSawClient: boolean;
  attention: readonly AttentionItem[];
  pulse: FleetPulse;
}): Headline {
  const { connected, hasSnapshot, everSawClient, attention, pulse } = input;
  if (!connected) {
    return {
      tone: 'offline',
      title: 'Reconnecting to HQ',
      detail: 'The figures below are the last ones received and may be out of date.',
    };
  }
  if (!hasSnapshot || !everSawClient) {
    return {
      tone: 'empty',
      title: 'No machine is connected yet',
      detail: 'Connect a WrongStack CLI, TUI or WebUI and it appears here within seconds.',
    };
  }
  const working =
    pulse.working > 0
      ? `${plural(pulse.working, 'agent')} working across ${plural(pulse.workingProjects, 'project')}`
      : `${plural(pulse.sessions, 'session')} open, no agent working`;
  if (attention.length > 0) {
    const critical = attention.filter((item) => item.tone === 'critical').length;
    return {
      tone: 'attention',
      title: attention.length === 1 ? '1 thing needs you' : `${attention.length} things need you`,
      detail: critical > 0 ? `${critical} urgent. ${working}.` : `${working}.`,
    };
  }
  return {
    tone: pulse.working > 0 ? 'busy' : 'calm',
    title: pulse.working > 0 ? 'All clear' : 'All quiet',
    detail: `${working}.`,
  };
}

/** Live sessions with something going on first, then the most recently active. */
export function orderSessions(
  sessions: readonly HqSessionSnapshotPayload[],
): HqSessionSnapshotPayload[] {
  const rank = (session: HqSessionSnapshotPayload): number => {
    const statuses = (session.agents ?? []).map((agent) => agent.status);
    if (statuses.some((status) => status === 'error' || status === 'waiting_user')) return 0;
    if (statuses.some((status) => WORKING.has(status))) return 1;
    return session.status === 'active' ? 2 : 3;
  };
  return [...sessions].sort(
    (left, right) =>
      rank(left) - rank(right) || toMillis(right.lastActivityAt) - toMillis(left.lastActivityAt),
  );
}

export interface TokenHealth {
  value: string;
  tone: 'ok' | 'warn' | 'muted';
}

/**
 * The MCP row: failing and degraded servers first, otherwise how many answer.
 * An empty list is a fleet with no MCP configured, not a fault.
 */
export function mcpHealthRow(servers: HqSnapshot['mcpServers']): TokenHealth {
  const list = servers ?? [];
  if (list.length === 0) return { value: 'None reported', tone: 'muted' };
  const failed = list.filter((server) => server.healthState === 'failed').length;
  const degraded = list.filter((server) => server.healthState === 'degraded').length;
  if (failed + degraded > 0) {
    const parts: string[] = [];
    if (failed > 0) parts.push(`${failed} failing`);
    if (degraded > 0) parts.push(`${degraded} degraded`);
    return { value: `${parts.join(' · ')} of ${list.length}`, tone: 'warn' };
  }
  const answering = list.filter(
    (server) => server.healthState === 'healthy' || server.healthState === 'connecting',
  ).length;
  const idle = list.length - answering;
  return {
    value: idle > 0 ? `${answering} healthy · ${idle} asleep or off` : `${answering} healthy`,
    tone: 'ok',
  };
}

/**
 * The auth-token row: how many browser and client tokens HQ holds, and whether
 * any have expired or expire within a day. Counts only; the snapshot never
 * carries token strings. Older servers omit the stats.
 */
export function tokenHealth(stats: HqSnapshot['totals']['tokenStats'] | undefined): TokenHealth {
  if (stats === undefined) return { value: 'Not reported', tone: 'muted' };
  const parts = [`${stats.browserTotal} browser`, `${stats.clientTotal} client`];
  if (stats.expired > 0) parts.push(`${stats.expired} expired`);
  if (stats.expiringSoon > 0) parts.push(`${stats.expiringSoon} expiring within a day`);
  return {
    value: parts.join(' · '),
    tone: stats.expired > 0 || stats.expiringSoon > 0 ? 'warn' : 'ok',
  };
}

// ── Subagent runs ─────────────────────────────────────────────────────────

export interface SpawnBudget {
  used: number;
  /** Undefined when the run has no lifetime ceiling. */
  max: number | undefined;
  left: number | undefined;
}

export interface RunRow {
  runId: string;
  projectName: string;
  /** Machine and terminal the run lives in. */
  where: string;
  /** The live session that owns the run, when HQ can name it. */
  sessionId: string | undefined;
  tasks: string;
  budget: SpawnBudget | undefined;
  /** "Up to 4 at once", when a concurrency ceiling is set. */
  concurrency: string | undefined;
  costUsd: number | undefined;
  lastActivityAt: string;
  /** Problems a person should read, worst first. Empty when the run is fine. */
  warnings: string[];
}

const limit = (value: number | undefined): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/**
 * One row per coordinator run (a session that spawns subagents). Runs with a
 * problem — failed tasks, a spent spawn budget, or a checkpoint ceiling that
 * disagrees with the live one — come first; then the most recently active.
 */
export function subagentRuns(snapshot: HqSnapshot | null): RunRow[] {
  if (snapshot === null) return [];
  const rows = (snapshot.fleets ?? []).map((fleet): RunRow => {
    const client = snapshot.clients.find((entry) => entry.clientId === fleet.clientId);
    const session = (snapshot.liveSessions ?? []).find(
      (entry) => entry.clientId === fleet.clientId,
    );
    const project = snapshot.projects.find((entry) => entry.projectId === fleet.projectId);
    const max = limit(fleet.maxSpawns);
    const used = limit(fleet.usedSpawns);
    const budget =
      used === undefined
        ? undefined
        : {
            used,
            max,
            left:
              max === undefined
                ? undefined
                : (limit(fleet.remainingSpawns) ?? Math.max(0, max - used)),
          };
    const tasks = [
      `${fleet.activeSubagents} working`,
      `${fleet.queuedTasks} queued`,
      `${fleet.completedTasks} done`,
      ...(fleet.failedTasks > 0 ? [`${fleet.failedTasks} failed`] : []),
    ].join(' · ');
    const warnings: string[] = [];
    if (fleet.ceilingMismatch) {
      const was = limit(fleet.checkpointMaxSpawns);
      const change = [
        ...(was !== undefined ? [`was ${was}`] : []),
        ...(max !== undefined ? [`now ${max}`] : []),
      ];
      const detail = change.length > 0 ? ` (${change.join(', ')})` : '';
      const source = fleet.effectiveSource ? `; set by ${fleet.effectiveSource}` : '';
      warnings.push(`The spawn limit changed since the checkpoint${detail}${source}.`);
    }
    if (budget?.left === 0 && fleet.queuedTasks > 0)
      warnings.push(
        `No spawns left and ${plural(fleet.queuedTasks, 'task')} still queued — raise maxSpawns or the queue stalls.`,
      );
    else if (budget?.left === 0) warnings.push('Spawn budget spent; no new subagent can start.');
    if (fleet.failedTasks > 0) warnings.push(`${plural(fleet.failedTasks, 'task')} failed.`);
    const maxConcurrent = limit(fleet.maxConcurrent);
    return {
      runId: fleet.runId,
      projectName: project?.projectName ?? session?.projectName ?? fleet.projectId,
      where: client?.hostname ?? session?.hostname ?? client?.machineId ?? fleet.clientId,
      sessionId: session?.sessionId,
      tasks,
      budget,
      concurrency: maxConcurrent !== undefined ? `Up to ${maxConcurrent} at once` : undefined,
      costUsd: fleet.totalCostUsd,
      lastActivityAt: fleet.lastActivityAt,
      warnings,
    };
  });
  return rows.sort(
    (left, right) =>
      Number(right.warnings.length > 0) - Number(left.warnings.length > 0) ||
      toMillis(right.lastActivityAt) - toMillis(left.lastActivityAt),
  );
}

// ── HQ server health ──────────────────────────────────────────────────────

export interface HealthRow {
  label: string;
  value: string;
  tone: 'ok' | 'warn' | 'muted';
}

/**
 * The server rows of the System panel. A degraded server names the store that
 * degraded; publishers split fresh, quiet and stale; mailbox gateways show only
 * when the server reports them.
 */
export function serverHealthRows(
  health: SystemHealth | null,
  healthError: string | null,
  gateways: MailboxGatewayHealth | null,
): HealthRow[] {
  if (healthError !== null) return [{ label: 'HQ server', value: 'Unreachable', tone: 'warn' }];
  if (health === null) return [{ label: 'HQ server', value: '…', tone: 'muted' }];
  const detail = summarizeHealthDetail(health, gateways);
  const rows: HealthRow[] = [
    health.status === 'healthy' && detail.degradedStores.length === 0
      ? { label: 'HQ server', value: 'Healthy', tone: 'ok' }
      : {
          label: 'HQ server',
          value:
            detail.degradedStores.length > 0
              ? `Degraded: ${detail.degradedStores.join(', ')} store`
              : 'Degraded',
          tone: 'warn',
        },
  ];
  const { fresh, quiet, stale } = detail.publishers;
  const publisherParts = [`${fresh} fresh`];
  if (quiet > 0) publisherParts.push(`${quiet} quiet`);
  if (stale > 0) publisherParts.push(`${stale} stale`);
  rows.push({
    label: 'Publishers',
    value: publisherParts.join(' · '),
    tone: stale > 0 ? 'warn' : fresh + quiet === 0 ? 'muted' : 'ok',
  });
  if (detail.gateways !== null) {
    rows.push({
      label: 'Mailbox gateways',
      value:
        detail.gateways.total === 0
          ? 'None open'
          : `${detail.gateways.total} open · ${detail.gateways.streaming} streaming`,
      tone: detail.gateways.total === 0 ? 'muted' : 'ok',
    });
  }
  return rows;
}
