import { mutateBoard } from '../../storage.js';
import type {
  KanbanBoard,
  KanbanLifecycleStage,
  KanbanLifecycleTransition,
  KanbanTask,
} from '../../types.js';
import type {
  KanbanLifecycleValidationIssue,
  KanbanTaskTransitionCheckInput,
  KanbanTaskTransitionInput,
  KanbanTaskTransitionResult,
} from '../../types-operations.js';
import {
  clearGateRefusals,
  isBudgetedRefusal,
  recordCompletionRefusal,
} from '../../verification/completion-park.js';
import { applyTaskPatch, findTask, nowIso } from '../_internal.js';
import { KanbanLifecycleError } from '../lifecycle-error.js';
import { dependencyIncompleteMessage, getDependencyReadinessIssues } from '../task-readiness.js';
import {
  hasText,
  requireDetail,
  validateDoneEvidence,
  validateTickChecks,
} from './definition-of-done.js';
import {
  currentManagedStage,
  isManagedTombstone,
  KANBAN_AGENT_STAGES,
  STATUS_BY_STAGE,
  validateManagedLifecyclePolicy,
} from './stage-helpers.js';

export function validateManagedTaskTransition(
  board: KanbanBoard,
  task: KanbanTask,
  input: KanbanTaskTransitionCheckInput,
): KanbanLifecycleValidationIssue[] {
  const issues = validateManagedLifecyclePolicy(board);
  if (board.lifecycle?.mode !== 'managed') {
    return [
      {
        code: 'managed-policy-invalid',
        field: 'lifecycle.mode',
        message: 'Strict Kanban Agent transitions require a managed board.',
      },
    ];
  }
  if (issues.length) return issues;
  if (isManagedTombstone(board, task)) {
    return [
      {
        code: 'transition-skipped',
        field: 'status',
        message: `Card ${task.id} is archived and cannot transition; it left the board for good.`,
      },
    ];
  }

  let from: KanbanLifecycleStage;
  try {
    from = currentManagedStage(board, task);
  } catch (error) {
    if (error instanceof KanbanLifecycleError) return [...error.issues];
    throw error;
  }
  const fromIndex = KANBAN_AGENT_STAGES.indexOf(from);
  const toIndex = KANBAN_AGENT_STAGES.indexOf(input.to);
  if (toIndex === -1) {
    issues.push({
      code: 'transition-skipped',
      field: 'to',
      message: `Unknown lifecycle stage "${input.to}". Valid stages: ${KANBAN_AGENT_STAGES.join(', ')}.`,
    });
  } else if (from === 'done' || Math.abs(toIndex - fromIndex) !== 1) {
    issues.push({
      code: 'transition-skipped',
      message: `Managed cards must move exactly one stage at a time; ${from} -> ${input.to} is not allowed.`,
    });
  }
  if (!hasText(input.actor)) {
    issues.push({
      code: 'task-detail-missing',
      field: 'actor',
      message: 'Transition actor is required.',
    });
  }
  if (!hasText(input.comment)) {
    issues.push({
      code: 'task-detail-missing',
      field: 'comment',
      message: 'Every managed transition requires a truthful progress comment.',
    });
  }

  if (toIndex > fromIndex) {
    validateRequiredCardDetails(task, issues);
    if (input.to === 'review') validateReviewEvidence(task, issues);
    if (input.to === 'done') {
      validateDoneEvidence(board, task, input, issues);
      validateParentChildGate(board, task, issues);
    }
    validateDestinationWipLimit(board, task, input.to, issues);
  }
  if (input.to === 'running') {
    validateRunningOwnership(task, issues);
    validateRunningDependencies(board, task, issues);
  }
  return issues;
}

function validateDestinationWipLimit(
  board: KanbanBoard,
  task: KanbanTask,
  to: KanbanLifecycleStage,
  issues: KanbanLifecycleValidationIssue[],
): void {
  if (!board.lifecycle?.mode || board.lifecycle.mode !== 'managed') return;
  const columnId = board.lifecycle.columns[to];
  if (!columnId) return;
  const column = board.columns.find((c) => c.id === columnId);
  if (!column) return;
  const limit = column.wipLimit ?? 0;
  if (limit <= 0) return;
  const occupants = board.tasks.filter((t) => t.columnId === columnId && t.id !== task.id).length;
  if (occupants >= limit) {
    issues.push({
      code: 'wip-limit-exceeded',
      field: 'columnId',
      message: `Column "${column.title}" is at its WIP limit (${occupants}/${limit}). Complete or move a card out before adding more.`,
    });
  }
}

function validateRunningDependencies(
  board: KanbanBoard,
  task: KanbanTask,
  issues: KanbanLifecycleValidationIssue[],
): void {
  const dependencyIssues = getDependencyReadinessIssues(board, task);
  if (!dependencyIssues.length) return;
  issues.push({
    code: 'dependency-incomplete',
    field: 'dependsOn',
    message: dependencyIncompleteMessage(dependencyIssues),
  });
}

function validateParentChildGate(
  board: KanbanBoard,
  task: KanbanTask,
  issues: KanbanLifecycleValidationIssue[],
): void {
  if (!task.childTaskIds?.length) return;
  const incompleteChildren = task.childTaskIds
    .map((childId) => findTask(board, childId))
    .filter((child): child is KanbanTask => Boolean(child))
    .filter((child) => child.status !== 'completed');
  if (incompleteChildren.length) {
    issues.push({
      code: 'parent-child-incomplete',
      field: 'childTaskIds',
      message:
        `Parent task cannot reach Done: ${incompleteChildren.length} child task(s) are not ` +
        `completed (${incompleteChildren.map((c) => c.id.slice(0, 8)).join(', ')}). ` +
        'Finish them, or — if a child is no longer part of this work — call kanban ' +
        'update_task on the parent with the corrected `childTaskIds`; setting `atomic: false` ' +
        'with an empty `childTaskIds` turns the parent back into an executable leaf.',
    });
  }
}

export async function transitionTask(
  projectRoot: string,
  boardId: string,
  taskId: string,
  input: KanbanTaskTransitionInput,
): Promise<KanbanTaskTransitionResult | null> {
  try {
    return await runTaskTransition(projectRoot, boardId, taskId, input);
  } catch (error) {
    if (
      input.to === 'done' &&
      error instanceof KanbanLifecycleError &&
      isBudgetedRefusal(error.issues)
    ) {
      await recordCompletionRefusal(projectRoot, boardId, taskId, {
        reason: error.issues[0]?.message ?? 'Done transition refused.',
        issues: error.issues.map((issue) => issue.message),
        eventContext: { sessionId: input.sessionId, actor: input.actor },
      }).catch(() => undefined);
    }
    throw error;
  }
}

export const transitionManagedTask = transitionTask;

async function runTaskTransition(
  projectRoot: string,
  boardId: string,
  taskId: string,
  input: KanbanTaskTransitionInput,
): Promise<KanbanTaskTransitionResult | null> {
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    if (!task) return null;
    if (input.patch) {
      const raw = input.patch as Record<string, unknown>;
      const forbidden = ['columnId', 'status', 'lifecycle'].filter((key) => raw[key] !== undefined);
      if (forbidden.length > 0) {
        const issues: KanbanLifecycleValidationIssue[] = [
          {
            code: 'transition-skipped',
            field: forbidden[0] as string,
            message:
              `Transition patch may not set ${forbidden.join(', ')} — ` +
              'the transition writes column, status, and the audit ledger atomically.',
          },
        ];
        throw new KanbanLifecycleError(issues[0]!.message, issues);
      }
      applyTaskPatch(board, task, input.patch);
    }
    if (input.tickChecks?.length) {
      const tickIssues = validateTickChecks(task, input.tickChecks);
      if (tickIssues.length > 0) {
        throw new KanbanLifecycleError(tickIssues[0]!.message, tickIssues);
      }
      const at = nowIso();
      task.successCriteria = (task.successCriteria ?? []).map((existing) => {
        const tick = input.tickChecks!.find((entry) => entry.checkId === existing.id);
        if (!tick || existing.type !== 'manual') return existing;
        return {
          ...existing,
          status: tick.checkStatus,
          checkedAt: at,
          checkedBy: 'agent',
        };
      });
    }
    const issues = validateManagedTaskTransition(board, task, input);
    if (issues.length) throw new KanbanLifecycleError(issues[0]!.message, issues);

    const from = currentManagedStage(board, task);
    const at = nowIso();
    const transition: KanbanLifecycleTransition = {
      from,
      to: input.to,
      at,
      actor: input.actor.trim(),
      ...(input.action && hasText(input.action) ? { action: input.action.trim() } : {}),
      ...(input.comment && hasText(input.comment) ? { comment: input.comment.trim() } : {}),
      ...(input.attachment ? { attachment: { ...input.attachment } } : {}),
    };
    const existingHistory = task.lifecycle?.history ?? [
      { to: from, at: task.createdAt, actor: 'kanban-agent', action: 'Lifecycle adopted' },
    ];
    const lifecycle = {
      currentStage: input.to,
      stageEnteredAt: at,
      history: [...existingHistory, transition],
    };
    applyTaskPatch(board, task, {
      columnId: board.lifecycle!.columns[input.to],
      status: STATUS_BY_STAGE[input.to],
      lifecycle,
    });
    if (input.to === 'done') clearGateRefusals(task);
    return { task, transition };
  });
  return updated?.result
    ? { board: updated.board, task: updated.result.task, transition: updated.result.transition }
    : null;
}

function validateRequiredCardDetails(
  task: KanbanTask,
  issues: KanbanLifecycleValidationIssue[],
): void {
  requireDetail(
    issues,
    'description',
    hasText(task.description),
    'Add a complete task description.',
  );
  requireDetail(
    issues,
    'assignee',
    [task.assignee, task.assignedAgent, task.assignment?.agentId, task.assignment?.name].some(
      hasText,
    ),
    'Assign an owner or agent.',
  );
  if (task.atomic) {
    requireDetail(
      issues,
      'childTaskIds',
      Boolean(task.childTaskIds?.some(hasText)),
      'This card is marked a composite parent but has no children. Either create them ' +
        '(kanban split_atomic), or — if the work turned out to be a single unit — call ' +
        'kanban update_task with `atomic: false` to make it an executable leaf again.',
    );
  }
  requireDetail(
    issues,
    'successCriteria',
    Boolean(
      task.successCriteria?.length &&
        task.successCriteria.every((check) => hasText(check.description)),
    ),
    'Add explicit acceptance criteria.',
  );
}

function validateRunningOwnership(
  task: KanbanTask,
  issues: KanbanLifecycleValidationIssue[],
): void {
  const assignment = task.assignment;
  const valid =
    assignment?.status === 'running' &&
    [
      assignment.leaseId,
      assignment.claimedAt,
      assignment.heartbeatAt,
      assignment.leaseExpiresAt,
    ].every(hasText);
  requireDetail(
    issues,
    'assignment',
    valid,
    'Running cards require an active assignment with lease, claim, heartbeat, and expiry metadata.',
  );
}

function validateReviewEvidence(task: KanbanTask, issues: KanbanLifecycleValidationIssue[]): void {
  if (!hasText(task.assignment?.lastResult)) {
    issues.push({
      code: 'review-evidence-missing',
      message:
        'Review requires a recorded implementation result. Call kanban mark_assignment with ' +
        '`lastResult` describing what was built before moving the card to Review.',
    });
  }
}
