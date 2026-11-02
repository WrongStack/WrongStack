/**
 * The operator's scope: the whole fleet, one machine, one project, or every
 * machine carrying an operator label ("gpu", "prod").
 *
 * One choice, kept in local prefs, narrows every surface the same way. The
 * snapshot is filtered once, here, so a view never has to know which records
 * belong to which machine; it just reads a smaller fleet. What a scope hides
 * is never dropped silently — the attention queue counts it for the header.
 *
 * A machine is identified by its MACHINE KEY, the same hostname-first key the
 * HQ server groups machines by (`hqMachineKey`): processes on one computer can
 * report different machine ids (older builds hashed hostname and pid), and
 * they are still one machine.
 */
import type { HqSnapshot } from '@wrongstack/hq';

export type ScopeKind = 'all' | 'machine' | 'project' | 'label';

export interface FleetScope {
  kind: ScopeKind;
  /** The machine key, project id or label; ignored for `all`. */
  id: string;
}

export const ALL_SCOPE: FleetScope = { kind: 'all', id: '' };

/** Mirrors the server's `hqMachineKey`: hostname when known, else the id. */
export function machineKeyOf(hostname: string | undefined, machineId: string | undefined): string {
  const host = hostname?.trim();
  return host ? `host:${host.toLowerCase()}` : `mid:${machineId || 'local'}`;
}

/** Which machine and project a record belongs to, as far as it says. */
export interface ScopeTag {
  machineKey?: string | undefined;
  /** A raw machine id, resolved to its key through the snapshot. */
  machineId?: string | undefined;
  projectId?: string | undefined;
  clientId?: string | undefined;
}

/**
 * Raw machine id → machine key, from every record that carries the id. A
 * record with a hostname wins, so an id seen once without one still lands on
 * the right computer.
 */
function keysByMachineId(snapshot: HqSnapshot): Map<string, string> {
  const keys = new Map<string, string>();
  const note = (machineId: string | undefined, hostname: string | undefined): void => {
    if (!machineId) return;
    if (hostname?.trim() || !keys.has(machineId))
      keys.set(machineId, machineKeyOf(hostname, machineId));
  };
  for (const machine of snapshot.machines ?? []) note(machine.machineId, machine.hostname);
  for (const client of snapshot.clients) note(client.machineId, client.hostname);
  for (const session of snapshot.liveSessions ?? []) note(session.machineId, session.hostname);
  return keys;
}

/**
 * A record's machine key. A record without a hostname (a live session from an
 * older client) borrows it from any other record with the same machine id, so
 * it lands on the same computer instead of a phantom `mid:` machine.
 */
export function machineKeyResolver(
  snapshot: HqSnapshot | null,
): (hostname: string | undefined, machineId: string | undefined) => string {
  const keys = snapshot === null ? new Map<string, string>() : keysByMachineId(snapshot);
  return (hostname, machineId) =>
    hostname?.trim()
      ? machineKeyOf(hostname, machineId)
      : ((machineId ? keys.get(machineId) : undefined) ?? machineKeyOf(undefined, machineId));
}

/** The machine keys carrying an operator label. */
export function machineKeysWithLabel(snapshot: HqSnapshot | null, label: string): Set<string> {
  const keys = new Set<string>();
  for (const [key, labels] of Object.entries(snapshot?.machineLabels ?? {})) {
    if (labels.includes(label)) keys.add(key);
  }
  return keys;
}

/**
 * The machine keys a machine-shaped scope covers: one for a machine, every
 * labelled one for a label, null for the whole fleet or a project.
 */
function scopeMachineKeys(
  scope: FleetScope,
  snapshot: HqSnapshot | null,
): ReadonlySet<string> | null {
  if (scope.kind === 'machine') return new Set([scope.id]);
  if (scope.kind === 'label') return machineKeysWithLabel(snapshot, scope.id);
  return null;
}

/** Every raw machine id inside a machine-shaped scope (for id-keyed views). */
export function machineIdsForScope(scope: FleetScope, snapshot: HqSnapshot | null): Set<string> {
  const keys = scopeMachineKeys(scope, snapshot);
  const ids = new Set<string>();
  if (keys === null || snapshot === null) return ids;
  for (const [machineId, machineKey] of keysByMachineId(snapshot)) {
    if (keys.has(machineKey)) ids.add(machineId);
  }
  return ids;
}

/**
 * The scope to apply: a machine or project that is no longer in the fleet
 * falls back to the whole fleet, so a stale preference never empties HQ.
 */
export function effectiveScope(scope: FleetScope, snapshot: HqSnapshot | null): FleetScope {
  if (scope.kind === 'all' || snapshot === null) return ALL_SCOPE;
  if (scope.kind === 'machine') {
    const known = [...keysByMachineId(snapshot).values()].includes(scope.id);
    return known ? scope : ALL_SCOPE;
  }
  if (scope.kind === 'label') {
    return machineKeysWithLabel(snapshot, scope.id).size > 0 ? scope : ALL_SCOPE;
  }
  return snapshot.projects.some((project) => project.projectId === scope.id) ? scope : ALL_SCOPE;
}

/** Resolve a tag's machine key and project, through its client when needed. */
function resolveTag(
  tag: ScopeTag,
  snapshot: HqSnapshot | null,
): { machineKey: string | undefined; projectId: string | undefined } {
  let { machineKey, projectId } = tag;
  if (machineKey === undefined && tag.machineId !== undefined) {
    machineKey = machineKeyResolver(snapshot)(undefined, tag.machineId);
  }
  if (tag.clientId !== undefined && (machineKey === undefined || projectId === undefined)) {
    const client = snapshot?.clients.find((entry) => entry.clientId === tag.clientId);
    if (client !== undefined) {
      machineKey ??= machineKeyOf(client.hostname, client.machineId);
      projectId ??= client.projectId;
    }
  }
  return { machineKey, projectId };
}

/**
 * Does a record fall inside the scope? Unknown ownership stays VISIBLE: a
 * scope narrows what the operator sees, it must never hide something that
 * needs them because HQ could not tell where it came from.
 */
export function inScope(tag: ScopeTag, scope: FleetScope, snapshot: HqSnapshot | null): boolean {
  if (scope.kind === 'all') return true;
  const { machineKey, projectId } = resolveTag(tag, snapshot);
  const machineKeys = scopeMachineKeys(scope, snapshot);
  if (machineKeys !== null) {
    if (machineKey !== undefined) return machineKeys.has(machineKey);
    // A project-only record (a mailbox, a governance signal) belongs to the
    // machine when the project runs there.
    if (projectId !== undefined && snapshot !== null) {
      const project = snapshot.projects.find((entry) => entry.projectId === projectId);
      if (project !== undefined) {
        const keys = keysByMachineId(snapshot);
        return project.machineIds.some((id) => machineKeys.has(keys.get(id) ?? ''));
      }
    }
    return true;
  }
  return projectId === undefined || projectId === scope.id;
}

/**
 * Does a record PROVABLY belong to this machine? Stricter than `inScope`: a
 * machine's own card lists only what HQ can attribute to it, so an item whose
 * client is gone does not appear on every card at once.
 */
export function belongsToMachine(
  tag: ScopeTag,
  machineKey: string,
  snapshot: HqSnapshot | null,
): boolean {
  return resolveTag(tag, snapshot).machineKey === machineKey;
}

/** Strict project ownership: unknown ownership is NOT the project's. */
export function belongsToProject(
  tag: ScopeTag,
  projectId: string,
  snapshot: HqSnapshot | null,
): boolean {
  return resolveTag(tag, snapshot).projectId === projectId;
}

/** The fleet as seen from inside the scope. */
export function scopeSnapshot(snapshot: HqSnapshot | null, scope: FleetScope): HqSnapshot | null {
  if (snapshot === null || scope.kind === 'all') return snapshot;
  const keep = (tag: ScopeTag): boolean => inScope(tag, scope, snapshot);
  const keys = keysByMachineId(snapshot);
  // A machine or a label: the set of machine keys inside the scope.
  const machineKeys = scopeMachineKeys(scope, snapshot) ?? new Set<string>();
  const byProject = scope.kind === 'project';
  const keyOf = machineKeyResolver(snapshot);
  const clients = snapshot.clients.filter((client) =>
    keep({ machineKey: keyOf(client.hostname, client.machineId), projectId: client.projectId }),
  );
  const liveSessions = (snapshot.liveSessions ?? []).filter((session) =>
    keep({ machineKey: keyOf(session.hostname, session.machineId), projectId: session.projectId }),
  );
  const projects = snapshot.projects.filter((project) =>
    byProject
      ? project.projectId === scope.id
      : project.machineIds.some((id) => machineKeys.has(keys.get(id) ?? '')),
  );
  const machines = (snapshot.machines ?? []).filter((machine) =>
    byProject
      ? machine.projectIds.includes(scope.id)
      : machineKeys.has(keyOf(machine.hostname, machine.machineId)),
  );
  // A remembered (offline) machine has no live record to scope by: it stays
  // in a project scope when that project ran there.
  const offlineMachines = (snapshot.offlineMachines ?? []).filter((machine) =>
    byProject
      ? machine.projects.some((project) => project.projectId === scope.id)
      : machineKeys.has(machine.key),
  );
  const fleets = snapshot.fleets.filter((fleet) =>
    keep({ clientId: fleet.clientId, projectId: fleet.projectId }),
  );
  const mcpServers = (snapshot.mcpServers ?? []).filter((server) =>
    keep({ clientId: server.clientId, projectId: server.projectId }),
  );
  const sessions = snapshot.sessions.filter((session) =>
    keep({ clientId: session.clientId, projectId: session.projectId }),
  );
  const mailboxes = snapshot.mailboxes.filter((mailbox) => keep({ projectId: mailbox.projectId }));
  const agents = liveSessions.reduce((sum, session) => sum + (session.agents?.length ?? 0), 0);
  return {
    ...snapshot,
    clients,
    projects,
    sessions,
    fleets,
    mailboxes,
    machines,
    offlineMachines,
    liveSessions,
    mcpServers,
    totals: {
      ...snapshot.totals,
      activeProjects: projects.length,
      activeClients: clients.filter((client) => client.connected).length,
      activeSessions: liveSessions.length,
      activeSubagents: fleets.reduce((sum, fleet) => sum + fleet.activeSubagents, 0),
      unreadMailboxMessages: mailboxes.reduce((sum, mailbox) => sum + mailbox.unreadCount, 0),
      incompleteMailboxMessages: mailboxes.reduce(
        (sum, mailbox) => sum + mailbox.incompleteCount,
        0,
      ),
      // A project's total spans every machine it runs on, so a machine's spend
      // is the sum of its own sessions instead.
      totalCostUsd:
        scope.kind === 'project'
          ? projects.reduce((sum, project) => sum + project.totalCostUsd, 0)
          : sessions.reduce((sum, session) => sum + (session.costUsd ?? 0), 0),
      activeMachines: machines.length,
      activeAgents: agents,
    },
  };
}

/** A hostname for a machine key, from whichever record carries one. */
export function machineLabel(snapshot: HqSnapshot | null, key: string): string {
  if (snapshot !== null) {
    const records = [
      ...(snapshot.machines ?? []),
      ...snapshot.clients,
      ...(snapshot.liveSessions ?? []),
    ];
    for (const record of records) {
      if (record.hostname && machineKeyOf(record.hostname, record.machineId) === key) {
        return record.hostname;
      }
    }
  }
  return key.replace(/^(host|mid):/, '');
}

/** "Whole fleet", a hostname, "gpu machines", or a project name. */
export function scopeLabel(scope: FleetScope, snapshot: HqSnapshot | null): string {
  if (scope.kind === 'all') return 'Whole fleet';
  if (scope.kind === 'machine') return machineLabel(snapshot, scope.id);
  if (scope.kind === 'label') return `${scope.id} machines`;
  return (
    snapshot?.projects.find((project) => project.projectId === scope.id)?.projectName ?? scope.id
  );
}
