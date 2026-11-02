/**
 * One summary per physical machine: everything HQ knows about it, folded from
 * the snapshot, so an operator can answer "is that box healthy, what runs on
 * it, and does it need me?" without visiting five surfaces.
 */
import type { HqClientRecord, HqMachineRecord, HqSnapshot } from '@wrongstack/hq';
import { belongsToMachine, machineKeyResolver } from '../../lib/scope';
import type { AttentionItem } from '../attention/model';
import { toMillis } from '../attention/model';
import { compareVersions } from '../attention/versions';
import type { MachineHealth } from './health';

export interface MachineClient {
  clientId: string;
  kind: string;
  version: string | undefined;
  /** Relative to the hub: behind, ahead, same, or unknown. */
  drift: 'behind' | 'ahead' | 'same' | 'unknown';
  projectName: string;
  connected: boolean;
  pid: number | undefined;
  lastSeenAt: string;
}

export interface MachineSummary {
  /** The machine key (hostname-first, as the server groups machines). */
  key: string;
  /** Every raw machine id the processes on this computer reported. */
  machineIds: string[];
  hostname: string;
  online: boolean;
  /**
   * HQ only remembers this machine: no client is connected now, and what is
   * shown comes from the roster (`snapshot.offlineMachines`).
   */
  remembered: boolean;
  /** The release a client here last reported (roster), when no client is connected. */
  lastVersion: string | undefined;
  lastSeenAt: string;
  clients: MachineClient[];
  projects: { projectId: string; projectName: string }[];
  sessions: number;
  agents: number;
  working: number;
  /** Spend of the sessions that ran here. */
  costUsd: number;
  mcpTotal: number;
  mcpFailing: number;
  /** Newest host-health sample a client here sent; absent until one arrives. */
  health: MachineHealth | undefined;
  /** The server's verdict on `health` (thresholds are the operator's). */
  healthProblems: readonly ('disk' | 'memory')[] | undefined;
  /** Labels the operator gave this machine, sorted (empty when none). */
  labels: readonly string[];
  /** Items in the attention queue that belong to this machine. */
  attention: AttentionItem[];
}

const WORKING = new Set(['running', 'streaming']);

/** The newest health sample among a machine's records, with its verdict. */
function newestHealth(
  records: readonly HqMachineRecord[],
): Pick<MachineSummary, 'health' | 'healthProblems'> {
  const newest = records
    .filter((record) => record.health !== undefined)
    .sort((a, b) => toMillis(b.health!.reportedAt) - toMillis(a.health!.reportedAt))[0];
  return { health: newest?.health, healthProblems: newest?.healthProblems };
}

function driftOf(client: HqClientRecord, hub: string | undefined): MachineClient['drift'] {
  if (client.version === undefined || hub === undefined) return 'unknown';
  const order = compareVersions(client.version, hub);
  return order === null ? 'unknown' : order < 0 ? 'behind' : order > 0 ? 'ahead' : 'same';
}

export function machineSummaries(
  snapshot: HqSnapshot | null,
  attention: readonly AttentionItem[],
): MachineSummary[] {
  if (snapshot === null) return [];
  const hub = snapshot.hqVersion;
  const projectName = (id: string): string =>
    snapshot.projects.find((project) => project.projectId === id)?.projectName ?? id;
  const resolve = machineKeyResolver(snapshot);
  const keyOf = (record: { hostname?: string | undefined; machineId: string }): string =>
    resolve(record.hostname, record.machineId);
  const keys = new Set<string>([
    ...(snapshot.machines ?? []).map(keyOf),
    ...snapshot.clients.map(keyOf),
  ]);

  const summaries = [...keys].map((key): MachineSummary => {
    const records = (snapshot.machines ?? []).filter((machine) => keyOf(machine) === key);
    const clients = snapshot.clients.filter((client) => keyOf(client) === key);
    const clientIds = new Set(clients.map((client) => client.clientId));
    const live = (snapshot.liveSessions ?? []).filter((session) => keyOf(session) === key);
    const machineIds = [
      ...new Set([...records, ...clients].map((entry) => entry.machineId).filter(Boolean)),
    ].sort();
    const projectIds = new Set<string>([
      ...records.flatMap((record) => record.projectIds),
      ...clients.map((client) => client.projectId),
      ...live.map((session) => session.projectId),
    ]);
    const mcp = (snapshot.mcpServers ?? []).filter((server) => clientIds.has(server.clientId));
    let agents = 0;
    let working = 0;
    for (const session of live) {
      for (const agent of session.agents ?? []) {
        agents += 1;
        if (WORKING.has(agent.status)) working += 1;
      }
    }
    const lastSeen = [
      ...records.map((record) => record.lastActivityAt),
      ...clients.map((client) => client.lastSeenAt),
    ]
      .filter((value): value is string => value !== undefined)
      .sort((a, b) => toMillis(b) - toMillis(a))[0];
    return {
      key,
      machineIds,
      hostname:
        records.find((record) => record.hostname)?.hostname ??
        clients.find((client) => client.hostname)?.hostname ??
        key.replace(/^(host|mid):/, ''),
      online: clients.some((client) => client.connected),
      remembered: false,
      lastVersion: undefined,
      lastSeenAt: lastSeen ?? '',
      clients: clients
        .map((client) => ({
          clientId: client.clientId,
          kind: client.kind,
          version: client.version?.replace(/^v/, ''),
          drift: driftOf(client, hub),
          projectName: projectName(client.projectId),
          connected: client.connected,
          pid: client.pid,
          lastSeenAt: client.lastSeenAt,
        }))
        .sort(
          (a, b) =>
            Number(b.connected) - Number(a.connected) || a.projectName.localeCompare(b.projectName),
        ),
      projects: [...projectIds]
        .map((projectId) => ({ projectId, projectName: projectName(projectId) }))
        .sort((a, b) => a.projectName.localeCompare(b.projectName)),
      sessions: live.length,
      agents,
      working,
      costUsd: snapshot.sessions
        .filter((session) => clientIds.has(session.clientId))
        .reduce((sum, session) => sum + (session.costUsd ?? 0), 0),
      mcpTotal: mcp.length,
      mcpFailing: mcp.filter(
        (server) => server.healthState === 'failed' || server.healthState === 'degraded',
      ).length,
      ...newestHealth(records),
      labels: snapshot.machineLabels?.[key] ?? [],
      attention: attention.filter(
        (item) => item.origin !== undefined && belongsToMachine(item.origin, key, snapshot),
      ),
    };
  });

  // Machines HQ remembers but that have no connected client right now.
  for (const known of snapshot.offlineMachines ?? []) {
    if (keys.has(known.key)) continue;
    keys.add(known.key);
    summaries.push({
      key: known.key,
      machineIds: [...known.machineIds].sort(),
      hostname: known.hostname ?? known.key.replace(/^(host|mid):/, ''),
      online: false,
      remembered: true,
      lastVersion: known.lastVersion?.replace(/^v/, ''),
      lastSeenAt: known.lastSeenAt,
      clients: [],
      projects: [...known.projects].sort((a, b) => a.projectName.localeCompare(b.projectName)),
      sessions: 0,
      agents: 0,
      working: 0,
      costUsd: 0,
      mcpTotal: 0,
      mcpFailing: 0,
      health: undefined,
      healthProblems: undefined,
      labels: snapshot.machineLabels?.[known.key] ?? known.labels ?? [],
      attention: attention.filter(
        (item) => item.origin !== undefined && belongsToMachine(item.origin, known.key, snapshot),
      ),
    });
  }

  // Machines that need a person first, then the ones online, then the most
  // recently seen, then by name.
  return summaries.sort(
    (a, b) =>
      Number(b.attention.length > 0) - Number(a.attention.length > 0) ||
      Number(b.online) - Number(a.online) ||
      (a.online ? 0 : toMillis(b.lastSeenAt) - toMillis(a.lastSeenAt)) ||
      a.hostname.localeCompare(b.hostname),
  );
}

/** Every label in use, with how many machines carry it, by name. */
export function labelCounts(
  machines: readonly MachineSummary[],
): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const machine of machines) {
    for (const label of machine.labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * The machines carrying `label`, or all of them for `null`. A label nobody
 * carries any more (an old link) filters nothing out rather than everything.
 */
export function machinesWithLabel(
  machines: readonly MachineSummary[],
  label: string | null,
): readonly MachineSummary[] {
  if (label === null) return machines;
  const picked = machines.filter((machine) => machine.labels.includes(label));
  return picked.length > 0 ? picked : machines;
}

/** "3 agents working on 2 sessions", "Offline since …", "Idle". */
export function machineSentence(machine: MachineSummary): string {
  if (!machine.online) return 'Offline';
  if (machine.working > 0)
    return `${machine.working} of ${machine.agents} agent${machine.agents === 1 ? '' : 's'} working`;
  if (machine.sessions > 0)
    return `${machine.sessions} session${machine.sessions === 1 ? '' : 's'} open, all idle`;
  return 'Connected, no session open';
}
