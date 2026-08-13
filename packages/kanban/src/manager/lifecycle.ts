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
// Leaf module, not the `../manager.js` barrel: the barrel re-exports this file
// and the import would form a cycle that check:architecture flags.
import {
  clearGateRefusals,
  isBudgetedRefusal,
  recordCompletionRefusal,
} from '../verification/completion-park.js';
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
      // Adoption deliberately normalizes every legacy status onto the stage
      // projection, `archived` included: a card reached here only if it has no
      // lifecycle metadata, so it is legacy free-form state being brought into
      // the managed model, not a managed tombstone. Tombstones are created by
      // `archiveManagedTask` on cards that already carry a ledger, and the
      // `task.lifecycle !== undefined` branch above skips those untouched.
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
    if (isManagedTombstone(board, task)) {
      // Without this the repair would "fix" the archived status back to the
      // stage status and quietly return a merged-away card to the board,
      // `mergedIntoTaskId` still pointing at its replacement.
      throw new KanbanLifecycleError(
        `Card ${task.id} is archived; repairing its projection would revive it.`,
        [
          {
            code: 'stage-mismatch',
            field: 'status',
            message: `Card ${task.id} is archived; repairing its projection would revive it.`,
          },
        ],
      );
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

/**
 * Whether a managed card is a tombstone: archived, and therefore out of play
 * for good.
 *
 * `archived` is orthogonal to the five lifecycle stages — there is no archive
 * column in `lifecycle.columns`, so a card that leaves the board (merged away
 * by `mergeTasks`, or dropped by a task-graph resync) keeps the column and
 * stage it died in and stops projecting `STATUS_BY_STAGE`. Every managed guard
 * that assumes `status === STATUS_BY_STAGE[stage]` has to special-case this,
 * or the tombstone either wedges (no patch can pass) or gets revived (the
 * projection is "repaired" back to a live status).
 */
export function isManagedTombstone(board: KanbanBoard, task: KanbanTask): boolean {
  return board.lifecycle?.mode === 'managed' && task.status === 'archived';
}

/**
 * Take a card out of play, on managed and legacy boards alike.
 *
 * Writing `status = 'archived'` by hand is what made `mergeTasks` produce
 * cards that no `updateTask` could touch and that `repairManagedTaskProjection`
 * silently un-archived. Managed boards owe an audit entry for every state
 * change, so the archive is recorded in the card's own ledger at the stage it
 * died in — `currentStage` does not move, which keeps stage and column in
 * agreement and leaves `currentManagedStage` happy.
 */
export function archiveManagedTask(
  board: KanbanBoard,
  task: KanbanTask,
  options: { at: string; reason: string; actor?: string | undefined },
): void {
  if (task.status === 'archived') return;
  task.status = 'archived';
  delete task.completedAt;
  task.updatedAt = options.at;
  if (board.lifecycle?.mode !== 'managed' || !task.lifecycle) return;
  const stage = task.lifecycle.currentStage;
  task.lifecycle = {
    ...task.lifecycle,
    history: [
      ...task.lifecycle.history,
      {
        from: stage,
        to: stage,
        at: options.at,
        actor: options.actor?.trim() || 'kanban-agent',
        action: 'Card archived',
        comment: options.reason,
      },
    ],
  };
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
  if (isManagedTombstone(board, task)) {
    // A tombstone's status no longer projects from its stage, so the check
    // below would reject every patch — including a harmless title or label
    // fix — and leave the card permanently uneditable. Descriptive edits are
    // fine; moving or reviving it is not.
    const nextColumn = patch.columnId ?? task.columnId;
    const nextStatus = patch.status ?? task.status;
    if (nextColumn === task.columnId && nextStatus === task.status) return;
    const issues: KanbanLifecycleValidationIssue[] = [
      {
        code: 'transition-skipped',
        field: patch.columnId !== undefined ? 'columnId' : 'status',
        message: `Card ${task.id} is archived; an archived card cannot be moved or revived by a patch.`,
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
  try {
    return await runTaskTransition(projectRoot, boardId, taskId, input);
  } catch (error) {
    // A refused transition reports by throwing from inside `mutateBoard`,
    // which rolls the whole write back — counter included. So the refusal is
    // recorded in its own write here, where the rollback is already done.
    // Without this the managed Done gate could refuse the same card forever
    // and nothing downstream of it could ever start: verification was
    // guarding Done and stalling progress at the same time.
    if (
      input.to === 'done' &&
      error instanceof KanbanLifecycleError &&
      isBudgetedRefusal(error.issues)
    ) {
      await recordCompletionRefusal(projectRoot, boardId, taskId, {
        reason: error.issues[0]?.message ?? 'Done transition refused.',
        issues: error.issues.map((issue) => issue.message),
      }).catch(() => undefined); // Never let bookkeeping mask the real refusal.
    }
    throw error;
  }
}

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
    if (input.tickChecks?.length) {
      // tickChecks is the focused shortcut for Done: the agent that failed
      // the per-check `passed` gate can re-issue the same transition with
      // manual criteria ticked, with no separate update_check round-trip.
      // Validation lives in the shared `validateTickChecks` helper so the
      // mutating path and `preflightManagedTransition` cannot disagree on
      // what counts as a valid tick (chimera review finding: parity).
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
    // Lifecycle is passed as part of the same board mutation so card state and
    // audit evidence can never be persisted independently.
    applyTaskPatch(board, task, {
      columnId: board.lifecycle!.columns[input.to],
      status: STATUS_BY_STAGE[input.to],
      lifecycle,
    });
    // Reaching Done means the evidence the refusals were counted against no
    // longer holds. Only Done clears it: a Review -> Running repair loop keeps
    // the budget, which is what makes that loop terminate.
    if (input.to === 'done') clearGateRefusals(task);
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
  const effectiveReport = report ?? task.verificationReport;
  // The verifier is authoritative for any criterion whose id is on the
  // report's coveredCheckIds list. A passing verdict there means the check
  // already holds — refusing Done on the basis of the criterion's own
  // `status === 'pending'` field would force the agent to duplicate the
  // verifier's work by calling update_check, which is exactly the loop the
  // drift report describes.
  //
  // Freshness guards (otherwise an old passing report would shadow any new
  // failure forever — chimera review finding):
  //   - the report must cover every current criterion (one-to-one)
  //   - no current criterion may be `failed` (the verifier wouldn't have
  //     called it done otherwise)
  //   - if criteria were added/removed after the report, refuse — the
  //     report no longer describes the card
  const coveredByVerifier = new Set(effectiveReport?.coveredCheckIds ?? []);
  const currentCriterionIds = new Set(checks.map((check) => check.id));
  // The report must describe the SAME criteria the card currently has. ID
  // alone is not enough: an agent that edited a criterion's description or
  // type while keeping the id would inherit an old verifier verdict for a
  // changed criterion, which is exactly the lie the gate is meant to catch
  // (chimera review finding). Compare description + type as well.
  const checkFingerprint = (check: { description: string; type?: string | undefined }) =>
    `${check.description}\u0001${check.type ?? ''}`;
  const reportFingerprint = new Map<string, string>();
  const reportedChecks = (effectiveReport as { checks?: Array<{ checkId?: string; description: string; type?: string }> } | undefined)?.checks ?? [];
  for (const reported of reportedChecks) {
    if (reported.checkId) {
      reportFingerprint.set(reported.checkId, checkFingerprint(reported));
    }
  }
  const fingerprintMatches = checks.every(
    (check) => reportFingerprint.get(check.id) === checkFingerprint(check),
  );
  const coveredAllCurrent =
    coveredByVerifier.size === checks.length &&
    fingerprintMatches &&
    checks.every((check) => coveredByVerifier.has(check.id));
  const noCurrentFailures = checks.every((check) => check.status !== 'failed');
  const verifierPassedAll =
    coveredByVerifier.size > 0 &&
    effectiveReport?.verdict === 'passed' &&
    coveredAllCurrent &&
    noCurrentFailures &&
    checks.every((check) => currentCriterionIds.has(check.id));
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
  } else if (!verifierPassedAll && checks.some((check) => check.status !== 'passed')) {
    const unmet = checks.filter((check) => check.status !== 'passed');
    issues.push({
      code: 'acceptance-criteria-incomplete',
      field: 'successCriteria',
      message:
        `Done requires every acceptance criterion to be explicitly passed; ${unmet.length} of ` +
        `${checks.length} still ${unmet.length === 1 ? 'is' : 'are'} not ` +
        `(${unmet.map((check) => `"${check.description}" [${check.status}] (id=${check.id.slice(0, 8)})`).join(', ')}). ` +
        'Re-call transition_task with `tickChecks: [{checkId, checkStatus: "passed"}]` per failing id, ' +
        'or call kanban update_check with checkStatus: "passed" for each. ' +
        'If a criterion no longer applies, kanban remove_check drops it — ' +
        'never pass one that did not actually hold.',
    });
  }
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

/**
 * Preflight check for a managed transition that DOES NOT live inside a
 * board mutation. Returns the same `KanbanLifecycleValidationIssue[]` shape
 * the live gate uses, so the slash command's diagnostic and the lifecycle
 * gate share a single source of truth.
 *
 * Without this helper, the slash command had to re-implement ~70 lines of
 * evidence rules. Drift between the two surfaces produced diagnostics the
 * user trusted that the underlying gate then rejected, sending them back to
 * the same `running → done` retry loop. Call this helper from both
 * surfaces and the diagnostic can no longer outpace the gate.
 */

/**
 * Validate a `tickChecks` payload against the task's current criteria.
 *
 * Shared by `transitionTask` (the mutating path) and `preflightManagedTransition`
 * (the slash command's read-only walk), so both surfaces apply the same rules:
 *
 * - Each `checkId` must reference an existing criterion on the task. Silently
 *   dropping a typo'd id made the gate appear to pass while nothing changed
 *   (chimera review finding).
 * - Only manual criteria may be ticked. Non-manual criteria are owned by the
 *   verifier — flipping them by hand is the same lie the gate is trying to
 *   prevent. Surfacing them here lets the operator delete the criterion via
 *   `remove_check` instead of pretending it passed.
 *
 * Returns the issue list; the caller decides whether to throw (mutating path)
 * or surface as a diagnostic (preflight path).
 */
export function validateTickChecks(
  task: KanbanTask,
  tickChecks: readonly { checkId: string; checkStatus: 'passed' | 'failed' | 'skipped' }[],
): KanbanLifecycleValidationIssue[] {
  const checks = task.successCriteria ?? [];
  const issues: KanbanLifecycleValidationIssue[] = [];
  for (const tick of tickChecks) {
    const existing = checks.find((check) => check.id === tick.checkId);
    if (!existing) {
      issues.push({
        code: 'tickChecks-unknown-id',
        field: 'tickChecks',
        message:
          `tickChecks references unknown checkId "${tick.checkId}". ` +
          'Read the ids from kanban get_task and retry.',
      });
      continue;
    }
    if (existing.type !== 'manual') {
      issues.push({
        code: 'acceptance-criteria-incomplete',
        field: 'tickChecks',
        message:
          `tickChecks may only flip manual criteria; "${existing.description}" ` +
          `is type "${existing.type}" — the verifier owns it. ` +
          'Use kanban remove_check to drop a criterion that no longer applies.',
      });
    }
  }
  return issues;
}

/**
 * Non-mutating twin of the effective-task snapshot the mutating path
 * constructs inside `transitionTask`. Apply the supplied `tickChecks` to a
 * shallow clone so `validateDefinitionOfDone` evaluates the criteria in the
 * state they would have after the ticks land — without persisting the ticks
 * themselves. The original `task` is left untouched, so the preflight can
 * run this as a read-only check and discard the result.
 *
 * Mirrors the mutating path's contract EXACTLY: only manual criteria are
 * flippable; unknown ids and non-manual targets are surfaced as validation
 * issues by `validateTickChecks` (the caller runs that first and surfaces any
 * issues before constructing the snapshot). If a `tickChecks` entry would
 * be rejected by `validateTickChecks`, it is silently skipped here — the
 * caller has already been told. Each flip carries the `checkStatus` verbatim
 * (NOT hardcoded to `'passed'`); the mutating path at `transitionTask` uses
 * `tick.checkStatus` and the preflight must agree, otherwise a tick of
 * `failed` or `skipped` would be misrepresented as a pass in preflight only.
 *
 * The snapshot KEEPS `verificationReport`: ticking a manual criterion does not
 * suspend the verifier's authority over the criteria it isn't touching. The
 * mutating path flips only `successCriteria` and runs the gate with the report
 * intact, so dropping it here would refuse Done on cards the live gate accepts
 * — the exact drift this preflight exists to prevent — and would strand every
 * card whose command criteria only the verifier can settle. Staleness is already
 * handled by `validateDefinitionOfDone`'s coverage + fingerprint guards.
 */
function applyTickChecksToSnapshot(
  task: KanbanTask,
  tickChecks: KanbanTaskTransitionInput['tickChecks'],
): KanbanTask {
  if (!tickChecks?.length) return task;
  const issues = validateTickChecks(task, tickChecks);
  if (issues.length > 0) return task;
  const now = nowIso();
  const tickById = new Map(tickChecks.map((tick) => [tick.checkId, tick]));
  return {
    ...task,
    successCriteria: (task.successCriteria ?? []).map((check) => {
      const tick = tickById.get(check.id);
      if (!tick || check.type !== 'manual') return check;
      return {
        ...check,
        status: tick.checkStatus,
        checkedBy: 'agent',
        checkedAt: now,
      };
    }),
  };
}

export function preflightManagedTransition(
  board: KanbanBoard,
  task: KanbanTask,
  input: KanbanTaskTransitionInput,
): KanbanLifecycleValidationIssue[] {
  const issues: KanbanLifecycleValidationIssue[] = [];

  // Running ownership — the card must hold an active lease to enter
  // Running. Mirrors the in-mutation check; surfaced here so the slash
  // command names the missing fields the same way the gate does.
  if (input.to === 'running') {
    const assignment = task.assignment;
    const hasLease =
      assignment?.status === 'running' &&
      [
        assignment.leaseId,
        assignment.claimedAt,
        assignment.heartbeatAt,
        assignment.leaseExpiresAt,
      ].every((value) => typeof value === 'string' && value.trim().length > 0);
    if (!hasLease) {
      issues.push({
        code: 'running-lease-missing',
        field: 'assignment',
        message:
          'The Running gate requires the card to carry leaseId, claimedAt, heartbeatAt, and leaseExpiresAt. Move it into Running first via /kanban task assign or /kanban task dispatch.',
      });
    }
  }

  // Review/Done lastResult. The live gate's `validateReviewEvidence` and
  // `validateDoneEvidence` treat `attachment.url` as OPTIONAL — a real
  // attachment is not required for the gate to allow the transition. The
  // preflight must mirror the live gate's contract; demanding an attachment
  // here would reject transitions that the gate itself accepts, which is
  // exactly the drift the preflight was supposed to prevent. The lastResult
  // channel is surfaced as a blocking issue; the attachment channel is a
  // recommendation only (passed via `recommendations`, never via `issues`).
  if (input.to === 'review' || input.to === 'done') {
    if (!task.assignment?.lastResult) {
      issues.push({
        code: 'review-evidence-missing',
        field: 'assignment.lastResult',
        message:
          'Review/Done evidence requires the card to carry an assignment.lastResult. Dispatch the worker through the agentic supervisor so it records implementation output.',
      });
    }
  }

  // Done evidence — Definition of Done + atomic children. validateDefinitionOfDone
  // now honors `verificationReport.coveredCheckIds`, so the verifier can
  // settle the criteria even when they are still `status: 'pending'` on the
  // card. The diagnostic it emits lists every still-failing check id so the
  // slash command can recommend a focused `tickChecks` retry.
  //
  // When `input.tickChecks` is supplied, the valid manual criteria MUST be
  // applied to a non-mutating effective task snapshot BEFORE the Definition
  // of Done runs — otherwise a retry that passes pending manual criteria via
  // `--tick-check` is still rejected as `acceptance-criteria-incomplete` and
  // never reaches `transitionTask`. The mutating path at `transitionTask`
  // builds the same effective snapshot and then persists it; the preflight
  // builds an identical snapshot, runs the gate against it, and discards it.
  if (input.to === 'done') {
    const effectiveTask = applyTickChecksToSnapshot(task, input.tickChecks);
    issues.push(
      ...validateDefinitionOfDone(effectiveTask, effectiveTask.verificationReport, {
        requireCriteria: true,
        board,
      }),
    );
    if (task.atomic && task.childTaskIds && task.childTaskIds.length > 0) {
      const missingChildren = task.childTaskIds.filter(
        (childId) => !board.tasks.some((entry) => entry.id === childId),
      );
      if (missingChildren.length > 0) {
        issues.push({
          code: 'atomic-children-unresolved',
          field: 'childTaskIds',
          message: `Atomic parent references unresolved children (${missingChildren.join(', ')}). Resolve them via the kanban tool before retrying.`,
        });
      }
      const incompleteChildren = board.tasks.filter(
        (entry) =>
          task.childTaskIds!.includes(entry.id) && entry.status !== 'completed',
      );
      if (incompleteChildren.length > 0) {
        const ids = incompleteChildren.map((entry) => entry.id).join(', ');
        issues.push({
          code: 'atomic-children-incomplete',
          field: 'childTaskIds',
          message: `Atomic parent's children must be completed before Done (pending: ${ids}).`,
        });
      }
    }
  }

  // Tick checks are the focused shortcut for Done. The preflight must call
  // the SAME validator as the mutating path (`validateTickChecks`) so that
  // either surface rejects the same inputs in the same way — silently
  // skipping an unknown checkId here would let the slash preflight pass while
  // the live transitionTask throws, which is exactly the drift the refactor
  // was meant to eliminate. The mutating path constructs an effective task
  // snapshot before the gate, so the preflight mirrors that against the same
  // task it received.
  if (input.tickChecks?.length) {
    const tickIssues = validateTickChecks(task, input.tickChecks);
    for (const issue of tickIssues) {
      issues.push(issue);
    }
  }

  return issues;
}
