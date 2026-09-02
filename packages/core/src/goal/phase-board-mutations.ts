import type { TaskTracker } from '../tasking/index.js';
import type { TaskNode } from '../types/task-graph.js';
import type { PhaseGraph, PhaseNode, PhaseStatus } from './types.js';

type PhaseBoardEmit =
  | {
      event: 'phase.taskMoved';
      payload: { taskId: string; fromPhaseId: string; toPhaseId: string };
    }
  | {
      event: 'phase.taskAssigned';
      payload: { phaseId: string; taskId: string; agentId?: string; agentName?: string };
    }
  | {
      event: 'phase.taskAdded';
      payload: { phaseId: string; taskId: string; taskTitle: string };
    };

export interface PhaseBoardMutationContext {
  graph: PhaseGraph;
  trackerCache: Map<string, TaskTracker>;
  taskRetryCounts: Map<string, number>;
  phaseWorktrees: Map<string, unknown>;
  getTrackerForPhase: (phase: PhaseNode) => TaskTracker;
  updatePhaseStatus: (phase: PhaseNode, status: PhaseStatus) => void;
  emit: (event: PhaseBoardEmit['event'], payload: PhaseBoardEmit['payload']) => void;
}

export function findPhaseOfTaskInGraph(graph: PhaseGraph, taskId: string): PhaseNode | undefined {
  for (const phase of graph.phases.values()) {
    if (phase.taskGraph.nodes.has(taskId)) return phase;
  }
  return undefined;
}

export function movePhaseTask(
  ctx: PhaseBoardMutationContext,
  taskId: string,
  toPhaseId: string,
): boolean {
  const from = findPhaseOfTaskInGraph(ctx.graph, taskId);
  const to = ctx.graph.phases.get(toPhaseId);
  if (!from || !to || from.id === toPhaseId) return false;

  const node = from.taskGraph.nodes.get(taskId);
  if (!node) return false;

  const dependents = from.taskGraph.edges.filter((e) => e.from === taskId).map((e) => e.to);
  for (const depId of dependents) {
    const depNode = from.taskGraph.nodes.get(depId);
    if (depNode) {
      depNode.parentId = undefined;
      depNode.children = undefined;
    }
    from.taskGraph.edges = from.taskGraph.edges.filter(
      (e) => !(e.from === taskId && e.to === depId),
    );
    if (!from.taskGraph.rootNodes.includes(depId)) {
      from.taskGraph.rootNodes.push(depId);
    }
  }

  from.taskGraph.nodes.delete(taskId);
  from.taskGraph.rootNodes = from.taskGraph.rootNodes.filter((id) => id !== taskId);
  from.taskGraph.edges = from.taskGraph.edges.filter((e) => e.from !== taskId && e.to !== taskId);
  from.taskGraph.updatedAt = Date.now();

  node.parentId = undefined;
  node.children = undefined;
  node.updatedAt = Date.now();
  to.taskGraph.nodes.set(taskId, node);
  to.taskGraph.rootNodes.push(taskId);
  to.taskGraph.updatedAt = Date.now();

  ctx.trackerCache.delete(from.id);
  ctx.trackerCache.delete(to.id);
  ctx.graph.updatedAt = Date.now();
  ctx.emit('phase.taskMoved', { taskId, fromPhaseId: from.id, toPhaseId });
  return true;
}

export function setPhaseTaskAssignee(
  ctx: PhaseBoardMutationContext,
  taskId: string,
  agentId?: string,
  agentName?: string,
): boolean {
  const phase = findPhaseOfTaskInGraph(ctx.graph, taskId);
  if (!phase) return false;
  const tracker = ctx.getTrackerForPhase(phase);
  tracker.updateNode(taskId, { assignee: agentName ?? agentId ?? '' });
  ctx.graph.updatedAt = Date.now();
  ctx.emit('phase.taskAssigned', {
    phaseId: phase.id,
    taskId,
    ...(agentId !== undefined ? { agentId } : {}),
    ...(agentName !== undefined ? { agentName } : {}),
  });
  return true;
}

export function addPhaseTask(
  ctx: PhaseBoardMutationContext,
  phaseId: string,
  spec: {
    title: string;
    description?: string | undefined;
    type?: TaskNode['type'] | undefined;
    priority?: TaskNode['priority'] | undefined;
  },
): string | null {
  const phase = ctx.graph.phases.get(phaseId);
  if (!phase) return null;
  const tracker = ctx.getTrackerForPhase(phase);
  const node = tracker.addNode({
    title: spec.title,
    description: spec.description ?? '',
    type: spec.type ?? 'feature',
    priority: spec.priority ?? 'medium',
    status: 'pending',
  });
  ctx.graph.updatedAt = Date.now();
  ctx.emit('phase.taskAdded', { phaseId, taskId: node.id, taskTitle: node.title });
  return node.id;
}

export function requeuePhaseTask(ctx: PhaseBoardMutationContext, taskId: string): boolean {
  const phase = findPhaseOfTaskInGraph(ctx.graph, taskId);
  if (!phase) return false;
  const tracker = ctx.getTrackerForPhase(phase);
  tracker.updateNodeStatus(taskId, 'pending');
  ctx.taskRetryCounts.delete(`${phase.id}:${taskId}`);
  if (phase.status === 'completed' || phase.status === 'failed' || phase.status === 'paused') {
    ctx.graph.failedPhaseIds = ctx.graph.failedPhaseIds.filter((id) => id !== phase.id);
    ctx.graph.completedPhaseIds = ctx.graph.completedPhaseIds.filter((id) => id !== phase.id);
    ctx.graph.activePhaseIds = ctx.graph.activePhaseIds.filter((id) => id !== phase.id);
    ctx.phaseWorktrees.delete(phase.id);
    ctx.updatePhaseStatus(phase, 'pending');
  }
  ctx.graph.updatedAt = Date.now();
  return true;
}
