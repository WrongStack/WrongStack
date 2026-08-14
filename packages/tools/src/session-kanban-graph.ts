import type { TodoItem } from '@wrongstack/core/agent';
import type { PlanItem } from '@wrongstack/core/storage';
import type { SerializedTaskGraph, TaskStatus } from '@wrongstack/core/types';
import type { TaskItem } from '@wrongstack/core/utils';

export const PLAN_STATUS_TO_TASK: Record<PlanItem['status'], TaskStatus> = {
  open: 'pending',
  in_progress: 'in_progress',
  done: 'completed',
};

export function todoListToSerializedGraph(
  todos: readonly TodoItem[],
  sessionId: string,
): SerializedTaskGraph {
  const graphId = `todo:${sessionId}`;
  const nodes = todos.map((todo, index) => ({
    id: todo.id,
    title: todo.content,
    description: todo.activeForm ?? '',
    type: 'chore' as const,
    priority: 'medium' as const,
    status: todo.status,
    specRequirementId: `${graphId}:${todo.id}`,
    createdAt: index,
    updatedAt: index,
  }));
  return {
    id: graphId,
    specId: graphId,
    requiredRequirementIds: nodes.map((node) => node.specRequirementId),
    title: 'Session todos',
    nodes,
    edges: [],
    rootNodes: nodes.map((node) => node.id),
    createdAt: 0,
    updatedAt: 0,
  };
}

export function taskFileToSerializedGraph(
  tasks: readonly TaskItem[],
  sessionId: string,
): SerializedTaskGraph {
  const graphId = `session:${sessionId}`;
  const ids = new Set(tasks.map((task) => task.id));
  const nodes = tasks.map((task, index) => ({
    id: task.id,
    title: task.title,
    description: task.description ?? '',
    type: task.type,
    priority: task.priority,
    status: task.status,
    specRequirementId: `${graphId}:${task.id}`,
    ...(task.assignee ? { assignee: task.assignee } : {}),
    ...(task.estimateHours !== undefined ? { estimateHours: task.estimateHours } : {}),
    createdAt: index,
    updatedAt: index,
  }));
  const edges = tasks.flatMap((task) =>
    (task.dependsOn ?? [])
      .filter((dependency) => ids.has(dependency))
      .map((dependency) => ({
        id: `${dependency}->${task.id}`,
        from: dependency,
        to: task.id,
        type: 'depends_on' as const,
      })),
  );
  const hasIncoming = new Set(edges.map((edge) => edge.to));
  const rootNodes = nodes.filter((node) => !hasIncoming.has(node.id)).map((node) => node.id);
  return {
    // Keep the historical graph id so existing mirrored task cards are reused.
    id: graphId,
    specId: graphId,
    requiredRequirementIds: nodes.map((node) => node.specRequirementId),
    title: 'Session tasks',
    nodes,
    edges,
    rootNodes: rootNodes.length ? rootNodes : nodes[0] ? [nodes[0].id] : [],
    createdAt: 0,
    updatedAt: 0,
  };
}

export function planFileToSerializedGraph(
  items: readonly PlanItem[],
  sessionId: string,
): SerializedTaskGraph {
  const graphId = `plan:${sessionId}`;
  const nodes = items.map((item, index) => ({
    id: item.id,
    title: item.title,
    description: item.details ?? '',
    type: 'chore' as const,
    priority: 'medium' as const,
    status: PLAN_STATUS_TO_TASK[item.status],
    specRequirementId: `${graphId}:${item.id}`,
    createdAt: index,
    updatedAt: index,
  }));
  return {
    id: graphId,
    specId: graphId,
    requiredRequirementIds: nodes.map((node) => node.specRequirementId),
    title: 'Session plan',
    nodes,
    edges: [],
    rootNodes: nodes.map((node) => node.id),
    createdAt: 0,
    updatedAt: 0,
  };
}
