/**
 * The Console's machine -> project -> client -> agent selector tree.
 *
 * Folded from the same `buildFleetTopology` output the Fleet Map renders, so
 * the nav and the map can never disagree about what the fleet contains.
 */
import type { HqSnapshot } from '@wrongstack/core/hq';
import {
  buildFleetTopology,
  type FleetTopology,
  type FleetTopologyNode,
} from './fleet-topology.js';

export interface NavAgent {
  id: string;
  label: string;
  status?: string | undefined;
  /** Carried from an earlier snapshot — see `retainFleetTopology`. */
  retained?: boolean | undefined;
}

export interface NavClient {
  clientId?: string | undefined;
  sessionId: string;
  label: string;
  clientKind?: string | undefined;
  status?: string | undefined;
  synthetic: boolean;
  /** Carried from an earlier snapshot — see `retainFleetTopology`. */
  retained?: boolean | undefined;
  agents: NavAgent[];
}

export interface NavProject {
  id: string;
  label: string;
  clients: NavClient[];
}

export interface NavMachine {
  id: string;
  label: string;
  sub?: string | undefined;
  projects: NavProject[];
}

export function buildNav(snapshot: HqSnapshot | null): NavMachine[] {
  return buildNavFromTopology(buildFleetTopology(snapshot));
}

/**
 * Same tree, from a topology that has already been built.
 *
 * The Console takes this form so it can fold in the map's presence retention
 * (`useRetainedFleetTopology`) instead of rebuilding a second, unretained
 * topology — otherwise the nav would blink a terminal out while the map beside
 * it still showed the node.
 */
export function buildNavFromTopology(topology: FleetTopology): NavMachine[] {
  const machines: NavMachine[] = [];
  const machineById = new Map<string, NavMachine>();
  const projectById = new Map<string, NavProject>();
  const clientBySession = new Map<string, NavClient>();

  const machineKey = (node: FleetTopologyNode): string => `machine:${node.machineId}`;
  const projectKey = (node: FleetTopologyNode): string =>
    `project:${node.machineId}:${node.projectId}`;

  for (const node of topology.nodes) {
    if (node.kind !== 'machine') continue;
    const machine: NavMachine = { id: node.id, label: node.label, sub: node.sub, projects: [] };
    machineById.set(node.id, machine);
    machines.push(machine);
  }

  for (const node of topology.nodes) {
    if (node.kind !== 'project') continue;
    const machine = machineById.get(machineKey(node));
    if (machine === undefined) continue;
    const project: NavProject = { id: node.id, label: node.label, clients: [] };
    projectById.set(node.id, project);
    machine.projects.push(project);
  }

  for (const node of topology.nodes) {
    if (
      node.kind !== 'terminal' ||
      node.sessionId === undefined ||
      node.serviceMode !== undefined
    ) {
      continue;
    }
    const project = projectById.get(projectKey(node));
    if (project === undefined) continue;
    const client: NavClient = {
      clientId: node.clientId,
      sessionId: node.sessionId,
      label: node.label,
      clientKind: node.clientKind,
      status: node.status,
      synthetic: node.isSyntheticSession === true,
      ...(node.retained === true ? { retained: true } : {}),
      agents: [],
    };
    clientBySession.set(node.sessionId, client);
    project.clients.push(client);
  }

  for (const node of topology.nodes) {
    if (node.kind !== 'agent' || node.sessionId === undefined || node.agentId === undefined) {
      continue;
    }
    const client = clientBySession.get(node.sessionId);
    if (client === undefined) continue;
    client.agents.push({
      id: node.agentId,
      label: node.label,
      status: node.status,
      ...(node.retained === true ? { retained: true } : {}),
    });
  }

  // Drop machines and projects that ended up empty — e.g. a machine whose only
  // session just closed. An empty branch is noise in a selector.
  return machines
    .map((machine) => ({
      ...machine,
      projects: machine.projects.filter((project) => project.clients.length > 0),
    }))
    .filter((machine) => machine.projects.length > 0);
}
