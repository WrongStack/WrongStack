import { randomUUID } from 'node:crypto';
import { clampSubagentCapabilities } from '@wrongstack/core/security';
import type { AssignKanbanTaskInput, KanbanAgentAssignment } from '@wrongstack/kanban';
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
    // The system prompt has always told the model it may "set atomic: true"
    // when creating a composite parent. It could not: the field reached
    // neither the create input nor the patch, so the instruction described a
    // capability that did not exist and the attempt was silently dropped.
    ...(input.atomic !== undefined ? { atomic: input.atomic } : {}),
    ...(input.childTitles !== undefined ? { childTaskIds: input.childTitles } : {}),
    ...(input.checkDescription !== undefined
      ? {
          successCriteria: [
            {
              id: randomUUID(),
              description: input.checkDescription,
              // `manual` only as the fallback. Hard-coding it here meant every
              // agent-authored criterion was unverifiable by construction: the
              // deterministic plugins never matched, the registry passed the
              // hand-set status straight through, and "verified" collapsed into
              // "the author ticked its own box".
              type: input.checkType ?? ('manual' as const),
              status: input.checkStatus ?? ('pending' as const),
              ...(input.checkNotes !== undefined ? { notes: input.checkNotes } : {}),
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
              ...(input.metricDirection !== undefined
                ? { direction: input.metricDirection }
                : {}),
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
    ...([input.graphId, input.specId, input.specRequirementId].some((value) => value !== undefined)
      ? {
          origin: {
            system: input.sourceSystem ?? 'kanban-tool',
            ...(input.graphId !== undefined ? { graphId: input.graphId } : {}),
            ...(input.specId !== undefined ? { specId: input.specId } : {}),
            ...(input.specRequirementId !== undefined
              ? { specRequirementId: input.specRequirementId }
              : {}),
            ...(input.phaseId !== undefined ? { phaseId: input.phaseId } : {}),
          },
        }
      : {}),
  };
}

/**
 * Union of the single `dependencyTaskId` and the multi `dependsOn[]` inputs.
 *
 * Returns `undefined` only when neither was supplied, so an explicit
 * `dependsOn: []` CLEARS the list instead of being silently ignored. It used to
 * collapse empty to `undefined`, which meant a dependency added by mistake
 * could never be taken back from the tool surface: `dependency-incomplete`
 * then held the card out of Running for good, and the only escapes were
 * finishing work nobody wanted or deleting the blocking card outright.
 */
export function mergedDependsOn(input: KanbanToolInput): string[] | undefined {
  if (input.dependsOn === undefined && input.dependencyTaskId === undefined) return undefined;
  return [
    ...(input.dependsOn ?? []),
    ...(input.dependencyTaskId !== undefined ? [input.dependencyTaskId] : []),
  ].filter((id, i, arr) => id && arr.indexOf(id) === i);
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
    ...(mergedDependsOn(input) !== undefined ? { dependsOn: mergedDependsOn(input) } : {}),
    // `atomic` and `childTaskIds` are the composite-parent contract, and the
    // managed gate reads both: an `atomic` parent may not move forward without
    // children, and may not reach Done until every child is completed. The
    // manager has always accepted both on a patch; only this surface withheld
    // them, so `split_atomic` was a one-way door — delete the children and the
    // parent was stranded with no way to declare itself a leaf again.
    ...(input.atomic !== undefined ? { atomic: input.atomic } : {}),
    ...(input.childTaskIds !== undefined ? { childTaskIds: input.childTaskIds } : {}),
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
