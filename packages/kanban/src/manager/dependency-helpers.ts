import type { KanbanBoard, KanbanTask } from '../types.js';

export function remapTaskReferences(
  cloned: KanbanTask,
  original: KanbanTask,
  idMap: Map<string, string>,
): void {
  cloned.dependsOn = remapIdList(original.dependsOn, idMap);
  if (!cloned.dependsOn?.length) delete cloned.dependsOn;
  if (original.parentTaskId !== undefined) {
    const parentTaskId = idMap.get(original.parentTaskId);
    if (parentTaskId) cloned.parentTaskId = parentTaskId;
    else delete cloned.parentTaskId;
  }
  cloned.childTaskIds = remapIdList(original.childTaskIds, idMap);
  if (!cloned.childTaskIds?.length) delete cloned.childTaskIds;
  if (original.mergedIntoTaskId !== undefined) {
    const mergedIntoTaskId = idMap.get(original.mergedIntoTaskId);
    if (mergedIntoTaskId) cloned.mergedIntoTaskId = mergedIntoTaskId;
    else delete cloned.mergedIntoTaskId;
  }
  cloned.mergedFromTaskIds = remapIdList(original.mergedFromTaskIds, idMap);
  if (!cloned.mergedFromTaskIds?.length) delete cloned.mergedFromTaskIds;
  if (original.chain !== undefined) {
    cloned.chain = {
      chainId: original.chain.chainId,
      order: original.chain.order,
      ...(original.chain.previousTaskId && idMap.get(original.chain.previousTaskId)
        ? { previousTaskId: idMap.get(original.chain.previousTaskId) }
        : {}),
      ...(original.chain.nextTaskId && idMap.get(original.chain.nextTaskId)
        ? { nextTaskId: idMap.get(original.chain.nextTaskId) }
        : {}),
    };
  }
}

export function remapIdList(
  ids: string[] | undefined,
  idMap: Map<string, string>,
): string[] | undefined {
  const remapped = (ids ?? []).map((id) => idMap.get(id)).filter((id): id is string => Boolean(id));
  return remapped.length ? remapped : undefined;
}

export function hasDependencyPath(
  board: KanbanBoard,
  fromTaskId: string,
  toTaskId: string,
  seen = new Set<string>(),
): boolean {
  if (fromTaskId === toTaskId) return true;
  if (seen.has(fromTaskId)) return false;
  seen.add(fromTaskId);
  const task = board.tasks.find((candidate) => candidate.id === fromTaskId);
  if (!task?.dependsOn?.length) return false;
  return task.dependsOn.some((depId) => hasDependencyPath(board, depId, toTaskId, seen));
}

export function assertNoDependencyCycles(board: KanbanBoard): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string): void => {
    if (visited.has(taskId)) return;
    if (visiting.has(taskId)) throw new Error(`Kanban dependency cycle detected at ${taskId}.`);
    visiting.add(taskId);
    const task = board.tasks.find((candidate) => candidate.id === taskId);
    for (const depId of task?.dependsOn ?? []) {
      if (depId === taskId) throw new Error('A kanban task cannot depend on itself.');
      visit(depId);
    }
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const task of board.tasks) visit(task.id);
}
