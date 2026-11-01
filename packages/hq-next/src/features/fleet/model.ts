/**
 * Fleet rules as pure functions over the (already filtered) topology: the
 * machine → project → terminal → agent tree the list view renders, and the
 * figures in the toolbar. Only types come from the legacy domain.
 */
import type { FleetTopology, FleetTopologyNode } from '@hq/domain/fleet-topology-types';

export interface FleetTerminal {
  node: FleetTopologyNode;
  agents: FleetTopologyNode[];
}

export interface FleetProject {
  node: FleetTopologyNode;
  terminals: FleetTerminal[];
}

export interface FleetMachine {
  node: FleetTopologyNode;
  projects: FleetProject[];
}

const LIVE = new Set(['active', 'running', 'streaming']);
const NEEDS_HUMAN = new Set(['waiting_user', 'error']);

export function isLiveStatus(status: string | undefined): boolean {
  return status !== undefined && LIVE.has(status);
}

/** Rank so that what needs a human, then what is working, comes first. */
function urgency(node: FleetTopologyNode): number {
  if (node.status !== undefined && NEEDS_HUMAN.has(node.status)) return 0;
  if (isLiveStatus(node.status)) return 1;
  return 2;
}

function terminalUrgency(terminal: FleetTerminal): number {
  return Math.min(urgency(terminal.node), ...terminal.agents.map(urgency));
}

/**
 * Fold the topology's edges into a tree. Children are ordered by urgency and
 * then by label, so a waiting or failed agent never hides below idle ones.
 */
export function buildFleetTree(topology: FleetTopology): FleetMachine[] {
  const byId = new Map(topology.nodes.map((node) => [node.id, node]));
  const children = new Map<string, FleetTopologyNode[]>();
  const hasParent = new Set<string>();
  for (const edge of topology.edges) {
    const target = byId.get(edge.target);
    if (target === undefined || !byId.has(edge.source)) continue;
    hasParent.add(edge.target);
    const list = children.get(edge.source) ?? [];
    list.push(target);
    children.set(edge.source, list);
  }
  const of = (id: string, kind: FleetTopologyNode['kind']): FleetTopologyNode[] =>
    (children.get(id) ?? []).filter((node) => node.kind === kind);
  const byLabel = (left: FleetTopologyNode, right: FleetTopologyNode): number =>
    left.label.localeCompare(right.label);

  return topology.nodes
    .filter((node) => node.kind === 'machine' && !hasParent.has(node.id))
    .sort(byLabel)
    .map((machine) => ({
      node: machine,
      projects: of(machine.id, 'project')
        .sort(byLabel)
        .map((project) => ({
          node: project,
          terminals: of(project.id, 'terminal')
            .map((terminal) => ({
              node: terminal,
              agents: of(terminal.id, 'agent').sort(
                (left, right) => urgency(left) - urgency(right) || byLabel(left, right),
              ),
            }))
            .sort(
              (left, right) =>
                terminalUrgency(left) - terminalUrgency(right) || byLabel(left.node, right.node),
            ),
        })),
    }));
}

export interface FleetFigures {
  machines: number;
  terminals: number;
  agents: number;
  working: number;
  needsYou: number;
}

export function fleetFigures(topology: FleetTopology): FleetFigures {
  let machines = 0;
  let terminals = 0;
  let agents = 0;
  let working = 0;
  let needsYou = 0;
  for (const node of topology.nodes) {
    if (node.kind === 'machine') machines += 1;
    else if (node.kind === 'terminal') terminals += 1;
    else if (node.kind === 'agent') {
      agents += 1;
      if (isLiveStatus(node.status)) working += 1;
      if (node.status !== undefined && NEEDS_HUMAN.has(node.status)) needsYou += 1;
    }
  }
  return { machines, terminals, agents, working, needsYou };
}

/** Console URL for a node with a transcript, or null when it has none. */
export function consoleHref(node: FleetTopologyNode): string | null {
  if (node.sessionId === undefined || node.serviceMode !== undefined || node.isSyntheticSession)
    return null;
  const params = new URLSearchParams({ session: node.sessionId });
  if (node.agentId !== undefined) params.set('agent', node.agentId);
  return `/fleet/console/?${params.toString()}`;
}
