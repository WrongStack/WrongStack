import type {
  FleetTopology,
  FleetTopologyNode,
  FleetTopologyScope,
} from './fleet-topology-types.js';

/** Keep one operator-selected slice while preserving the hierarchy needed to
 * understand it. Project scope intentionally spans machines: selecting a
 * project shows every machine currently working on that project. A machine
 * scope may name several raw machine ids — every process on one computer, or
 * every machine carrying a label. An empty id set matches nothing (a label
 * whose machines are all offline), never everything. */
export function filterFleetTopology(
  topology: FleetTopology,
  scope: FleetTopologyScope,
  scopeId?: string | ReadonlySet<string>,
): FleetTopology {
  if (scope === 'all' || scopeId === undefined) return topology;
  if (typeof scopeId === 'string' && scopeId.length === 0) return topology;

  const included = new Set<string>();
  if (scope === 'machine') {
    const ids = typeof scopeId === 'string' ? new Set([scopeId]) : scopeId;
    for (const node of topology.nodes) {
      if (node.machineId !== undefined && ids.has(node.machineId)) included.add(node.id);
    }
  } else {
    const machineIds = new Set<string>();
    for (const node of topology.nodes) {
      if (typeof scopeId !== 'string' || node.projectId !== scopeId) continue;
      included.add(node.id);
      if (node.machineId !== undefined) machineIds.add(node.machineId);
    }
    for (const node of topology.nodes) {
      if (
        node.kind === 'machine' &&
        node.machineId !== undefined &&
        machineIds.has(node.machineId)
      ) {
        included.add(node.id);
      }
    }
  }

  return {
    nodes: topology.nodes.filter((node) => included.has(node.id)),
    edges: topology.edges.filter((edge) => included.has(edge.source) && included.has(edge.target)),
  };
}

/** Search the visible fleet without losing the hierarchy around a match.
 * Ancestors explain where a terminal/agent lives; descendants are included
 * when a container or terminal itself matches so the result remains useful. */
export function filterFleetTopologyByQuery(topology: FleetTopology, query: string): FleetTopology {
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length === 0) return topology;

  const nodeById = new Map(topology.nodes.map((node) => [node.id, node]));
  const parentById = new Map<string, string>();
  const childrenById = new Map<string, string[]>();
  for (const edge of topology.edges) {
    parentById.set(edge.target, edge.source);
    const children = childrenById.get(edge.source) ?? [];
    children.push(edge.target);
    childrenById.set(edge.source, children);
  }

  const included = new Set<string>();
  const expanded = new Set<string>();
  const addAncestors = (nodeId: string): void => {
    let current: string | undefined = nodeId;
    while (current !== undefined && !included.has(current)) {
      included.add(current);
      current = parentById.get(current);
    }
  };
  const addDescendants = (nodeId: string): void => {
    if (expanded.has(nodeId)) return;
    expanded.add(nodeId);
    included.add(nodeId);
    for (const childId of childrenById.get(nodeId) ?? []) addDescendants(childId);
  };

  for (const node of topology.nodes) {
    const haystack = [
      node.kind,
      node.label,
      node.sub,
      node.status,
      node.clientKind,
      node.version,
      node.serviceMode,
      node.machineId,
      node.projectId,
      node.clientId,
      node.sessionId,
      node.agentId,
      ...node.chips,
    ]
      .filter((value): value is string => typeof value === 'string')
      .join(' ')
      .toLocaleLowerCase();
    if (!haystack.includes(needle)) continue;
    addAncestors(node.id);
    addDescendants(node.id);
  }

  // Guard against malformed edges while keeping the function total.
  for (const id of [...included]) {
    if (!nodeById.has(id)) included.delete(id);
  }
  return {
    nodes: topology.nodes.filter((node) => included.has(node.id)),
    edges: topology.edges.filter((edge) => included.has(edge.source) && included.has(edge.target)),
  };
}

/**
 * Agent statuses that mean "doing work, or needs the operator": actively
 * working, waiting on the user, or errored. Everything else ('idle',
 * 'offline' while retained, unknown) reads as dormant. Hiding idle workers
 * must never swallow an agent the operator may need to act on.
 */
const ATTENDING_AGENT_STATUSES = new Set<string>([
  'active',
  'running',
  'streaming',
  'waiting_user',
  'error',
]);

/** True when an agent is neither working, waiting on the user, nor errored. */
export function isIdleAgentStatus(status: string | undefined): boolean {
  return !ATTENDING_AGENT_STATUSES.has(status ?? '');
}

/**
 * Hide idle agent nodes while keeping the graph a valid hierarchy.
 *
 * With `hideIdle` on, agent nodes whose status is dormant are removed, and a
 * terminal whose agents were ALL removed by this filter folds away with
 * them — an empty terminal shell is exactly the clutter the toggle exists
 * to remove. Terminals that never had agent children (synthetic session
 * placeholders) and the machine/project spine always stay, so the map
 * never lies about what is connected.
 */
export function filterFleetTopologyByIdle(
  topology: FleetTopology,
  hideIdle: boolean,
): FleetTopology {
  if (!hideIdle) return topology;

  const childrenById = new Map<string, string[]>();
  for (const edge of topology.edges) {
    const children = childrenById.get(edge.source) ?? [];
    children.push(edge.target);
    childrenById.set(edge.source, children);
  }

  const included = new Set<string>();
  for (const node of topology.nodes) {
    if (node.kind !== 'agent' || !isIdleAgentStatus(node.status)) included.add(node.id);
  }

  for (const node of topology.nodes) {
    if (node.kind !== 'terminal') continue;
    const agentIds = childrenById.get(node.id) ?? [];
    // No agent children means the terminal never had any (synthetic
    // placeholder) — the filter did not empty it, so it stays.
    if (agentIds.length === 0) continue;
    if (agentIds.every((agentId) => !included.has(agentId))) included.delete(node.id);
  }

  return {
    nodes: topology.nodes.filter((node) => included.has(node.id)),
    edges: topology.edges.filter((edge) => included.has(edge.source) && included.has(edge.target)),
  };
}

/** Return nodes in hierarchy order even though the topology builder stores
 * machine records before session-derived project/terminal records. */
export function orderFleetTopologyNodes(topology: FleetTopology): FleetTopologyNode[] {
  const nodeById = new Map(topology.nodes.map((node) => [node.id, node]));
  const childIds = new Set(topology.edges.map((edge) => edge.target));
  const childrenById = new Map<string, string[]>();
  for (const edge of topology.edges) {
    const children = childrenById.get(edge.source) ?? [];
    children.push(edge.target);
    childrenById.set(edge.source, children);
  }

  const ordered: FleetTopologyNode[] = [];
  const seen = new Set<string>();
  const visit = (nodeId: string): void => {
    if (seen.has(nodeId)) return;
    seen.add(nodeId);
    const node = nodeById.get(nodeId);
    if (node !== undefined) ordered.push(node);
    for (const childId of childrenById.get(nodeId) ?? []) visit(childId);
  };
  for (const node of topology.nodes) {
    if (!childIds.has(node.id)) visit(node.id);
  }
  for (const node of topology.nodes) visit(node.id);
  return ordered;
}
