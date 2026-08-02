import { randomUUID } from 'node:crypto';
import type { AssignKanbanTaskInput, KanbanAgentAssignment } from '@wrongstack/kanban';
import { clampSubagentCapabilities } from '@wrongstack/core/security';
import type { KanbanToolInput } from './kanban-tool-types.js';

export function taskInput(input: KanbanToolInput) {
  const assignment = hasAssignmentInput(input) ? assignmentForTaskCreate(input) : undefined;
  return {
    title: input.title ?? '',
    columnId: input.columnId,
    description: input.description,
    dueDate: input.dueDate,
    priority: input.priority,
    ...(input.taskType !== undefined ? { type: input.taskType } : {}),
    status: input.status,
    labels: input.labels,
    ...((assignment?.agentId ?? assignment?.role ?? assignment?.name)
      ? { assignedAgent: assignment.agentId ?? assignment.role ?? assignment.name }
      : {}),
    ...((input.assignee ?? assignment?.name ?? assignment?.agentId)
      ? { assignee: input.assignee ?? assignment?.name ?? assignment?.agentId }
      : {}),
    ...(mergedDependsOn(input) ? { dependsOn: mergedDependsOn(input) } : {}),
    ...(input.estimatedHours !== undefined ? { estimatedHours: input.estimatedHours } : {}),
    ...(input.actualHours !== undefined ? { actualHours: input.actualHours } : {}),
    ...(assignment ? { assignment } : {}),
    ...(input.order !== undefined ? { order: input.order } : {}),
    ...(input.retryPolicy !== undefined ? { retryPolicy: input.retryPolicy } : {}),
    ...(input.costCeilingUsd !== undefined ? { costCeilingUsd: input.costCeilingUsd } : {}),
    ...(input.childTitles !== undefined ? { childTaskIds: input.childTitles } : {}),
    ...(input.checkDescription !== undefined
      ? {
          successCriteria: [
            {
              id: randomUUID(),
              description: input.checkDescription,
              type: 'manual' as const,
              status: input.checkStatus ?? ('pending' as const),
            },
          ],
        }
      : {}),
    ...(input.metricName !== undefined
      ? {
          goalMetrics: [
            {
              id: randomUUID(),
              name: input.metricName,
              status: input.metricStatus ?? ('pending' as const),
              ...(input.metricTarget !== undefined ? { target: input.metricTarget } : {}),
              ...(input.metricCurrent !== undefined ? { current: input.metricCurrent } : {}),
              ...(input.metricUnit !== undefined ? { unit: input.metricUnit } : {}),
              ...(input.metricNotes !== undefined ? { notes: input.metricNotes } : {}),
            },
          ],
        }
      : {}),
    ...(input.url !== undefined
      ? {
          links: [
            {
              url: input.url,
              type: input.linkType ?? ('url' as const),
              ...(input.linkTitle !== undefined ? { title: input.linkTitle } : {}),
            },
          ],
        }
      : {}),
    ...(input.note !== undefined
      ? {
          notes: [
            {
              id: randomUUID(),
              author: input.author ?? 'agent',
              content: input.note,
              createdAt: new Date().toISOString(),
            },
          ],
        }
      : {}),
    ...(input.graphId !== undefined
      ? {
          origin: {
            system: input.sourceSystem ?? 'kanban-tool',
            ...(input.graphId !== undefined ? { graphId: input.graphId } : {}),
            ...(input.specId !== undefined ? { specId: input.specId } : {}),
            ...(input.phaseId !== undefined ? { phaseId: input.phaseId } : {}),
          },
        }
      : {}),
  };
}

/** Union of the single `dependencyTaskId` and the multi `dependsOn[]` inputs. */
export function mergedDependsOn(input: KanbanToolInput): string[] | undefined {
  const ids = [
    ...(input.dependsOn ?? []),
    ...(input.dependencyTaskId !== undefined ? [input.dependencyTaskId] : []),
  ].filter((id, i, arr) => id && arr.indexOf(id) === i);
  return ids.length > 0 ? ids : undefined;
}

export function taskPatch(input: KanbanToolInput) {
  return {
    title: input.title,
    description: input.description,
    dueDate: input.dueDate,
    columnId: input.columnId,
    order: input.order,
    priority: input.priority,
    ...(input.taskType !== undefined ? { type: input.taskType } : {}),
    status: input.status,
    labels: input.labels,
    assignedAgent: input.agentId,
    ...(mergedDependsOn(input) ? { dependsOn: mergedDependsOn(input) } : {}),
    ...(input.estimatedHours !== undefined ? { estimatedHours: input.estimatedHours } : {}),
    ...(input.actualHours !== undefined ? { actualHours: input.actualHours } : {}),
  };
}

/**
 * `allowedCapabilities` reaches here straight off a tool schema that declares it
 * as an un-enum'd `string[]`, so its contents are model output. That is an
 * untrusted source and must not be able to widen a grant past the wide-subagent
 * ceiling — the more so because an assignment PERSISTS onto the board, turning
 * one injected call into a standing grant that a later user-initiated dispatch
 * carries silently (WS-079).
 */
function clampRequestedCapabilities(
  requested: readonly string[] | undefined,
): string[] | undefined {
  if (requested === undefined) return undefined;
  return clampSubagentCapabilities(requested).granted;
}

export function assignmentInput(input: KanbanToolInput): AssignKanbanTaskInput {
  return {
    agentId: input.agentId,
    name: input.name,
    role: input.role,
    provider: input.provider,
    model: input.model,
    fallbackProfile: input.fallbackProfile,
    fallbackModels: input.fallbackModels,
    tools: input.tools,
    allowedCapabilities: clampRequestedCapabilities(input.allowedCapabilities),
    assignee: input.assignee,
    leaseId: input.leaseId,
    claimedAt: input.claimedAt,
    heartbeatAt: input.heartbeatAt,
    leaseExpiresAt: input.leaseExpiresAt,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    costCeilingUsd: input.costCeilingUsd,
    retryPolicy: input.retryPolicy,
    lastFailureKind: input.lastFailureKind,
  };
}

function hasAssignmentInput(input: KanbanToolInput): boolean {
  return (
    input.agentId !== undefined ||
    input.name !== undefined ||
    input.role !== undefined ||
    input.provider !== undefined ||
    input.model !== undefined ||
    input.fallbackProfile !== undefined ||
    input.fallbackModels !== undefined ||
    input.tools !== undefined ||
    input.allowedCapabilities !== undefined ||
    input.assignee !== undefined ||
    input.leaseId !== undefined ||
    input.claimedAt !== undefined ||
    input.heartbeatAt !== undefined ||
    input.leaseExpiresAt !== undefined ||
    input.attempt !== undefined ||
    input.maxAttempts !== undefined ||
    input.costCeilingUsd !== undefined ||
    input.retryPolicy !== undefined ||
    input.lastFailureKind !== undefined ||
    input.assignmentStatus !== undefined
  );
}

function assignmentForTaskCreate(input: KanbanToolInput): KanbanAgentAssignment {
  return {
    status: input.assignmentStatus ?? 'assigned',
    ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.role !== undefined ? { role: input.role } : {}),
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.fallbackProfile !== undefined ? { fallbackProfile: input.fallbackProfile } : {}),
    ...(input.fallbackModels !== undefined ? { fallbackModels: input.fallbackModels } : {}),
    ...(input.tools !== undefined ? { tools: input.tools } : {}),
    ...(input.allowedCapabilities !== undefined
      ? { allowedCapabilities: clampRequestedCapabilities(input.allowedCapabilities) }
      : {}),
    ...(input.leaseId !== undefined ? { leaseId: input.leaseId } : {}),
    ...(input.claimedAt !== undefined ? { claimedAt: input.claimedAt } : {}),
    ...(input.heartbeatAt !== undefined ? { heartbeatAt: input.heartbeatAt } : {}),
    ...(input.leaseExpiresAt !== undefined ? { leaseExpiresAt: input.leaseExpiresAt } : {}),
    ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
    ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
    ...(input.costCeilingUsd !== undefined ? { costCeilingUsd: input.costCeilingUsd } : {}),
    ...(input.retryPolicy !== undefined ? { retryPolicy: input.retryPolicy } : {}),
    ...(input.lastFailureKind !== undefined ? { lastFailureKind: input.lastFailureKind } : {}),
  };
}
