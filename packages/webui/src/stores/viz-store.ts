/**
 * VizStore — Real-time cinematic event stream for the AgentFlow visualization.
 *
 * Holds a ring buffer of structured events from the entire agent ecosystem:
 * provider calls, agent spawns, tool executions, mailbox messages, etc.
 * Every event is typed with a `vizKind` for the renderer to pattern-match on.
 */

import { create } from 'zustand';
import { applyEventToGraph, nextId } from './viz-graph-helpers.js';
import { EDGE_COLORS, type VizEdge, type VizNode, type VizState } from './viz-types.js';

export { wsToVizEvent } from './viz-pipeline.js';
export * from './viz-types.js';

// ── Store ─────────────────────────────────────────────────────────────

export const useVizStore = create<VizState>()((set, _get) => ({
  events: [],
  toolEvents: [],
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

  pushEvent: (event) =>
    set((state) => {
      const normalizedEvent = {
        ...event,
        id: event.id ?? nextId(),
        timestamp: event.timestamp || Date.now(),
      };
      const events = [normalizedEvent, ...state.events];
      if (events.length > state.maxEvents) events.length = state.maxEvents;
      const isToolEvent =
        event.kind === 'agent:tool' ||
        event.kind === 'tool:started' ||
        event.kind === 'tool:progress' ||
        event.kind === 'tool:executed';
      const toolEvents = isToolEvent
        ? [normalizedEvent, ...state.toolEvents].slice(0, 600)
        : state.toolEvents;

      const now = Date.now();
      const { nodes, edges } = applyEventToGraph(state, event, now);

      return { events, toolEvents, nodes, edges };
    }),

  upsertNode: (partial) =>
    set((state) => {
      const nodes = new Map(state.nodes);
      const existing = nodes.get(partial.id);
      nodes.set(partial.id, {
        ...existing,
        ...partial,
        lastSeenAt: partial.lastSeenAt !== undefined ? partial.lastSeenAt : Date.now(),
      } as VizNode);
      return { nodes };
    }),

  removeNode: (id) =>
    set((state) => {
      const nodes = new Map(state.nodes);
      nodes.delete(id);
      const edges = new Map(state.edges);
      for (const [eid, edge] of edges) {
        if (edge.source === id || edge.target === id) edges.delete(eid);
      }
      return { nodes, edges };
    }),

  upsertEdge: (partial) =>
    set((state) => {
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

  removeEdge: (id) =>
    set((state) => {
      const edges = new Map(state.edges);
      edges.delete(id);
      return { edges };
    }),

  clear: () =>
    set({
      events: [],
      toolEvents: [],
      nodes: new Map(),
      edges: new Map(),
      counters: {
        totalTokens: 0,
        totalCost: 0,
        totalToolCalls: 0,
        activeAgents: 0,
        completedTasks: 0,
        errors: 0,
        mailboxMessages: 0,
      },
    }),

  setActive: (active) => set({ isActive: active }),

  decayActivity: () =>
    set((state) => {
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
          const decayed = edge.intensity * 0.9;
          edges.set(id, { ...edge, intensity: decayed < 0.01 ? 0 : decayed });
        }
      }
      return { nodes, edges };
    }),

  prunesStale: (olderThan) =>
    set((state) => {
      const cutoff = Date.now() - olderThan;
      const nodes = new Map(state.nodes);
      for (const [id, node] of nodes) {
        if (node.lastSeenAt < cutoff) nodes.delete(id);
      }
      const edges = new Map(state.edges);
      for (const [id, edge] of edges) {
        if (edge.lastActiveAt < cutoff) edges.delete(id);
      }
      const events = state.events.filter((e) => e.timestamp > cutoff);
      return { nodes, edges, events };
    }),
}));
