import { mutateBoard } from '../storage.js';
import type {
  AdoptManagedLifecycleInput,
  KanbanBoard,
  KanbanBoardLifecyclePolicy,
  KanbanLifecycleStage,
  KanbanLifecycleTransition,
  KanbanLifecycleValidationIssue,
  KanbanTask,
  KanbanTaskStatus,
  KanbanTaskTransitionInput,
  KanbanTaskTransitionResult,
  KanbanVerificationReport,
  RepairManagedProjectionInput,
} from '../types.js';
import {
  applyTaskPatch,
  createBoardHistoryEntry,
  emitBoardHistoryEvent,
  findTask,
  nowIso,
} from './_internal.js';
import { KanbanLifecycleError } from './lifecycle-error.js';
import { dependencyIncompleteMessage, getDependencyReadinessIssues } from './task-readiness.js';

export {
  decodeLifecycleIssues,
  KanbanLifecycleError,
  LIFECYCLE_ISSUES_PREFIX,
  LIFECYCLE_ISSUES_SUFFIX,
  stripLifecycleIssues,
} from './lifecycle-error.js';

export const KANBAN_AGENT_STAGES: readonly KanbanLifecycleStage[] = [
  'backlog',
  'todo',
  'running',
  'review',
  'done',
];

const STATUS_BY_STAGE: Readonly<Record<KanbanLifecycleStage, KanbanTaskStatus>> = {
  backlog: 'pending',
  todo: 'ready',
  running: 'in_progress',
  review: 'review',
  done: 'completed',
};

/**
 * Shared prefix for StaleWriteError messages constructed by the local storage
 * backends (SqliteKanbanStorage, file-legacy storage.ts). The prefix ensures
 * error messages are recognisable in logs and test assertions, but callers
 * should use `instanceof StaleWriteError` for local detection or
 * `error.code === 'STALE_WRITE'` when the error has crossed IPC serialization
 * (see remote-storage.ts and project-server.ts).
 */
export const STALE_WRITE_PREFIX = 'Stale write detected' as const;

/**
 * Re-export. `StaleWriteError` moved to `lifecycle-error.ts` so the IPC client
 * can reconstruct it after deserialization — `instanceof StaleWriteError` now
 * holds whether the mutation ran locally or through the daemon.
 */
export { StaleWriteError } from './lifecycle-error.js';

export function createManagedLifecyclePolicy(
  overrides: Partial<KanbanBoardLifecyclePolicy['columns']> = {},
): KanbanBoardLifecyclePolicy {
  return {
    mode: 'managed',
    columns: {
      backlog: overrides.backlog ?? 'backlog',
      todo: overrides.todo ?? 'todo',
      running: overrides.running ?? 'in-progress',
      review: overrides.review ?? 'review',
      done: overrides.done ?? 'done',
    },
  };
}

export async function adoptManagedLifecycle(
  projectRoot: string,
  boardId: string,
  input: AdoptManagedLifecycleInput,
): Promise<KanbanBoard | null> {
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    if (!hasText(input.actor) || !hasText(input.comment)) {
      throw new KanbanLifecycleError('Lifecycle adoption requires an actor and audit comment.', [
        {
          code: 'task-detail-missing',
          field: !hasText(input.actor) ? 'actor' : 'comment',
          message: 'Lifecycle adoption requires an actor and audit comment.',
        },
      ]);
    }
    if (board.tasks.some((task) => task.lifecycle !== undefined)) {
      // A previous adoption may have partially written lifecycle metadata.
      // Instead of rejecting the entire operation, adopt only cards that
      // have no lifecycle metadata yet. Cards already adopted keep their
      // existing lifecycle stage.
      const alreadyAdopted = board.tasks.filter((task) => task.lifecycle !== undefined).length;
      if (alreadyAdopted > 0) {
        process.stderr.write(
          `[kanban] adoptManagedLifecycle: ${alreadyAdopted}/${board.tasks.length} cards ` +
            `already have lifecycle metadata — adopting remaining cards only.\n`,
        );
      }
    }

    const at = nowIso();
    const lifecycle: KanbanBoardLifecyclePolicy = {
      mode: 'managed',
      columns: { ...input.columns },
      adoptedAt: at,
      adoptedBy: input.actor.trim(),
      adoptionComment: input.comment.trim(),
    };
    const policyIssues = validateManagedLifecyclePolicy({ columns: board.columns, lifecycle });
    if (policyIssues.length > 0) {
      throw new KanbanLifecycleError(policyIssues[0]!.message, policyIssues);
    }
    const mappedColumns = new Set(Object.values(lifecycle.columns));
    const unmappedColumns = board.columns.filter((column) => !mappedColumns.has(column.id));
    if (unmappedColumns.length > 0) {
      const message = `Unmapped legacy columns: ${unmappedColumns
        .map((column) => `${column.id} ("${column.title}")`)
        .join(', ')}.`;
      throw new KanbanLifecycleError(message, [
        {
          code: 'managed-policy-invalid',
          field: 'lifecycle.columns',
          message,
        },
      ]);
    }

    board.lifecycle = lifecycle;
    // Explicitly set strict completion gate so the board record carries the
    // enforcement intent visibly, rather than relying on the resolveGateEnforcement
    // fallback. Managed boards are always strict unless explicitly relaxed.
    if (!board.completionGate || board.completionGate.enforcement === 'off') {
      board.completionGate = { enforcement: 'strict' };
    }
    board.updatedAt = at;
    for (const task of board.tasks) {
      // Skip cards that already have lifecycle metadata — they were adopted
      // in a previous (possibly partial) adoption and keep their existing stage.
      // Re-adoption with different column mappings would leave a skipped card's
      // currentStage out of sync, so verify consistency before skipping.
      if (task.lifecycle !== undefined) {
        const expectedStage = lifecycleStageForColumn(board, task.columnId);
        if (task.lifecycle.currentStage !== expectedStage) {
          const msg =
            `Card ${task.id} lifecycle stage "${task.lifecycle.currentStage}" does not match ` +
            `its column under the new policy (expected "${expectedStage ?? 'none'}"). ` +
            `Re-adoption with different column mappings requires resetting the card lifecycle.`;
          throw new KanbanLifecycleError(msg, [
            {
              code: 'stage-mismatch',
              field: 'lifecycle.currentStage',
              message: msg,
            },
          ]);
        }
        continue;
      }
      const stage = lifecycleStageForColumn(board, task.columnId);
      if (!stage) {
        throw new KanbanLifecycleError(
          `Card ${task.id} is outside the adopted lifecycle columns.`,
          [
            {
              code: 'stage-mismatch',
              field: 'columnId',
              message: `Card ${task.id} is outside the adopted lifecycle columns.`,
            },
          ],
        );
      }
      task.status = STATUS_BY_STAGE[stage];
      task.updatedAt = at;
      task.lifecycle = {
        currentStage: stage,
        stageEnteredAt: at,
        history: [
          {
            to: stage,
            at,
            actor: input.actor.trim(),
            action: 'Managed lifecycle adopted',
            comment: input.comment.trim(),
          },
        ],
      };
      if (stage !== 'done') delete task.completedAt;
      else task.completedAt ??= at;
    }
    return board;
  });
  if (updated) {
    await emitBoardHistoryEvent(
      projectRoot,
      createBoardHistoryEntry(updated.board.id, updated.board.title, 'board.lifecycle.adopted', {
        actor: input.actor.trim(),
        note: input.comment.trim(),
      }),
    );
  }
  return updated?.board ?? null;
}

export async function repairManagedTaskProjection(
  projectRoot: string,
  boardId: string,
  taskId: string,
  input: RepairManagedProjectionInput,
): Promise<KanbanTaskTransitionResult | null> {
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    if (!task) return null;
    if (board.lifecycle?.mode !== 'managed' || !task.lifecycle) {
      throw new KanbanLifecycleError(
        'Managed projection repair requires managed lifecycle metadata.',
        [
          {
            code: 'managed-policy-invalid',
            field: 'lifecycle',
            message: 'Managed projection repair requires managed lifecycle metadata.',
          },
        ],
      );
    }
    if (!hasText(input.actor) || !hasText(input.comment)) {
      throw new KanbanLifecycleError('Projection repair requires an actor and audit comment.', [
        {
          code: 'task-detail-missing',
          field: !hasText(input.actor) ? 'actor' : 'comment',
          message: 'Projection repair requires an actor and audit comment.',
        },
      ]);
    }
    const stage = task.lifecycle.currentStage;
    const expectedColumnId = board.lifecycle.columns[stage];
    const expectedStatus = STATUS_BY_STAGE[stage];
    if (task.columnId === expectedColumnId && task.status === expectedStatus) {
      throw new KanbanLifecycleError(
        'Managed card projection already matches its lifecycle stage.',
        [
          {
            code: 'stage-mismatch',
            field: 'columnId',
            message: 'Managed card projection already matches its lifecycle stage.',
          },
        ],
      );
    }
    const at = nowIso();
    const transition: KanbanLifecycleTransition = {
      from: stage,
      to: stage,
      at,
      actor: input.actor.trim(),
      action: 'Managed projection repaired',
      comment: input.comment.trim(),
    };
    task.columnId = expectedColumnId;
    task.status = expectedStatus;
    task.updatedAt = at;
    if (stage !== 'done') delete task.completedAt;
    else task.completedAt ??= at;
    task.lifecycle = {
      ...task.lifecycle,
      history: [...task.lifecycle.history, transition],
    };
    board.updatedAt = at;
    return { task, transition };
  });
  return updated?.result
    ? { board: updated.board, task: updated.result.task, transition: updated.result.transition }
    : null;
}

export function validateManagedLifecyclePolicy(
  board: Pick<KanbanBoard, 'columns' | 'lifecycle'>,
): KanbanLifecycleValidationIssue[] {
  const policy = board.lifecycle;
  if (policy?.mode !== 'managed') return [];
  const configured = KANBAN_AGENT_STAGES.map((stage) => policy.columns[stage]);
  const existing = new Set(board.columns.map((column) => column.id));
  if (new Set(configured).size !== KANBAN_AGENT_STAGES.length) {
    return [
      {
        code: 'managed-policy-invalid',
        field: 'lifecycle.columns',
        message: 'Managed lifecycle column roles must be distinct.',
      },
    ];
  }
  const missing = configured.filter((columnId) => !existing.has(columnId));
  return missing.length
    ? [
        {
          code: 'managed-policy-invalid',
          field: 'lifecycle.columns',
          message: `Managed lifecycle columns do not exist: ${missing.join(', ')}.`,
        },
      ]
    : [];
}

export function lifecycleStageForColumn(
  board: Pick<KanbanBoard, 'lifecycle'>,
  columnId: string,
): KanbanLifecycleStage | null {
  const policy = board.lifecycle;
  if (policy?.mode !== 'managed') return null;
  return KANBAN_AGENT_STAGES.find((stage) => policy.columns[stage] === columnId) ?? null;
}

export function initializeManagedTaskLifecycle(board: KanbanBoard, task: KanbanTask): void {
  if (board.lifecycle?.mode !== 'managed') return;
  const policyIssues = validateManagedLifecyclePolicy(board);
  if (policyIssues.length) throw new KanbanLifecycleError(policyIssues[0]!.message, policyIssues);
  const stage = lifecycleStageForColumn(board, task.columnId);
  if (stage !== 'backlog') {
    const issues: KanbanLifecycleValidationIssue[] = [
      {
        code: 'transition-skipped',
        field: 'columnId',
        message: 'Managed cards must be created in Backlog and progress one stage at a time.',
      },
    ];
    throw new KanbanLifecycleError(issues[0]!.message, issues);
  }
  const at = task.createdAt;
  task.status = STATUS_BY_STAGE.backlog;
  task.lifecycle = {
    currentStage: 'backlog',
    stageEnteredAt: at,
    history: [{ to: 'backlog', at, actor: 'kanban-agent', action: 'Card created' }],
  };
}

export function initializeAndValidateManagedTask(board: KanbanBoard, task: KanbanTask): void {
  initializeManagedTaskLifecycle(board, task);
  if (board.lifecycle?.mode !== 'managed') return;
  const issues: KanbanLifecycleValidationIssue[] = [];
  requireDetail(
    issues,
    'description',
    hasText(task.description),
    'Add a complete task description.',
  );
  if (issues.length) throw new KanbanLifecycleError(issues[0]!.message, issues);
}

export function assertManagedTaskPatchAllowed(
  board: KanbanBoard,
  task: KanbanTask,
  patch: {
    columnId?: string | undefined;
    status?: KanbanTaskStatus | undefined;
    lifecycle?: unknown;
  },
): void {
  if (board.lifecycle?.mode !== 'managed') return;
  if (patch.lifecycle !== undefined) {
    const issues: KanbanLifecycleValidationIssue[] = [
      {
        code: 'transition-skipped',
        field: 'lifecycle',
        message: 'Managed lifecycle metadata is immutable outside transitionTask.',
      },
    ];
    throw new KanbanLifecycleError(issues[0]!.message, issues);
  }
  const stage = currentManagedStage(board, task);
  const nextColumn = patch.columnId ?? task.columnId;
  const nextStatus = patch.status ?? task.status;
  if (nextColumn === task.columnId && nextStatus === STATUS_BY_STAGE[stage]) return;
  const issues: KanbanLifecycleValidationIssue[] = [
    {
      code: 'transition-skipped',
      message:
        'Managed card lifecycle changes must use transitionTask so the column, status, comment, evidence, and audit ledger are written atomically.',
    },
  ];
  throw new KanbanLifecycleError(issues[0]!.message, issues);
}

export function validateManagedTaskTransition(
  board: KanbanBoard,
  task: KanbanTask,
  input: KanbanTaskTransitionInput,
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

  let from: KanbanLifecycleStage;
  try {
    from = currentManagedStage(board, task);
  } catch (error) {
    if (error instanceof KanbanLifecycleError) return [...error.issues];
    throw error;
  }
  const fromIndex = KANBAN_AGENT_STAGES.indexOf(from);
  const toIndex = KANBAN_AGENT_STAGES.indexOf(input.to);
  if (from === 'done' || Math.abs(toIndex - fromIndex) !== 1) {
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
    // A forward transition moves the card into the destination stage's column.
    // Enforce the column's WIP limit so the counter the UI shows is honest.
    // wipLimit <= 0 means unlimited (the default for Backlog/Todo/Review/Done).
    // The card being transitioned is excluded from the count so moving it does
    // not count against itself when it is already in the destination column
    // (e.g. a re-transition after a no-op).
    validateDestinationWipLimit(board, task, input.to, issues);
  }
  // Running is executable state regardless of direction. Review -> Running is
  // a repair loop, but it still must not bypass the dependency DAG.
  if (input.to === 'running') {
    validateRunningOwnership(task, issues);
    validateRunningDependencies(board, task, issues);
  }
  return issues;
}

/**
 * Enforce the destination column's WIP limit on forward managed transitions.
 *
 * `wipLimit` is defined on every column and the default "In Progress" column
 * ships with `wipLimit: 5`, but until now nothing compared the column's task
 * count against it — the UI rendered `[3/5]` while 7 cards could pile up. This
 * makes the limit binding on managed transitions: moving a card into a column
 * that is already at its limit is refused with a `wip-limit-exceeded` issue.
 *
 * `wipLimit <= 0` is treated as unlimited (matching the default Backlog/Todo/
 * Review/Done columns, all of which are 0). The transitioning card itself is
 * excluded from the count so a re-transition or a card already sitting in the
 * destination column is not blocked by its own presence.
 */
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
  if (limit <= 0) return; // unlimited
  // Count cards currently in the destination column, excluding the card being
  // moved (it is about to leave its current column and enter this one).
  const occupants = board.tasks.filter(
    (t) => t.columnId === columnId && t.id !== task.id,
  ).length;
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

/**
 * Parent/child atomic gate: a parent task with childTaskIds cannot reach
 * Done until every child task has reached Done. This prevents a composite
 * task from being marked complete when its constituent work is still in
 * progress or review.
 *
 * Non-atomic parents (where every child is done but the parent has no
 * verification report) are handled by validateDoneEvidence above.
 */
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
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    if (!task) return null;
    if (input.patch) {
      // The transition OWNS columnId/status/lifecycle — they are written
      // atomically below from the VALIDATED transition. The input type
      // Omit<>s them, but that strips fields at the TypeScript layer only;
      // over IPC the patch arrives as plain JSON, so a single call could
      // smuggle Backlog→done past the ownership/evidence guards and
      // REPLACE the audit ledger with a caller-supplied history array.
      // Mirror the updateTask path (tasks.ts calls
      // assertManagedTaskPatchAllowed) by failing loud instead of
      // silently stripping.
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
    // Lifecycle is passed as part of the same board mutation so card state and
    // audit evidence can never be persisted independently.
    applyTaskPatch(board, task, {
      columnId: board.lifecycle!.columns[input.to],
      status: STATUS_BY_STAGE[input.to],
      lifecycle,
    });
    return { task, transition };
  });
  return updated?.result
    ? { board: updated.board, task: updated.result.task, transition: updated.result.transition }
    : null;
}

function currentManagedStage(board: KanbanBoard, task: KanbanTask): KanbanLifecycleStage {
  const columnStage = lifecycleStageForColumn(board, task.columnId);
  if (!columnStage) {
    const issues: KanbanLifecycleValidationIssue[] = [
      {
        code: 'stage-mismatch',
        field: 'columnId',
        message: `Card ${task.id} is outside the managed lifecycle columns.`,
      },
    ];
    throw new KanbanLifecycleError(issues[0]!.message, issues);
  }
  if (task.lifecycle && task.lifecycle.currentStage !== columnStage) {
    const issues: KanbanLifecycleValidationIssue[] = [
      {
        code: 'stage-mismatch',
        field: 'lifecycle.currentStage',
        message: `Card lifecycle says ${task.lifecycle.currentStage}, but its column is ${columnStage}.`,
      },
    ];
    throw new KanbanLifecycleError(issues[0]!.message, issues);
  }
  return columnStage;
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
  // `dueDate` and `labels` are deliberately not required. They are meaningful
  // for a human backlog and pure theatre for agent work: a thirty-line fix has
  // no genuine deadline, so demanding one only teaches the caller to invent a
  // date to get past the gate. Both remain available and are used when set.
  // Composite parents (truthy atomic) MUST have persisted children.
  // Atomic leaves (falsy/undefined atomic) are executable directly and
  // must not be forced into infinite recursive decomposition.
  // Use truthy check to stay consistent with completion-protocol.ts:90
  // and validateDefinitionOfDone (lifecycle.ts:617/624).
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
  // An evidence URL is not always available for real work, and demanding one
  // turned Review into a dead end: the only remedy is a field on this very
  // call, while the old message pointed at the card, so callers burned whole
  // sessions on add_link/add_note/mark_assignment. Keep the substantive
  // requirement — say what was implemented — and let the URL be optional.
  if (!hasText(task.assignment?.lastResult)) {
    issues.push({
      code: 'review-evidence-missing',
      message:
        'Review requires a recorded implementation result. Call kanban mark_assignment with ' +
        '`lastResult` describing what was built before moving the card to Review.',
    });
  }
}

/**
 * The Definition-of-Done rules shared by the managed lifecycle gate
 * (`validateDoneEvidence`) and the universal completion gate
 * (`verification/completion-gate.ts`). Reviewer-attachment requirements stay
 * in `validateDoneEvidence` because they only exist on managed transitions.
 *
 * `report` overrides `task.verificationReport` so a freshly computed (not yet
 * persisted) report can be evaluated. `requireCriteria` (default true) demands
 * at least one acceptance criterion; the soft completion gate relaxes it so
 * criterion-less legacy tasks complete quietly.
 */
export function validateDefinitionOfDone(
  task: KanbanTask,
  report?: KanbanVerificationReport,
  options: { requireCriteria?: boolean | undefined; board?: KanbanBoard | undefined } = {},
): KanbanLifecycleValidationIssue[] {
  const issues: KanbanLifecycleValidationIssue[] = [];
  const requireCriteria = options.requireCriteria !== false;
  const checks = task.successCriteria ?? [];
  // Two different situations, and one shared message used to describe only the
  // second: told to "read the ids and pass each one", a caller holding a card
  // with NO criteria went round get_task → nothing to update → retry. Name the
  // remedy that actually applies.
  if (requireCriteria && !checks.length) {
    issues.push({
      code: 'acceptance-criteria-incomplete',
      field: 'successCriteria',
      message:
        'Done requires at least one acceptance criterion, and this card has none. ' +
        'Call kanban add_check with what would prove the work correct, then pass it.',
    });
  } else if (checks.some((check) => check.status !== 'passed')) {
    const unmet = checks.filter((check) => check.status !== 'passed');
    issues.push({
      code: 'acceptance-criteria-incomplete',
      field: 'successCriteria',
      message:
        `Done requires every acceptance criterion to be explicitly passed; ${unmet.length} of ` +
        `${checks.length} still ${unmet.length === 1 ? 'is' : 'are'} not ` +
        `(${unmet.map((check) => `"${check.description}" [${check.status}]`).join(', ')}). ` +
        'Read the ids from kanban get_task, then call kanban update_check with ' +
        '`checkStatus: "passed"` for each. If a criterion no longer applies, ' +
        'kanban remove_check drops it — never pass one that did not actually hold.',
    });
  }
  const effectiveReport = report ?? task.verificationReport;
  // Atomic tasks must have a completed verification report before Done.
  if (task.atomic && !effectiveReport) {
    issues.push({
      code: 'review-evidence-missing',
      field: 'verificationReport',
      message:
        'Atomic tasks require a completed verification report (run verify_completion) before Done.',
    });
  }
  if (task.atomic && effectiveReport?.verdict !== 'passed') {
    issues.push({
      code: 'acceptance-criteria-incomplete',
      field: 'verificationReport',
      message: `Atomic task verification verdict is "${effectiveReport?.verdict ?? 'missing'}". Only "passed" allows Done.`,
    });
  }
  return issues;
}

function validateDoneEvidence(
  board: KanbanBoard,
  task: KanbanTask,
  input: KanbanTaskTransitionInput,
  issues: KanbanLifecycleValidationIssue[],
): void {
  issues.push(...validateDefinitionOfDone(task, task.verificationReport, { board }));
  // The attachment URL is no longer required, and the message now names the
  // parameter instead of describing an artifact. The old wording ("a persisted
  // review attachment") read as something to store on the card, so callers
  // tried add_link, add_note and mark_assignment in turn — none of which can
  // satisfy a check on this call's own input.
  if (!hasText(input.action)) {
    issues.push({
      code: 'review-evidence-missing',
      message:
        'Done requires reviewer action text. Pass `transitionAction` on this transition_task ' +
        'call describing what was accepted (an evidence URL via `attachmentUrl` is optional).',
    });
  }
}

/**
 * An evidence attachment must carry a nonblank URL to satisfy the Review/Done
 * guards. Rejects `undefined`, empty string, and whitespace-only URLs so a
 * merely present attachment object cannot satisfy the lifecycle guard.
 */
function requireDetail(
  issues: KanbanLifecycleValidationIssue[],
  field: string,
  valid: boolean,
  message: string,
): void {
  if (!valid) issues.push({ code: 'task-detail-missing', field, message });
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
