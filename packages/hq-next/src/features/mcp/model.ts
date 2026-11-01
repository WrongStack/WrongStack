/**
 * MCP server health, as the connected terminals report it.
 *
 * Every terminal runs its own MCP connections, so the same server name can
 * appear once per terminal. HQ keeps them apart: a server that is fine in one
 * terminal and failing in another is two facts, not one averaged state.
 */
import type {
  HqClientRecord,
  HqMcpHealthCheck,
  HqMcpHealthState,
  HqMcpLatencySummary,
  HqMcpServerHealth,
  HqProjectRecord,
} from '@wrongstack/hq';
import { plural } from '../overview/model';

export type McpTone = 'bad' | 'warn' | 'ok' | 'busy' | 'quiet';

export const HEALTH: Record<HqMcpHealthState, { label: string; tone: McpTone }> = {
  failed: { label: 'Failed', tone: 'bad' },
  degraded: { label: 'Degraded', tone: 'warn' },
  connecting: { label: 'Connecting', tone: 'busy' },
  healthy: { label: 'Healthy', tone: 'ok' },
  dormant: { label: 'Asleep', tone: 'quiet' },
  disabled: { label: 'Disabled', tone: 'quiet' },
};

/** Lower sorts first: what needs a person comes before what is fine. */
const RANK: Record<HqMcpHealthState, number> = {
  failed: 0,
  degraded: 1,
  connecting: 2,
  healthy: 3,
  dormant: 4,
  disabled: 5,
};

const CHECK_LABEL: Record<string, string> = {
  'connection-latency-p95': 'Connecting (p95)',
  'discovery-latency-p95': 'Listing tools (p95)',
  'call-latency-p95': 'Tool calls (p95)',
  'in-flight-calls': 'Calls at once (peak)',
};

export function checkLabel(name: string): string {
  return CHECK_LABEL[name] ?? name.replace(/-/g, ' ');
}

/** Latency checks carry milliseconds; the concurrency check carries a count. */
export function checkValue(check: HqMcpHealthCheck, value: number | undefined): string {
  if (value === undefined) return '—';
  return check.name === 'in-flight-calls' ? String(value) : formatMs(value);
}

export function formatMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

/** "p50 120 ms · p95 900 ms", or null when nothing was measured. */
export function latencyLine(summary: HqMcpLatencySummary): string | null {
  if (summary.count === 0) return null;
  const parts: string[] = [];
  if (summary.p50Ms !== undefined) parts.push(`p50 ${formatMs(summary.p50Ms)}`);
  if (summary.p95Ms !== undefined) parts.push(`p95 ${formatMs(summary.p95Ms)}`);
  if (parts.length === 0 && summary.lastMs !== undefined)
    parts.push(`last ${formatMs(summary.lastMs)}`);
  return parts.length === 0 ? null : parts.join(' · ');
}

const FAILURE_KIND: Record<NonNullable<HqMcpServerHealth['lastFailureKind']>, string> = {
  transport: 'the connection broke',
  protocol: 'the server answered out of protocol',
  tool: 'a tool call failed',
};

/**
 * One sentence on why a server is in its state. Failed and degraded servers
 * name the cause; the rest say what they are doing.
 */
export function serverSentence(server: HqMcpServerHealth): string {
  const failedChecks = server.healthChecks.filter((check) => !check.passed);
  switch (server.healthState) {
    case 'failed':
    case 'degraded': {
      const reasons: string[] = [];
      if (server.lastFailureKind !== undefined) {
        const streak =
          server.consecutiveFailures > 1 ? ` (${server.consecutiveFailures} times in a row)` : '';
        reasons.push(`Last error: ${FAILURE_KIND[server.lastFailureKind]}${streak}.`);
      }
      if (failedChecks.length > 0)
        reasons.push(`Over its limit: ${failedChecks.map((c) => checkLabel(c.name)).join(', ')}.`);
      return reasons.length > 0 ? reasons.join(' ') : 'No cause was reported.';
    }
    case 'connecting':
      return server.reconnectCount > 0
        ? `Reconnecting (${plural(server.reconnectCount, 'reconnect')} so far).`
        : 'Starting up.';
    case 'dormant':
      return 'Asleep until a tool from it is needed.';
    case 'disabled':
      return 'Turned off in this project’s config.';
    default:
      return server.inFlightCalls > 0
        ? `${plural(server.inFlightCalls, 'call')} running now.`
        : 'Connected and answering.';
  }
}

export interface McpRow {
  /** Stable across snapshots: one terminal's connection to one server. */
  key: string;
  server: HqMcpServerHealth;
  /** Which terminal holds the connection, in words. */
  where: string;
}

export interface McpProjectGroup {
  projectId: string;
  projectName: string;
  rows: McpRow[];
  /** Rows that need a person: failed or degraded. */
  attention: number;
}

export interface McpFigures {
  total: number;
  failed: number;
  degraded: number;
  healthy: number;
  idle: number;
}

export function mcpFigures(servers: readonly HqMcpServerHealth[]): McpFigures {
  const figures: McpFigures = { total: 0, failed: 0, degraded: 0, healthy: 0, idle: 0 };
  for (const server of servers) {
    figures.total += 1;
    if (server.healthState === 'failed') figures.failed += 1;
    else if (server.healthState === 'degraded') figures.degraded += 1;
    else if (server.healthState === 'healthy' || server.healthState === 'connecting')
      figures.healthy += 1;
    else figures.idle += 1;
  }
  return figures;
}

function clientWhere(client: HqClientRecord | undefined, clientId: string): string {
  if (client === undefined) return `terminal ${clientId.slice(0, 8)}`;
  const host = client.hostname ?? client.machineId;
  return client.pid !== undefined ? `${host} · pid ${client.pid}` : host;
}

/**
 * Group by project, problems first. The project whose worst server is worst leads;
 * inside a project, rows sort by health and then by name.
 */
export function mcpGroups(
  servers: readonly HqMcpServerHealth[],
  projects: readonly HqProjectRecord[],
  clients: readonly HqClientRecord[],
): McpProjectGroup[] {
  const byProject = new Map<string, McpRow[]>();
  const seen = new Map<string, number>();
  for (const server of servers) {
    const base = `${server.clientId}:${server.name}`;
    // One terminal can report the same server for two sessions; keep keys unique.
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const row: McpRow = {
      key: n === 0 ? base : `${base}#${n}`,
      server,
      where: clientWhere(
        clients.find((client) => client.clientId === server.clientId),
        server.clientId,
      ),
    };
    const list = byProject.get(server.projectId);
    if (list === undefined) byProject.set(server.projectId, [row]);
    else list.push(row);
  }
  const groups: McpProjectGroup[] = [];
  for (const [projectId, rows] of byProject) {
    rows.sort(
      (a, b) =>
        RANK[a.server.healthState] - RANK[b.server.healthState] ||
        a.server.name.localeCompare(b.server.name) ||
        a.where.localeCompare(b.where),
    );
    groups.push({
      projectId,
      projectName:
        projects.find((project) => project.projectId === projectId)?.projectName ?? projectId,
      rows,
      attention: rows.filter(
        (row) => row.server.healthState === 'failed' || row.server.healthState === 'degraded',
      ).length,
    });
  }
  // Rows are sorted, so a group's first row is its worst server.
  const worst = (group: McpProjectGroup): number => RANK[group.rows[0]!.server.healthState];
  return groups.sort(
    (a, b) =>
      worst(a) - worst(b) ||
      b.attention - a.attention ||
      a.projectName.localeCompare(b.projectName),
  );
}
