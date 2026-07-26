import type { EventBus } from '../kernel/events.js';
import type { PhaseGraph } from './types.js';

export function normalizePhaseGraphForResume(graph: PhaseGraph): void {
  graph.activePhaseIds = [];
  for (const phase of graph.phases.values()) {
    if (phase.status === 'running') {
      phase.status = 'pending';
      phase.updatedAt = Date.now();
    }
    if (phase.status === 'pending') {
      for (const task of phase.taskGraph.nodes.values()) {
        if (task.status === 'in_progress') task.status = 'pending';
      }
    }
  }
}

export function createNoopEventBus(): EventBus {
  return {
    emit: () => {},
    on: () => () => {},
    off: () => {},
    once: () => () => {},
    listeners: new Map(),
    wildcards: [],
    setLogger: () => {},
    onAny: () => () => {},
    offAny: () => {},
    emitAsync: async () => [],
    waitFor: async () => {},
  } as never as EventBus;
}
