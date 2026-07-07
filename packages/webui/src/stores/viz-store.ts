/**
 * VizStore — Real-time cinematic event stream for the AgentFlow visualization.
 *
 * Holds a ring buffer of structured events from the entire agent ecosystem:
 * provider calls, agent spawns, tool executions, mailbox messages, etc.
 * Every event is typed with a `vizKind` for the renderer to pattern-match on.
 */

import { create } from 'zustand';

// ── Event types ───────────────────────────────────────────────────────

/** Categories the cinematic renderer understands. */
export type VizEventKind =
  | 'provider:call'        // LLM provider call started
  | 'provider:delta'       // Streaming text delta
  | 'provider:response'    // Provider response received
  | 'agent:spawned'        // Agent (leader or subagent) spawned
  | 'agent:tool'           // Agent executed a tool
  | 'agent:status'         // Agent status change (running → completed/failed)
  | 'agent:ctx'            // Agent context pressure update
  | 'agent:text'           // Agent streaming/partial text
  | 'tool:started'         // Tool execution started
  | 'tool:executed'        // Tool execution completed
  | 'tool:progress'        // Tool progress update
  | 'mailbox:send'         // Mailbox message sent
  | 'mailbox:deliver'      // Mailbox message delivered/read
  | 'collab:event'         // Collaboration observer/control event
  | 'session:start'        // Session started/resumed
  | 'session:end'          // Session ended
  | 'iteration:start'      // Iteration started
  | 'iteration:end'        // Iteration completed
  | 'eternal:iteration'    // Eternal-autonomy journal tick
  | 'error'                // Error occurred
  | 'context:compacted'    // Context compaction
  | 'context:repaired'     // Context repair
  | 'budget:warning'       // Agent budget warning
  | 'budget:extended'      // Agent budget extended
  | 'cost:update'          // Cost/token update
  | 'fleet:snapshot'       // Cross-process fleet snapshot (sessions + agents)
  ;

export interface VizEvent {
  id: string;
  kind: VizEventKind;
  timestamp: number;
  /** Source node id (e.g. provider id, agent id, tool name) */
  source: string;
  /** Target node id (optional — e.g. provider for tool calls) */
  target?: string | undefined;
  /** Display label */
  label: string;
  /** Numeric magnitude (tokens, cost, duration) for size/color mapping */
  magnitude?: number | undefined;
  /** Extra structured payload for the renderer */
  data?: Record<string, unknown> | undefined;
  /** The raw WS payload for drill-down in detail panels */
  raw?: unknown;
  /** Grouping key for the flow (e.g. 'iteration:3', 'agent:leader') */
  flowGroup?: string | undefined;
  /** Color hint for the renderer */
  color?: string | undefined;
}

/** Active connection between two nodes in the flow graph. */
export interface VizEdge {
  id: string;
  source: string;
  target: string;
  kind: VizEventKind;
  label: string;
  /** Flow intensity 0–1 for animation speed/opacity */
  intensity: number;
  /** Color for the edge */
  color: string;
  /** When this edge was last active */
  lastActiveAt: number;
  /** Cumulative magnitude (tokens, calls, etc.) */
  totalMagnitude: number;
}

/** Node in the flow graph — represents a live entity. */
export interface VizNode {
  id: string;
  kind: 'provider' | 'agent' | 'tool' | 'mailbox' | 'session' | 'system' | 'error' | 'coordinator';
  label: string;
  sublabel?: string | undefined;
  status: 'idle' | 'active' | 'streaming' | 'completed' | 'error';
  /** 0–1 activity level for glow/pulse */
  activity: number;
  /** Color theme */
  color: string;
  /** Provider/model info */
  provider?: string | undefined;
  model?: string | undefined;
  /** For agents: stats */
  iterations?: number | undefined;
  toolCalls?: number | undefined;
  costUsd?: number | undefined;
  ctxPct?: number | undefined;
  ctxTokens?: number | undefined;
  maxContext?: number | undefined;
  /** For agents: current tool name */
  currentTool?: string | undefined;
  /** For agents: session id */
  sessionId?: string | undefined;
  /** Magnitude for sizing */
  magnitude?: number | undefined;
  /** When this node was last updated */
  lastSeenAt: number;
  /** Position hints for the layout engine */
  positionHint?: { zone: 'left' | 'center' | 'right' | 'top' | 'bottom'; order: number } | undefined;
}

function contextPctFromLoad(load: unknown): number {
  const value = typeof load === 'number' && Number.isFinite(load) ? load : 0;
  return Math.max(0, Math.min(100, Math.round(value * 100)));
}

// ── Store state ───────────────────────────────────────────────────────

interface VizState {
  /** Ring buffer of recent events — newest first. */
  events: VizEvent[];
  /** Live nodes in the flow graph. */
  nodes: Map<string, VizNode>;
  /** Active edges between nodes. */
  edges: Map<string, VizEdge>;
  /** Whether the visualization is actively running. */
  isActive: boolean;
  /** Max events to keep in the ring buffer. */
  maxEvents: number;
  /** Counters for the HUD */
  counters: {
    totalTokens: number;
    totalCost: number;
    totalToolCalls: number;
    activeAgents: number;
    completedTasks: number;
    errors: number;
    mailboxMessages: number;
  };

  // Actions
  pushEvent: (event: VizEvent) => void;
  upsertNode: (node: Partial<VizNode> & { id: string; kind: VizNode['kind']; label: string }) => void;
  removeNode: (id: string) => void;
  upsertEdge: (edge: Partial<VizEdge> & { id: string; source: string; target: string; kind: VizEdge['kind']; label: string }) => void;
  removeEdge: (id: string) => void;
  clear: () => void;
  setActive: (active: boolean) => void;
  decayActivity: () => void;
  prunesStale: (olderThan: number) => void;
}

// ── Kind/status inference helpers ─────────────────────────────────────

/** Map an event's source/kind to a VizNode kind. */
function inferKind(event: VizEvent, isTarget = false): VizNode['kind'] {
  if (isTarget && event.target) {
    // Tools appear as targets of agent:tool
    if (event.kind === 'agent:tool') return 'tool';
    if (event.kind === 'tool:executed' || event.kind === 'tool:started') return 'tool';
    // The leader is the coordinator
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
function inferStatus(kind: VizEventKind): VizNode['status'] {
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

// ── Helpers ───────────────────────────────────────────────────────────

let _eventSeq = 0;
function nextId(): string {
  return `viz_${Date.now()}_${++_eventSeq}`;
}

/**
 * Shallow object equality for plain objects with string keys.
 *
 * Used by `pushEvent` to skip cloning `nodes`/`edges` Maps when an
 * upsert would produce a value equal to the existing one — keeps
 * zustand's per-key reference comparison stable so subscribers that
 * selected only `nodes` or only `edges` skip a re-render.
 *
 * Arrays and Maps are treated as unequal unless they share the same
 * reference (VizNode/VizEdge don't contain arrays or Maps today, so
 * this is sufficient for the current shape — widen if that changes).
 */

function shallowEqual(a: Record<string, unknown> | null | undefined, b: Record<string, unknown> | null | undefined): boolean {
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
      // Only recurse one level into plain objects — arrays/Maps count as
      // different references unless they're the same instance.
      if (Array.isArray(av) || Array.isArray(bv)) return false;
      if (!shallowEqual(av as Record<string, unknown>, bv as Record<string, unknown>)) return false;
      continue;
    }
    return false;
  }
  return true;
}

const NODE_COLORS: Record<string, string> = {
  provider: 'hsl(var(--info))',
  agent: 'hsl(var(--primary))',
  tool: 'hsl(var(--warning))',
  mailbox: 'hsl(var(--success))',
  session: 'hsl(var(--primary))',
  system: 'hsl(var(--muted-foreground))',
  success: 'hsl(var(--success))',
  error: 'hsl(var(--destructive))',
};

const EDGE_COLORS: Record<string, string> = {
  'provider:call': 'hsl(var(--info))',
  'provider:delta': 'hsl(var(--primary))',
  'agent:tool': 'hsl(var(--warning))',
  'mailbox:send': 'hsl(var(--success))',
  default: 'hsl(var(--muted-foreground))',
};

// ── Store ─────────────────────────────────────────────────────────────

export const useVizStore = create<VizState>()((set, _get) => ({
  events: [],
  nodes: new Map(),
  edges: new Map(),
  isActive: false,
  maxEvents: 2000,
  counters: {
    totalTokens: 0,
    totalCost: 0,
    totalToolCalls: 0,
    activeAgents: 0,
    completedTasks: 0,
    errors: 0,
    mailboxMessages: 0,
  },

  pushEvent: (event) => set((state) => {
    const events = [{ ...event, id: event.id ?? nextId(), timestamp: event.timestamp || Date.now() }, ...state.events];
    if (events.length > state.maxEvents) events.length = state.maxEvents;

    // ── Apply event to nodes/edges maps ───────────────────────────
    // Perf note (Track E.7): the throttling/coalescing policy for
    // high-frequency events (provider:delta, tool:progress) is parked
    // pending a design call from someone with viz-store context. Until
    // that lands, this push path keeps the per-event shape but skips
    // the Map clone when every upsert is shallow-equal to the existing
    // entry — preserves zustand's reference-stable contract for
    // subscribers that select only nodes or only edges.
    const now = Date.now();

    // Upsert source node
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
    const mergedSource: VizNode = existingSource ? { ...existingSource, ...sourceNode } : sourceNode;
    const sourceChanged = !shallowEqual(
      existingSource as unknown as Record<string, unknown> | undefined,
      mergedSource as unknown as Record<string, unknown>,
    );

    // Upsert target node if present
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
    }

    // Upsert edge if both endpoints present
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
    }

    // Only allocate new Maps when something actually changed. Otherwise
    // return the existing references so zustand skips the notification.
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

    return { events, nodes, edges };
  }),

  upsertNode: (partial) => set((state) => {
    const nodes = new Map(state.nodes);
    const existing = nodes.get(partial.id);
    nodes.set(partial.id, {
      ...existing,
      ...partial,
      lastSeenAt: partial.lastSeenAt !== undefined ? partial.lastSeenAt : Date.now(),
    } as VizNode);
    return { nodes };
  }),

  removeNode: (id) => set((state) => {
    const nodes = new Map(state.nodes);
    nodes.delete(id);
    const edges = new Map(state.edges);
    for (const [eid, edge] of edges) {
      if (edge.source === id || edge.target === id) edges.delete(eid);
    }
    return { nodes, edges };
  }),

  upsertEdge: (partial) => set((state) => {
    const edges = new Map(state.edges);
    const existing = edges.get(partial.id);
    edges.set(partial.id, {
      ...existing,
      ...partial,
      lastActiveAt: partial.lastActiveAt !== undefined ? partial.lastActiveAt : Date.now(),
      intensity: partial.intensity ?? existing?.intensity ?? 0.5,
      color: partial.color ?? EDGE_COLORS[partial.kind] ?? EDGE_COLORS.default,
      totalMagnitude: (existing?.totalMagnitude ?? 0) + (partial.totalMagnitude ?? 0),
    } as VizEdge & { totalMagnitude: number });
    return { edges };
  }),

  removeEdge: (id) => set((state) => {
    const edges = new Map(state.edges);
    edges.delete(id);
    return { edges };
  }),

  clear: () => set({
    events: [],
    nodes: new Map(),
    edges: new Map(),
    counters: {
      totalTokens: 0, totalCost: 0, totalToolCalls: 0,
      activeAgents: 0, completedTasks: 0, errors: 0, mailboxMessages: 0,
    },
  }),

  setActive: (active) => set({ isActive: active }),

  decayActivity: () => set((state) => {
    const nodes = new Map(state.nodes);
    for (const [id, node] of nodes) {
      if (node.activity >= 0.01) {
        const decayed = node.activity * 0.92;
        nodes.set(id, { ...node, activity: decayed < 0.01 ? 0 : decayed });
      }
    }
    const edges = new Map(state.edges);
    for (const [id, edge] of edges) {
      if (edge.intensity >= 0.01) {
        const decayed = edge.intensity * 0.90;
        edges.set(id, { ...edge, intensity: decayed < 0.01 ? 0 : decayed });
      }
    }
    return { nodes, edges };
  }),

  prunesStale: (olderThan) => set((state) => {
    const cutoff = Date.now() - olderThan;
    const nodes = new Map(state.nodes);
    for (const [id, node] of nodes) {
      if (node.lastSeenAt < cutoff && node.status !== undefined && node.status !== 'active') nodes.delete(id);
    }
    const edges = new Map(state.edges);
    for (const [id, edge] of edges) {
      if (edge.lastActiveAt < cutoff) edges.delete(id);
    }
    const events = state.events.filter((e) => e.timestamp > cutoff);
    return { nodes, edges, events };
  }),
}));

// ── Event pipeline helper ─────────────────────────────────────────────
// Called from ws-handlers.ts to convert raw WS messages to VizEvents.

export function wsToVizEvent(
  wsType: string,
  payload: Record<string, unknown>,
): VizEvent | null {
  switch (wsType) {
    case 'provider.text_delta': {
      const text = (payload.text as string) ?? '';
      return {
        id: nextId(), kind: 'provider:delta', timestamp: Date.now(),
        source: 'provider', target: 'leader',
        label: text.slice(0, 60), magnitude: text.length,
        data: { text },
        color: NODE_COLORS.provider,
        flowGroup: 'provider',
      };
    }
    case 'provider.response': {
      const usage = payload.usage as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | undefined;
      const total = (usage?.input ?? 0) + (usage?.output ?? 0);
      return {
        id: nextId(), kind: 'provider:response', timestamp: Date.now(),
        source: 'provider', target: 'leader',
        label: `${(usage?.input ?? 0).toLocaleString('en-US')} in / ${(usage?.output ?? 0).toLocaleString('en-US')} out`,
        magnitude: total,
        data: payload as Record<string, unknown>,
        color: NODE_COLORS.provider,
        flowGroup: 'provider',
      };
    }
    case 'provider.stream_error': {
      const message = payload.message as string ?? 'Provider stream error';
      return {
        id: nextId(), kind: 'error', timestamp: Date.now(),
        source: 'provider', target: 'leader',
        label: message.slice(0, 80),
        magnitude: 1,
        data: payload as Record<string, unknown>,
        color: NODE_COLORS.error,
        flowGroup: 'provider',
      };
    }
    case 'tool.started': {
      const name = payload.name as string ?? 'tool';
      return {
        id: nextId(), kind: 'tool:started', timestamp: Date.now(),
        source: name, target: 'filesystem',
        label: name, magnitude: 1,
        data: payload as Record<string, unknown>,
        color: NODE_COLORS.tool,
        flowGroup: `tool:${name}`,
      };
    }
    case 'tool.executed': {
      const name = payload.name as string ?? 'tool';
      const ok = payload.ok as boolean ?? true;
      return {
        id: nextId(), kind: 'tool:executed', timestamp: Date.now(),
        source: name, target: 'leader',
        label: `${name} ${ok ? '✓' : '✗'} (${payload.durationMs as number ?? 0}ms)`,
        magnitude: payload.durationMs as number ?? 0,
        data: payload as Record<string, unknown>,
        color: ok ? NODE_COLORS.tool : NODE_COLORS.error,
        flowGroup: `tool:${name}`,
      };
    }
    case 'tool.progress': {
      const name = payload.name as string ?? 'tool';
      const text = (payload.event as { type?: string; text?: string } | undefined)?.text ?? '';
      return {
        id: nextId(), kind: 'tool:progress', timestamp: Date.now(),
        source: name, target: 'leader',
        label: text.slice(0, 60) || name,
        magnitude: text.length,
        data: payload as Record<string, unknown>,
        color: NODE_COLORS.tool,
        flowGroup: `tool:${name}`,
      };
    }
    case 'tool.loop_detected': {
      const tools = payload.tools as string ?? '';
      const kind = payload.kind as string ?? 'loop';
      return {
        id: nextId(), kind: 'error', timestamp: Date.now(),
        source: tools || kind, target: 'leader',
        label: `${kind} loop x${payload.repeatCount as number ?? 0}`,
        magnitude: payload.repeatCount as number ?? 1,
        data: payload as Record<string, unknown>,
        color: NODE_COLORS.error,
        flowGroup: 'tool',
      };
    }
    case 'delegate.started': {
      const target = payload.target as string ?? 'delegate';
      const task = payload.task as string ?? '';
      return {
        id: nextId(), kind: 'agent:status', timestamp: Date.now(),
        source: 'leader', target,
        label: task.slice(0, 80) || `Delegating to ${target}`,
        magnitude: 1,
        data: payload as Record<string, unknown>,
        color: NODE_COLORS.agent,
        flowGroup: `delegate:${target}`,
      };
    }
    case 'delegate.completed': {
      const target = payload.subagentId as string ?? payload.target as string ?? 'delegate';
      const ok = payload.ok as boolean ?? false;
      return {
        id: nextId(), kind: ok ? 'agent:status' : 'error', timestamp: Date.now(),
        source: target, target: 'leader',
        label: (payload.summary as string ?? payload.status as string ?? 'delegate completed').slice(0, 80),
        magnitude: payload.durationMs as number ?? 1,
        data: payload as Record<string, unknown>,
        color: ok ? NODE_COLORS.agent : NODE_COLORS.error,
        flowGroup: `delegate:${target}`,
      };
    }
    case 'subagent.event': {
      const kind = payload.kind as string;
      const agentId = payload.subagentId as string ?? 'unknown';
      const agentName = payload.name as string ?? agentId;
      switch (kind) {
        case 'spawned':
          return {
            id: nextId(), kind: 'agent:spawned', timestamp: Date.now(),
            source: agentId, target: 'session',
            label: `${agentName} spawned`,
            magnitude: 1,
            data: payload as Record<string, unknown>,
            color: NODE_COLORS.agent,
            flowGroup: `agent:${agentId}`,
          };
        case 'tool_executed': {
          const toolName = payload.toolName as string ?? 'tool';
          const toolOk = payload.ok as boolean ?? true;
          return {
            id: nextId(), kind: 'agent:tool', timestamp: Date.now(),
            source: agentId, target: toolName,
            label: toolName,
            magnitude: payload.durationMs as number ?? 0,
            data: payload as Record<string, unknown>,
            color: toolOk ? NODE_COLORS.tool : NODE_COLORS.error,
            flowGroup: `agent:${agentId}`,
          };
        }
        case 'task_completed': {
          const status = payload.status as string ?? 'completed';
          return {
            id: nextId(), kind: 'agent:status', timestamp: Date.now(),
            source: agentId, target: 'session',
            label: `${agentName} ${status}`,
            magnitude: 1,
            data: payload as Record<string, unknown>,
            color: status === 'success' ? NODE_COLORS.success : NODE_COLORS.error,
            flowGroup: `agent:${agentId}`,
          };
        }
        case 'ctx_pct':
          return {
            id: nextId(), kind: 'agent:ctx', timestamp: Date.now(),
            source: agentId, target: 'session',
            label: `ctx ${contextPctFromLoad(payload.load)}%`,
            magnitude: payload.tokens as number ?? 0,
            data: payload as Record<string, unknown>,
            color: NODE_COLORS.agent,
            flowGroup: `agent:${agentId}`,
          };
        case 'iteration_summary':
          return {
            id: nextId(), kind: 'agent:text', timestamp: Date.now(),
            source: agentId, target: 'session',
            label: (payload.partialText as string ?? '').slice(0, 80) || `iter ${payload.iteration as number ?? 0}`,
            magnitude: payload.costUsd as number ?? 0,
            data: payload as Record<string, unknown>,
            color: NODE_COLORS.agent,
            flowGroup: `agent:${agentId}`,
          };
        case 'budget_extended':
          return {
            id: nextId(), kind: 'budget:extended', timestamp: Date.now(),
            source: agentId, target: 'session',
            label: `${agentName} extended budget`,
            magnitude: payload.totalExtensions as number ?? 1,
            data: payload as Record<string, unknown>,
            color: NODE_COLORS.tool,
            flowGroup: `agent:${agentId}`,
          };
        case 'budget_warning':
          return {
            id: nextId(), kind: 'budget:warning', timestamp: Date.now(),
            source: agentId, target: 'session',
            label: `${agentName} hit ${payload.budgetKind as string ?? 'budget'} ${payload.used as number ?? 0}/${payload.limit as number ?? 0}`,
            magnitude: payload.used as number ?? 1,
            data: payload as Record<string, unknown>,
            color: NODE_COLORS.error,
            flowGroup: `agent:${agentId}`,
          };
      }
      return null;
    }
    case 'mailbox.event': {
      const eventName = payload.event as string;
      const from = payload.from as string ?? '?';
      const to = payload.to as string ?? '?';
      const subject = payload.subject as string ?? '';
      const isSend = eventName === 'mailbox.sent';
      return {
        id: nextId(), kind: isSend ? 'mailbox:send' : 'mailbox:deliver', timestamp: Date.now(),
        source: from, target: to,
        label: subject || (isSend ? `→ ${to}` : `← ${from}`),
        magnitude: 1,
        data: payload as Record<string, unknown>,
        color: NODE_COLORS.mailbox,
        flowGroup: 'mailbox',
      };
    }
    case 'iteration.started': {
      const idx = payload.index as number ?? 0;
      return {
        id: nextId(), kind: 'iteration:start', timestamp: Date.now(),
        source: 'leader', target: 'session',
        label: `Iteration ${idx}`,
        magnitude: idx,
        data: payload as Record<string, unknown>,
        color: NODE_COLORS.agent,
        flowGroup: 'iteration',
      };
    }
    case 'iteration.completed': {
      const idx = payload.index as number ?? 0;
      return {
        id: nextId(), kind: 'iteration:end', timestamp: Date.now(),
        source: 'leader', target: 'session',
        label: `Iteration ${idx} done`,
        magnitude: idx,
        data: payload as Record<string, unknown>,
        color: NODE_COLORS.session,
        flowGroup: 'iteration',
      };
    }
    case 'ctx.pct': {
      const tokens = payload.tokens as number ?? 0;
      return {
        id: nextId(), kind: 'agent:ctx', timestamp: Date.now(),
        source: 'leader', target: 'session',
        label: `ctx ${contextPctFromLoad(payload.load)}%`,
        magnitude: tokens,
        data: payload as Record<string, unknown>,
        color: NODE_COLORS.agent,
        flowGroup: 'leader',
      };
    }
    case 'error': {
      const msg = payload.message as string ?? 'Error';
      return {
        id: nextId(), kind: 'error', timestamp: Date.now(),
        source: payload.phase as string ?? 'system', target: 'session',
        label: msg,
        magnitude: 1,
        data: payload as Record<string, unknown>,
        color: NODE_COLORS.error,
        flowGroup: 'error',
      };
    }
    case 'context.compacted':
      return {
        id: nextId(), kind: 'context:compacted', timestamp: Date.now(),
        source: 'system', target: 'session',
        label: `Compacted: ${(payload.saved as number ?? 0).toLocaleString('en-US')} tokens`,
        magnitude: payload.saved as number ?? 0,
        data: payload as Record<string, unknown>,
        color: 'hsl(220, 60%, 50%)',
        flowGroup: 'context',
      };
    case 'compaction.failed': {
      const message = payload.message as string ?? 'Compaction failed';
      return {
        id: nextId(), kind: 'error', timestamp: Date.now(),
        source: 'compactor', target: 'session',
        label: message.slice(0, 80),
        magnitude: payload.tokens as number ?? 1,
        data: payload as Record<string, unknown>,
        color: NODE_COLORS.error,
        flowGroup: 'context',
      };
    }
    case 'context.repaired':
      return {
        id: nextId(), kind: 'context:repaired', timestamp: Date.now(),
        source: 'system', target: 'session',
        label: `Repaired: ${payload.removedMessages as number ?? 0} msgs`,
        magnitude: payload.removedMessages as number ?? 0,
        data: payload as Record<string, unknown>,
        color: 'hsl(220, 60%, 50%)',
        flowGroup: 'context',
      };
    case 'session.start': {
      const sid = payload.sessionId as string ?? '?';
      const proj = payload.projectName as string ?? '';
      return {
        id: nextId(), kind: 'session:start', timestamp: Date.now(),
        source: 'session', target: 'leader',
        label: proj || sid.slice(0, 12),
        magnitude: 1,
        data: payload as Record<string, unknown>,
        color: NODE_COLORS.session,
        flowGroup: 'session',
      };
    }
    case 'sessions.status_update': {
      // Convert the cross-process fleet snapshot into VizEvents that the
      // AgentFlowViz can render as session + agent nodes with live status.
      // We emit one fleet:snapshot event per tick; the renderer diffes it.
      const sessions = payload.sessions as Array<Record<string, unknown>> ?? [];
      return {
        id: nextId(), kind: 'fleet:snapshot', timestamp: Date.now(),
        source: 'system', target: 'session',
        label: `${sessions.length} session(s)`,
        magnitude: sessions.length,
        data: payload as Record<string, unknown>,
        color: NODE_COLORS.system,
        flowGroup: 'fleet',
      };
    }
    default:
      return null;
  }
}
