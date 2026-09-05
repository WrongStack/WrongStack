import {
  NODE_COLORS,
  type VizEdge,
  type VizEvent,
  type VizEventKind,
  type VizNode,
  type VizState,
} from './viz-types.js';

export const MAX_VIZ_NODES = 400;
export const MAX_VIZ_EDGES = 1200;
export const VOLATILE_REFRESH_MS = 250;

let _eventSeq = 0;
export function nextId(): string {
  return `viz_${Date.now()}_${++_eventSeq}`;
}

export function contextPctFromLoad(load: unknown): number {
  const value = typeof load === 'number' && Number.isFinite(load) ? load : 0;
  return Math.max(0, Math.min(100, Math.round(value * 100)));
}

/** Map an event's source/kind to a VizNode kind. */
export function inferKind(event: VizEvent, isTarget = false): VizNode['kind'] {
  if (isTarget && event.target) {
    if (event.kind === 'agent:tool') return 'tool';
    if (event.kind === 'tool:executed' || event.kind === 'tool:started') return 'tool';
    if (event.source === 'leader' || event.source === 'coordinator') return 'coordinator';
    if (event.kind.startsWith('provider:')) return 'provider';
    if (event.kind.startsWith('mailbox:')) return 'mailbox';
  }
  switch (event.kind) {
    case 'provider:call':
    case 'provider:delta':
    case 'provider:response':
      return 'provider';
    case 'agent:spawned':
    case 'agent:tool':
    case 'agent:status':
    case 'agent:text':
    case 'agent:ctx':
    case 'budget:warning':
    case 'budget:extended':
      return 'agent';
    case 'tool:started':
    case 'tool:executed':
    case 'tool:progress':
      return 'tool';
    case 'mailbox:send':
    case 'mailbox:deliver':
      return 'mailbox';
    case 'collab:event':
      return 'system';
    case 'session:start':
    case 'session:end':
    case 'iteration:start':
    case 'iteration:end':
    case 'eternal:iteration':
    case 'fleet:snapshot':
      return 'session';
    case 'context:compacted':
    case 'context:repaired':
    case 'cost:update':
      return 'system';
    case 'error':
      return 'error';
    default:
      return 'system';
  }
}

/** Map an event kind to a node status. */
export function inferStatus(kind: VizEventKind): VizNode['status'] {
  switch (kind) {
    case 'provider:call':
    case 'provider:delta':
    case 'agent:tool':
    case 'tool:started':
    case 'tool:progress':
    case 'iteration:start':
    case 'agent:text':
      return 'streaming';
    case 'agent:status':
    case 'iteration:end':
      return 'completed';
    case 'error':
      return 'error';
    case 'tool:executed':
      return 'completed';
    case 'session:end':
      return 'idle';
    default:
      return 'active';
  }
}

export function presenceFresh(lastStamp: number, now: number): boolean {
  return now - lastStamp < VOLATILE_REFRESH_MS;
}

export function capByRecency<V>(
  map: Map<string, V>,
  max: number,
  recency: (v: V) => number,
): Map<string, V> {
  if (map.size <= max) return map;
  const byAge = [...map.entries()].sort((a, b) => recency(a[1]) - recency(b[1]));
  for (const [id] of byAge.slice(0, map.size - max)) map.delete(id);
  return map;
}

export function shallowEqual(
  a: Record<string, unknown> | null | undefined,
  b: Record<string, unknown> | null | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    const av = a[k];
    const bv = b[k];
    if (av === bv) continue;
    if (av == null || bv == null) return false;
    if (typeof av !== typeof bv) return false;
    if (typeof av === 'object') {
      if (Array.isArray(av) || Array.isArray(bv)) return false;
      if (!shallowEqual(av as Record<string, unknown>, bv as Record<string, unknown>)) return false;
      continue;
    }
    return false;
  }
  return true;
}

export function applyEventToGraph(
  state: VizState,
  event: VizEvent,
  now: number,
): { nodes: Map<string, VizNode>; edges: Map<string, VizEdge> } {
  const sourceId = event.source;
  const sourceNode: VizNode = {
    id: sourceId,
    kind: inferKind(event),
    label: event.label,
    status: inferStatus(event.kind),
    activity: 1.0,
    color: event.color ?? NODE_COLORS[inferKind(event)],
    lastSeenAt: now,
  };
  const existingSource = state.nodes.get(sourceId);
  let mergedSource: VizNode = existingSource ? { ...existingSource, ...sourceNode } : sourceNode;
  let sourceChanged = !shallowEqual(
    existingSource as unknown as Record<string, unknown> | undefined,
    mergedSource as unknown as Record<string, unknown>,
  );

  if (existingSource && sourceChanged && presenceFresh(existingSource.lastSeenAt, now)) {
    if (
      shallowEqual(
        {
          ...existingSource,
          activity: mergedSource.activity,
          lastSeenAt: mergedSource.lastSeenAt,
        } as unknown as Record<string, unknown>,
        mergedSource as unknown as Record<string, unknown>,
      )
    ) {
      mergedSource = existingSource;
      sourceChanged = false;
    }
  }

  let mergedTarget: VizNode | undefined;
  let targetChanged = false;
  let targetId: string | undefined;
  if (event.target) {
    targetId = event.target;
    const targetNode: VizNode = {
      id: targetId,
      kind: inferKind(event, true),
      label: targetId,
      status: inferStatus(event.kind),
      activity: 0.8,
      color: event.color ?? NODE_COLORS[inferKind(event, true)],
      lastSeenAt: now,
    };
    const existingTarget = state.nodes.get(targetId);
    mergedTarget = existingTarget ? { ...existingTarget, ...targetNode } : targetNode;
    targetChanged = !shallowEqual(
      existingTarget as unknown as Record<string, unknown> | undefined,
      mergedTarget as unknown as Record<string, unknown>,
    );
    if (existingTarget && targetChanged && presenceFresh(existingTarget.lastSeenAt, now)) {
      if (
        shallowEqual(
          {
            ...existingTarget,
            activity: mergedTarget.activity,
            lastSeenAt: mergedTarget.lastSeenAt,
          } as unknown as Record<string, unknown>,
          mergedTarget as unknown as Record<string, unknown>,
        )
      ) {
        mergedTarget = existingTarget;
        targetChanged = false;
      }
    }
  }

  let mergedEdge: VizEdge | undefined;
  let edgeChanged = false;
  let edgeId: string | undefined;
  if (event.target && sourceId) {
    edgeId = `${sourceId}->${event.target}`;
    const existingEdge = state.edges.get(edgeId);
    const newEdge: VizEdge = {
      id: edgeId,
      source: sourceId,
      target: event.target,
      kind: event.kind as VizEdge['kind'],
      label: event.label,
      intensity: existingEdge ? Math.min(1, existingEdge.intensity + 0.3) : 0.7,
      color: event.color ?? NODE_COLORS[inferKind(event)] ?? NODE_COLORS.agent,
      lastActiveAt: now,
      totalMagnitude: (existingEdge?.totalMagnitude ?? 0) + (event.magnitude ?? 0),
    };
    mergedEdge = existingEdge ? { ...existingEdge, ...newEdge } : newEdge;
    edgeChanged = !shallowEqual(
      existingEdge as unknown as Record<string, unknown> | undefined,
      mergedEdge as unknown as Record<string, unknown>,
    );
    if (existingEdge && edgeChanged && presenceFresh(existingEdge.lastActiveAt, now)) {
      if (
        shallowEqual(
          { ...existingEdge, lastActiveAt: mergedEdge.lastActiveAt } as unknown as Record<
            string,
            unknown
          >,
          mergedEdge as unknown as Record<string, unknown>,
        )
      ) {
        mergedEdge = existingEdge;
        edgeChanged = false;
      }
    }
  }

  let nodes: Map<string, VizNode> = state.nodes;
  let edges: Map<string, VizEdge> = state.edges;
  if (sourceChanged || targetChanged) {
    nodes = new Map(state.nodes);
    if (sourceChanged) nodes.set(sourceId, mergedSource);
    if (targetChanged && mergedTarget && targetId) nodes.set(targetId, mergedTarget);
  }
  if (edgeChanged && mergedEdge && edgeId) {
    edges = new Map(state.edges);
    edges.set(edgeId, mergedEdge);
  }

  if (nodes !== state.nodes) nodes = capByRecency(nodes, MAX_VIZ_NODES, (n) => n.lastSeenAt);
  if (edges !== state.edges) edges = capByRecency(edges, MAX_VIZ_EDGES, (e) => e.lastActiveAt);

  return { nodes, edges };
}
