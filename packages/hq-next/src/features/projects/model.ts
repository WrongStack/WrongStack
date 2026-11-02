/**
 * One summary per project: everything HQ knows about it across every machine
 * it runs on, folded from the snapshot, so an operator can answer "where does
 * this project run, is anything working on it, what has it cost and does it
 * need me?" in one place.
 */
import type { HqProjectStatus, HqSnapshot } from '@wrongstack/hq';
import { belongsToProject, machineKeyResolver } from '../../lib/scope';
import type { AttentionItem } from '../attention/model';
import { toMillis } from '../attention/model';

export interface ProjectMachine {
  key: string;
  hostname: string;
  online: boolean;
}

export interface ProjectLiveSession {
  sessionId: string;
  machineKey: string;
  hostname: string;
  clientKind: string;
  gitBranch: string | undefined;
  agents: number;
  working: number;
  lastActivityAt: string;
}

export interface ProjectSummary {
  projectId: string;
  projectName: string;
  /** Display root (already redacted to the HQ path policy by the client). */
  root: string;
  gitBranch: string | undefined;
  /**
   * `remembered`: no client of this project is connected; HQ only knows it
   * from the machine roster.
   */
  status: HqProjectStatus | 'remembered';
  machines: ProjectMachine[];
  sessions: ProjectLiveSession[];
  agents: number;
  working: number;
  costUsd: number;
  lastActivityAt: string;
  unreadMail: number;
  openMail: number;
  attention: AttentionItem[];
}

const WORKING = new Set(['running', 'streaming']);

export function projectSummaries(
  snapshot: HqSnapshot | null,
  attention: readonly AttentionItem[],
): ProjectSummary[] {
  if (snapshot === null) return [];
  const resolve = machineKeyResolver(snapshot);
  const onlineKeys = new Set(
    snapshot.clients
      .filter((client) => client.connected)
      .map((client) => resolve(client.hostname, client.machineId)),
  );
  const hostnames = new Map<string, string>();
  for (const record of [...(snapshot.machines ?? []), ...snapshot.clients]) {
    const key = resolve(record.hostname, record.machineId);
    if (record.hostname || !hostnames.has(key))
      hostnames.set(key, record.hostname || key.replace(/^(host|mid):/, ''));
  }
  const ownAttention = (projectId: string): AttentionItem[] =>
    attention.filter(
      (item) => item.origin !== undefined && belongsToProject(item.origin, projectId, snapshot),
    );

  const summaries = snapshot.projects.map((project): ProjectSummary => {
    const live = (snapshot.liveSessions ?? []).filter(
      (session) => session.projectId === project.projectId,
    );
    const machineKeys = new Set<string>([
      ...project.machineIds.map((id) => resolve(undefined, id)),
      ...snapshot.clients
        .filter((client) => client.projectId === project.projectId)
        .map((client) => resolve(client.hostname, client.machineId)),
      ...live.map((session) => resolve(session.hostname, session.machineId)),
    ]);
    const sessions = live.map((session): ProjectLiveSession => {
      const key = resolve(session.hostname, session.machineId);
      return {
        sessionId: session.sessionId,
        machineKey: key,
        hostname: session.hostname || hostnames.get(key) || key.replace(/^(host|mid):/, ''),
        clientKind: session.clientKind,
        gitBranch: session.gitBranch,
        agents: session.agents.length,
        working: session.agents.filter((agent) => WORKING.has(agent.status)).length,
        lastActivityAt: session.lastActivityAt,
      };
    });
    const mail = snapshot.mailboxes.filter((box) => box.projectId === project.projectId);
    return {
      projectId: project.projectId,
      projectName: project.projectName,
      root: project.projectRootDisplay,
      gitBranch: project.gitBranch,
      status: project.status,
      machines: [...machineKeys]
        .map((key) => ({
          key,
          hostname: hostnames.get(key) ?? key.replace(/^(host|mid):/, ''),
          online: onlineKeys.has(key),
        }))
        .sort(
          (a, b) => Number(b.online) - Number(a.online) || a.hostname.localeCompare(b.hostname),
        ),
      sessions: sessions.sort((a, b) => toMillis(b.lastActivityAt) - toMillis(a.lastActivityAt)),
      agents: sessions.reduce((sum, session) => sum + session.agents, 0),
      working: sessions.reduce((sum, session) => sum + session.working, 0),
      costUsd: project.totalCostUsd,
      lastActivityAt: project.lastActivityAt,
      unreadMail: mail.reduce((sum, box) => sum + box.unreadCount, 0),
      openMail: mail.reduce((sum, box) => sum + box.incompleteCount, 0),
      attention: ownAttention(project.projectId),
    };
  });

  // Machines that went offline: a live project still lists where else it
  // ran, and a project known only from them is listed as remembered.
  const known = new Map(summaries.map((summary) => [summary.projectId, summary]));
  const remembered = new Map<string, ProjectSummary>();
  for (const machine of snapshot.offlineMachines ?? []) {
    for (const project of machine.projects) {
      const live = known.get(project.projectId);
      if (live !== undefined) {
        if (!live.machines.some((entry) => entry.key === machine.key))
          live.machines.push({
            key: machine.key,
            hostname: machine.hostname ?? machine.key.replace(/^(host|mid):/, ''),
            online: false,
          });
        continue;
      }
      const entry =
        remembered.get(project.projectId) ??
        ({
          projectId: project.projectId,
          projectName: project.projectName,
          root: '',
          gitBranch: undefined,
          status: 'remembered',
          machines: [],
          sessions: [],
          agents: 0,
          working: 0,
          costUsd: 0,
          lastActivityAt: machine.lastSeenAt,
          unreadMail: 0,
          openMail: 0,
          attention: ownAttention(project.projectId),
        } satisfies ProjectSummary);
      entry.machines.push({
        key: machine.key,
        hostname: machine.hostname ?? machine.key.replace(/^(host|mid):/, ''),
        online: false,
      });
      if (toMillis(machine.lastSeenAt) > toMillis(entry.lastActivityAt))
        entry.lastActivityAt = machine.lastSeenAt;
      remembered.set(project.projectId, entry);
    }
  }
  for (const entry of remembered.values()) {
    entry.machines.sort((a, b) => a.hostname.localeCompare(b.hostname));
    summaries.push(entry);
  }

  // Projects that need a person first, then the ones with work running, then
  // the most recently active, then by name.
  return summaries.sort(
    (a, b) =>
      Number(b.attention.length > 0) - Number(a.attention.length > 0) ||
      Number(b.working > 0) - Number(a.working > 0) ||
      Number(b.status !== 'remembered') - Number(a.status !== 'remembered') ||
      toMillis(b.lastActivityAt) - toMillis(a.lastActivityAt) ||
      a.projectName.localeCompare(b.projectName),
  );
}

/** "2 of 5 agents working", "1 session open, all idle", "No session open". */
export function projectSentence(project: ProjectSummary): string {
  if (project.status === 'remembered') return 'Not running anywhere now';
  if (project.working > 0)
    return `${project.working} of ${project.agents} agent${project.agents === 1 ? '' : 's'} working`;
  const open = project.sessions.length;
  if (open > 0) return `${open} session${open === 1 ? '' : 's'} open, all idle`;
  return 'No session open';
}

/** "on lab-01, lab-02 +1 offline". */
export function projectWhere(project: ProjectSummary): string {
  const online = project.machines.filter((machine) => machine.online);
  const offline = project.machines.length - online.length;
  const names = online.map((machine) => machine.hostname).join(', ');
  if (names === '')
    return offline === 0 ? 'No machine' : `${offline} machine${offline === 1 ? '' : 's'}, offline`;
  return offline === 0 ? `on ${names}` : `on ${names} · ${offline} offline`;
}

/** A connected client of the project that may open new sessions there. */
export interface StartSessionTarget {
  clientId: string;
  hostname: string;
  kind: string;
}

/**
 * Where HQ could start a session for this project: connected clients that
 * advertise `session.start` (they run with `--hq-allow-exec` on a release that
 * knows the command). Sorted by machine name.
 */
export function startSessionTargets(
  snapshot: HqSnapshot | null,
  projectId: string,
): StartSessionTarget[] {
  if (snapshot === null) return [];
  return snapshot.clients
    .filter(
      (client) =>
        client.connected &&
        client.projectId === projectId &&
        client.capabilities.includes('session.start'),
    )
    .map((client) => ({
      clientId: client.clientId,
      hostname: client.hostname || client.machineId,
      kind: client.kind,
    }))
    .sort((a, b) => a.hostname.localeCompare(b.hostname) || a.clientId.localeCompare(b.clientId));
}
