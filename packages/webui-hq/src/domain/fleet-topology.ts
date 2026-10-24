import type {
  HqClientRecord,
  HqMachineRecord,
  HqProjectRecord,
  HqSessionSnapshotPayload,
  HqSnapshot,
} from '@wrongstack/hq';
import type {
  FleetTopology,
  FleetTopologyEdge,
  FleetTopologyNode,
  FleetTopologyNodeKind,
} from './fleet-topology-types.js';

export {
  filterFleetTopology,
  filterFleetTopologyByIdle,
  filterFleetTopologyByQuery,
  isIdleAgentStatus,
  orderFleetTopologyNodes,
} from './fleet-topology-filters.js';
export type {
  FleetTopology,
  FleetTopologyEdge,
  FleetTopologyNode,
  FleetTopologyNodeKind,
  FleetTopologyScope,
} from './fleet-topology-types.js';

// ── Hierarchical auto-layout ────────────────────────────────────────────
//
// Tidy-tree over the four fixed columns (machine → project → terminal →
// agent). Children are packed depth-first: a terminal's agents occupy
// consecutive leaf slots, the terminal centers over them, the project
// centers over its terminals, the machine over its projects. Parents
// therefore always sit beside their own subtree and edges never cross
// between machine groups. (A naive per-column row counter numbers each
// column independently, so a project can land rows away from its machine.)

export interface FleetLayoutPosition {
  x: number;
  y: number;
}

/** Horizontal distance between the four columns. */
export const FLEET_COLUMN_GAP = 300;
/** Vertical footprint of one leaf slot (an agent, or a terminal without agents). */
export const FLEET_LEAF_H = 118;
/** Extra breathing room between terminal blocks under the same project. */
export const FLEET_TERMINAL_PAD = 18;
/** Extra gap between project blocks under the same machine. */
export const FLEET_PROJECT_PAD = 42;
/** Extra gap between machine blocks. */
export const FLEET_MACHINE_PAD = 64;

export function fleetColumnFor(kind: FleetTopologyNodeKind): number {
  if (kind === 'machine') return 0;
  if (kind === 'project') return 1;
  if (kind === 'terminal') return 2;
  return 3;
}

export function layoutFleetTopology(nodes: FleetTopologyNode[]): Map<string, FleetLayoutPosition> {
  const machines = nodes.filter((n) => n.kind === 'machine');
  const projectsByMachine = new Map<string, FleetTopologyNode[]>();
  const terminalsByProject = new Map<string, FleetTopologyNode[]>();
  const agentsByTerminal = new Map<string, FleetTopologyNode[]>();

  for (const node of nodes) {
    if (node.kind === 'project' && node.machineId !== undefined) {
      const list = projectsByMachine.get(node.machineId) ?? [];
      list.push(node);
      projectsByMachine.set(node.machineId, list);
    } else if (node.kind === 'terminal') {
      const key = projectKey(node.machineId ?? '', node.projectId ?? '');
      const list = terminalsByProject.get(key) ?? [];
      list.push(node);
      terminalsByProject.set(key, list);
    } else if (node.kind === 'agent' && node.sessionId !== undefined) {
      const list = agentsByTerminal.get(node.sessionId) ?? [];
      list.push(node);
      agentsByTerminal.set(node.sessionId, list);
    }
  }

  const yById = new Map<string, number>();
  let y = 0;
  const center = (ys: number[]): number =>
    ys.length === 0 ? 0 : ((ys[0] ?? 0) + (ys[ys.length - 1] ?? 0)) / 2;

  for (const machine of machines) {
    const projects = projectsByMachine.get(machine.machineId ?? '') ?? [];
    const projectYs: number[] = [];

    for (const project of projects) {
      const terminals = terminalsByProject.get(project.id) ?? [];
      const terminalYs: number[] = [];

      for (const terminal of terminals) {
        const agents = agentsByTerminal.get(terminal.sessionId ?? '') ?? [];
        let terminalY: number;
        if (agents.length > 0) {
          const agentYs: number[] = [];
          for (const agent of agents) {
            yById.set(agent.id, y);
            agentYs.push(y);
            y += FLEET_LEAF_H;
          }
          terminalY = center(agentYs);
        } else {
          terminalY = y;
          y += FLEET_LEAF_H;
        }
        yById.set(terminal.id, terminalY);
        terminalYs.push(terminalY);
        y += FLEET_TERMINAL_PAD;
      }

      let projectY: number;
      if (terminalYs.length > 0) {
        projectY = center(terminalYs);
      } else {
        projectY = y;
        y += FLEET_LEAF_H;
      }
      yById.set(project.id, projectY);
      projectYs.push(projectY);
      y += FLEET_PROJECT_PAD;
    }

    if (projectYs.length > 0) {
      yById.set(machine.id, center(projectYs));
    } else {
      yById.set(machine.id, y);
      y += FLEET_LEAF_H;
    }
    y += FLEET_MACHINE_PAD;
  }

  const positions = new Map<string, FleetLayoutPosition>();
  for (const node of nodes) {
    positions.set(node.id, {
      x: fleetColumnFor(node.kind) * FLEET_COLUMN_GAP,
      y: yById.get(node.id) ?? 0,
    });
  }
  return positions;
}

function machineKey(machineId: string): string {
  return `machine:${machineId}`;
}

function projectKey(machineId: string, projectId: string): string {
  return `project:${machineId}:${projectId}`;
}

function terminalKey(sessionId: string): string {
  return `terminal:${sessionId}`;
}

function agentKey(sessionId: string, agentId: string): string {
  return `agent:${sessionId}:${agentId}`;
}

function addEdge(
  edges: FleetTopologyEdge[],
  seen: Set<string>,
  source: string,
  target: string,
): void {
  const id = `${source}->${target}`;
  if (seen.has(id)) return;
  seen.add(id);
  edges.push({ id, source, target });
}

function projectLabel(
  project: HqProjectRecord | undefined,
  session?: HqSessionSnapshotPayload,
): string {
  return project?.projectName ?? session?.projectName ?? 'unknown project';
}

function projectSub(
  project: HqProjectRecord | undefined,
  session?: HqSessionSnapshotPayload,
): string | undefined {
  const root = project?.projectRootDisplay ?? session?.projectRoot;
  if (root === undefined || root.length === 0) return undefined;
  return root.length > 54 ? `…${root.slice(-51)}` : root;
}

function terminalLabel(session: HqSessionSnapshotPayload): string {
  if (session.clientKind === 'mailbox') {
    return `MAILBOX SERVE · ${session.pid ?? session.sessionId.slice(-8)}`;
  }
  return `${session.clientKind.toUpperCase()} · ${session.sessionId.length > 18 ? `…${session.sessionId.slice(-14)}` : session.sessionId}`;
}

/**
 * How long a freshly connected session-telemetry client may appear as a
 * "waiting for session telemetry" terminal. A live bridge publishes its first
 * snapshot within ~2.5s of connecting; a client that stays sessionless past
 * this window is a broken/legacy publisher and must not linger as a phantom.
 */
export const SYNTHETIC_TERMINAL_GRACE_MS = 45_000;

function syntheticSessionFromClient(
  client: HqClientRecord,
  project: HqProjectRecord | undefined,
): HqSessionSnapshotPayload {
  const sessionId = client.sessionId ?? `client:${client.clientId}`;
  return {
    sessionId,
    clientId: client.clientId,
    clientKind: client.kind,
    ...(client.version !== undefined ? { clientVersion: client.version } : {}),
    machineId: client.machineId,
    ...(client.hostname !== undefined ? { hostname: client.hostname } : {}),
    ...(client.pid !== undefined ? { pid: client.pid } : {}),
    projectId: client.projectId,
    projectName: project?.projectName ?? client.projectId,
    projectRoot: project?.projectRootDisplay ?? '',
    ...(project?.gitBranch !== undefined ? { gitBranch: project.gitBranch } : {}),
    status:
      client.connected && client.capabilities.includes('mailbox.serve')
        ? 'active'
        : client.connected
          ? 'idle'
          : 'stale',
    startedAt: client.connectedAt ?? client.lastSeenAt,
    lastActivityAt: client.lastSeenAt,
    agentCount: 0,
    agents: [],
  };
}

function machineRecordFor(
  machineId: string,
  machines: Map<string, HqMachineRecord>,
  sessions: readonly HqSessionSnapshotPayload[],
  clients: readonly HqClientRecord[],
): { label: string; sub: string; chips: string[] } {
  const machine = machines.get(machineId);
  const session = sessions.find((s) => s.machineId === machineId);
  const client = clients.find((c) => c.machineId === machineId);
  const label = machine?.hostname ?? session?.hostname ?? client?.hostname ?? machineId;
  const sessionCount =
    machine?.sessionCount ?? sessions.filter((s) => s.machineId === machineId).length;
  const agentCount =
    machine?.agentCount ??
    sessions.reduce((sum, s) => sum + (s.machineId === machineId ? s.agents.length : 0), 0);
  const clientCount =
    machine?.clientCount ?? clients.filter((c) => c.machineId === machineId && c.connected).length;
  const mailboxServeCount = clients.filter(
    (c) => c.machineId === machineId && c.connected && c.capabilities.includes('mailbox.serve'),
  ).length;
  return {
    label,
    sub: machineId,
    chips: [
      `${clientCount} client${clientCount === 1 ? '' : 's'}`,
      `${sessionCount} terminal${sessionCount === 1 ? '' : 's'}`,
      `${agentCount} agent${agentCount === 1 ? '' : 's'}`,
      ...(mailboxServeCount > 0 ? [`mailbox serve ×${mailboxServeCount}`] : []),
    ],
  };
}

export function buildFleetTopology(snapshot: HqSnapshot | null): FleetTopology {
  if (snapshot === null) return { nodes: [], edges: [] };

  const nodes: FleetTopologyNode[] = [];
  const edges: FleetTopologyEdge[] = [];
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();

  const machines = new Map((snapshot.machines ?? []).map((m) => [m.machineId, m]));
  const projects = new Map((snapshot.projects ?? []).map((p) => [p.projectId, p]));
  const liveSessions = [...(snapshot.liveSessions ?? [])];
  const liveSessionIds = new Set(liveSessions.map((s) => s.sessionId));

  // Processes already represented by a live session — their auxiliary
  // sockets (mailbox/brain publishers) must not spawn duplicate terminals.
  const liveSessionProcesses = new Set(
    liveSessions.filter((s) => s.pid !== undefined).map((s) => `${s.machineId}:${s.pid}`),
  );
  const generatedAt = Date.parse(snapshot.generatedAt);

  for (const client of snapshot.clients ?? []) {
    if (!client.connected) continue;
    const mailboxService = client.capabilities?.includes('mailbox.serve') === true;
    // Only session-telemetry surfaces qualify as a terminal-in-waiting.
    // Auxiliary sockets never publish session snapshots, so rendering them
    // would leave permanent phantom "waiting for session telemetry" nodes.
    // mailbox.serve is the exception: it is a deliberate, operator-visible
    // service client rather than a phantom terminal.
    if (!client.capabilities?.includes('session.summary') && !mailboxService) continue;
    if (client.pid !== undefined && liveSessionProcesses.has(`${client.machineId}:${client.pid}`)) {
      continue;
    }
    // A client that stayed sessionless past the grace window is a broken or
    // legacy publisher, not a terminal that is still booting.
    const connectedAt = Date.parse(client.connectedAt ?? client.lastSeenAt);
    if (
      !mailboxService &&
      Number.isFinite(generatedAt) &&
      Number.isFinite(connectedAt) &&
      generatedAt - connectedAt > SYNTHETIC_TERMINAL_GRACE_MS
    ) {
      continue;
    }
    const sessionId = client.sessionId ?? `client:${client.clientId}`;
    if (liveSessionIds.has(sessionId)) continue;
    liveSessions.push(syntheticSessionFromClient(client, projects.get(client.projectId)));
    liveSessionIds.add(sessionId);
  }

  const machineIds = new Set<string>();
  for (const machine of snapshot.machines ?? []) machineIds.add(machine.machineId);
  for (const session of liveSessions) machineIds.add(session.machineId);
  for (const client of snapshot.clients ?? []) {
    if (client.connected) machineIds.add(client.machineId);
  }

  for (const machineId of machineIds) {
    const id = machineKey(machineId);
    const record = machineRecordFor(machineId, machines, liveSessions, snapshot.clients ?? []);
    nodes.push({
      id,
      kind: 'machine',
      label: record.label,
      sub: record.sub,
      chips: record.chips,
      machineId,
    });
    nodeIds.add(id);
  }

  const sortedSessions = liveSessions.sort((a, b) => {
    const machineCompare = a.machineId.localeCompare(b.machineId);
    if (machineCompare !== 0) return machineCompare;
    const projectCompare = a.projectName.localeCompare(b.projectName);
    if (projectCompare !== 0) return projectCompare;
    return a.sessionId.localeCompare(b.sessionId);
  });

  for (const session of sortedSessions) {
    const machineId = session.machineId;
    const project = projects.get(session.projectId);
    const pId = projectKey(machineId, session.projectId);
    if (!nodeIds.has(pId)) {
      const fallbackCount = sortedSessions.filter(
        (s) => s.machineId === machineId && s.projectId === session.projectId,
      ).length;
      const clientCount = project?.activeClients ?? fallbackCount;
      const terminalCount = project?.activeSessions ?? fallbackCount;
      const chips = [
        `${clientCount} client${clientCount === 1 ? '' : 's'}`,
        `${terminalCount} terminal${terminalCount === 1 ? '' : 's'}`,
      ];
      if (project?.gitBranch !== undefined) chips.push(project.gitBranch);
      const mailboxServeCount = (snapshot.clients ?? []).filter(
        (client) =>
          client.connected &&
          client.machineId === machineId &&
          client.projectId === session.projectId &&
          client.capabilities.includes('mailbox.serve'),
      ).length;
      if (mailboxServeCount > 0) chips.push('mailbox serve');
      nodes.push({
        id: pId,
        kind: 'project',
        label: projectLabel(project, session),
        sub: projectSub(project, session),
        status: project?.status ?? session.status,
        chips,
        machineId,
        projectId: session.projectId,
      });
      nodeIds.add(pId);
    }
    addEdge(edges, edgeIds, machineKey(machineId), pId);

    const tId = terminalKey(session.sessionId);
    if (!nodeIds.has(tId)) {
      const isSynthetic = session.sessionId.startsWith('client:') && session.agents.length === 0;
      const serviceMode = session.clientKind === 'mailbox' ? 'mailbox-serve' : undefined;
      const clientRecord = (snapshot.clients ?? []).find(
        (candidate) => candidate.clientId === session.clientId,
      );
      const version = session.clientVersion ?? clientRecord?.version;
      const versionChip = version ? `v${version.replace(/^v/, '')}` : undefined;
      const chips = [
        serviceMode === 'mailbox-serve' ? 'mailbox serve' : session.clientKind,
        ...(versionChip !== undefined ? [versionChip] : []),
        session.status,
        ...(serviceMode === undefined
          ? [`${session.agentCount} agent${session.agentCount === 1 ? '' : 's'}`]
          : []),
      ];
      if (session.gitBranch !== undefined) chips.push(session.gitBranch);
      nodes.push({
        id: tId,
        kind: 'terminal',
        label: terminalLabel(session),
        sub:
          serviceMode === 'mailbox-serve'
            ? 'mailbox HTTP bridge'
            : isSynthetic
              ? 'waiting for session telemetry'
              : session.projectName,
        status: session.status,
        chips,
        machineId,
        projectId: session.projectId,
        ...(session.clientId !== undefined ? { clientId: session.clientId } : {}),
        sessionId: session.sessionId,
        clientKind: session.clientKind,
        ...(version !== undefined ? { version } : {}),
        session,
        isSyntheticSession: isSynthetic,
        ...(serviceMode !== undefined ? { serviceMode } : {}),
      });
      nodeIds.add(tId);
    }
    addEdge(edges, edgeIds, pId, tId);

    for (const agent of session.agents) {
      const aId = agentKey(session.sessionId, agent.id);
      nodes.push({
        id: aId,
        kind: 'agent',
        label: agent.name || agent.id,
        sub: agent.currentTool ?? agent.partialText,
        status: agent.status,
        chips: [
          agent.status,
          `${agent.iterations} iter`,
          `${agent.toolCalls} tools`,
          ...(agent.model !== undefined ? [agent.model] : []),
        ],
        machineId,
        projectId: session.projectId,
        ...(session.clientId !== undefined ? { clientId: session.clientId } : {}),
        sessionId: session.sessionId,
        agentId: agent.id,
        agent,
        session,
      });
      addEdge(edges, edgeIds, tId, aId);
    }
  }

  return { nodes, edges };
}

// ── Presence retention ─────────────────────────────────────────────────────

/**
 * How long a node that vanished from the snapshot stays on the map.
 *
 * HQ keeps a client's sessions in a map on the SOCKET, so any publisher
 * reconnect — a network blip, an HQ restart, a superseded duplicate — hands
 * the server a client with no sessions and the terminal (with all of its
 * agents) drops out of the very next broadcast. Rebuilding the map straight
 * off each snapshot turned that into a node blinking out and back, which
 * reads as fleet churn that never happened.
 *
 * The window has to outlast a reconnect without outlasting an operator's
 * patience: a publisher that is coming back is back within a couple of
 * seconds, and a terminal that really exited should not linger on the map
 * much longer than it takes to notice.
 */
export const FLEET_TOPOLOGY_RETENTION_MS = 45_000;

export interface FleetTopologyRetention {
  topology: FleetTopology;
  /** Node id -> epoch ms at which it was first seen missing. */
  missingSince: Record<string, number>;
}

function markRetained(node: FleetTopologyNode): FleetTopologyNode {
  if (node.retained === true) return node;
  return {
    ...node,
    retained: true,
    // Not an error state — nothing is known to be wrong, the publisher simply
    // is not reporting right now. `activityTone` reads this as idle (dim).
    status: 'offline',
    chips: [...node.chips, 'reconnecting…'],
  };
}

/**
 * Carry nodes the newest snapshot dropped for up to `graceMs`, then let them go.
 *
 * `previous` must be the RETAINED topology from the last pass, not the raw
 * one, so a node missing across several consecutive snapshots keeps its
 * original `missingSince` instead of having the clock restarted under it.
 *
 * An edge survives only when BOTH endpoints do. Ancestors are retained by the
 * same rule as their children (they went missing together, or the ancestor is
 * still present), so this cannot leave a dangling edge.
 */
export function retainFleetTopology(
  next: FleetTopology,
  previous: FleetTopology,
  missingSince: Readonly<Record<string, number>>,
  nowMs: number,
  graceMs: number = FLEET_TOPOLOGY_RETENTION_MS,
): FleetTopologyRetention {
  const presentIds = new Set(next.nodes.map((node) => node.id));
  const nodes = [...next.nodes];
  const nextMissingSince: Record<string, number> = {};

  for (const node of previous.nodes) {
    if (presentIds.has(node.id)) continue;
    const since = missingSince[node.id] ?? nowMs;
    if (nowMs - since > graceMs) continue;
    nextMissingSince[node.id] = since;
    nodes.push(markRetained(node));
    presentIds.add(node.id);
  }

  if (Object.keys(nextMissingSince).length === 0) {
    return { topology: next, missingSince: nextMissingSince };
  }

  const edges = [...next.edges];
  const edgeIds = new Set(next.edges.map((edge) => edge.id));
  for (const edge of previous.edges) {
    if (edgeIds.has(edge.id)) continue;
    if (!presentIds.has(edge.source) || !presentIds.has(edge.target)) continue;
    edges.push(edge);
    edgeIds.add(edge.id);
  }

  return { topology: { nodes, edges }, missingSince: nextMissingSince };
}
