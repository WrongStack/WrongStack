import type { KanbanToolInput } from './kanban-tool-types.js';

export function boardCreateInput(input: KanbanToolInput, title: string) {
  return {
    title,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.tags !== undefined ? { tags: input.tags } : {}),
    ...(input.generatedBy !== undefined ? { generatedBy: input.generatedBy } : {}),
    ...(input.atomicityMode !== undefined
      ? {
          atomicity: {
            mode: input.atomicityMode,
            decomposition: input.atomicityDecomposition ?? 'propose',
          },
        }
      : {}),
    ...(input.gateEnforcement !== undefined
      ? { completionGate: { enforcement: input.gateEnforcement } }
      : {}),
  };
}

export function boardUpdatePatch(input: KanbanToolInput) {
  return {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.tags !== undefined ? { tags: input.tags } : {}),
    ...(input.atomicityMode !== undefined
      ? {
          atomicity: {
            mode: input.atomicityMode,
            decomposition: input.atomicityDecomposition ?? 'propose',
          },
        }
      : {}),
    ...(input.gateEnforcement !== undefined
      ? { completionGate: { enforcement: input.gateEnforcement } }
      : {}),
  };
}

export function duplicateBoardOptions(input: KanbanToolInput) {
  return {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.generatedBy !== undefined ? { generatedBy: input.generatedBy } : {}),
    ...(input.includeTasks !== undefined ? { includeTasks: input.includeTasks } : {}),
    ...(input.includeCompletedTasks !== undefined
      ? { includeCompletedTasks: input.includeCompletedTasks }
      : {}),
    ...(input.preserveAssignment !== undefined ? { preserveAssignment: input.preserveAssignment } : {}),
  };
}
