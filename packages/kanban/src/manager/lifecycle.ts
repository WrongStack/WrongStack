import { mutateBoard } from '../storage.js';
import type {
  AdoptManagedLifecycleInput,
  KanbanBoard,
  KanbanBoardLifecyclePolicy,
  KanbanLifecycleStage,
  KanbanLifecycleTransition,
  KanbanLifecycleValidationIssue,
  RepairManagedProjectionInput,
  KanbanTask,
  KanbanTaskStatus,
  KanbanTaskTransitionInput,
  KanbanTaskTransitionResult,
  KanbanVerificationReport,
} from '../types.js';
import { applyTaskPatch, findTask, nowIso } from './_internal.js';

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

export class KanbanLifecycleError extends Error {
  readonly issues: readonly KanbanLifecycleValidationIssue[];

  constructor(message: string, issues: readonly KanbanLifecycleValidationIssue[]) {
    super(message);
    this.name = 'KanbanLifecycleError';
    this.issues = issues;
  }
}

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
 * Thrown when a concurrent modification is detected during board mutation.
 * Using a typed error (rather than `Error` with a message string) lets
 * callers reliably identify stale-write failures via `instanceof` instead
 * of fragile `error.message.includes(...)` checks.
 */
export class StaleWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleWriteError';
  }
}

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
      const message = `Unmapped legacy columns: ${unmappedColumns.map((column) => column.id).join(', ')}.`;
      throw new KanbanLifecycleError(message, [
        {
          code: 'managed-policy-invalid',
          field: 'lifecycle.columns',
          message,
        },
      ]);
    }

    board.lifecycle = lifecycle;
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
        throw new KanbanLifecycleError(`Card ${task.id} is outside the adopted lifecycle columns.`, [
          {
            code: 'stage-mismatch',
            field: 'columnId',
            message: `Card ${task.id} is outside the adopted lifecycle columns.`,
          },
        ]);
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
      throw new KanbanLifecycleError('Managed projection repair requires managed lifecycle metadata.', [
        {
          code: 'managed-policy-invalid',
          field: 'lifecycle',
          message: 'Managed projection repair requires managed lifecycle metadata.',
        },
      ]);
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
      throw new KanbanLifecycleError('Managed card projection already matches its lifecycle stage.', [
        {
          code: 'stage-mismatch',
          field: 'columnId',
          message: 'Managed card projection already matches its lifecycle stage.',
        },
      ]);
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
    issues.push({ code: 'task-detail-missing', field: 'actor', message: 'Transition actor is required.' });
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
    if (input.to === 'running') validateRunningOwnership(task, issues);
    if (input.to === 'review') validateReviewEvidence(task, input, issues);
    if (input.to === 'done') validateDoneEvidence(task, input, issues);
  }
  return issues;
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
    if (input.patch) applyTaskPatch(board, task, input.patch);
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
  requireDetail(issues, 'description', hasText(task.description), 'Add a complete task description.');
  requireDetail(
    issues,
    'assignee',
    [task.assignee, task.assignedAgent, task.assignment?.agentId, task.assignment?.name].some(hasText),
    'Assign an owner or agent.',
  );
  requireDetail(
    issues,
    'dueDate',
    hasText(task.dueDate) && Number.isFinite(Date.parse(task.dueDate)),
    'Add a valid due date.',
  );
  requireDetail(issues, 'labels', Boolean(task.labels?.some(hasText)), 'Add at least one tag or label.');
  requireDetail(
    issues,
    'childTaskIds',
    Boolean(task.childTaskIds?.some(hasText)),
    'Break the work into at least one persisted subtask.',
  );
  requireDetail(
    issues,
    'successCriteria',
    Boolean(task.successCriteria?.length && task.successCriteria.every((check) => hasText(check.description))),
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
    [assignment.leaseId, assignment.claimedAt, assignment.heartbeatAt, assignment.leaseExpiresAt].every(
      hasText,
    );
  requireDetail(
    issues,
    'assignment',
    valid,
    'Running cards require an active assignment with lease, claim, heartbeat, and expiry metadata.',
  );
}

function validateReviewEvidence(
  task: KanbanTask,
  input: KanbanTaskTransitionInput,
  issues: KanbanLifecycleValidationIssue[],
): void {
  if (!hasText(task.assignment?.lastResult) || !hasAttachmentUrl(input.attachment)) {
    issues.push({
      code: 'review-evidence-missing',
      message: 'Review requires a persisted implementation result and evidence attachment.',
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
  options: { requireCriteria?: boolean | undefined } = {},
): KanbanLifecycleValidationIssue[] {
  const issues: KanbanLifecycleValidationIssue[] = [];
  const requireCriteria = options.requireCriteria !== false;
  const checks = task.successCriteria ?? [];
  if ((requireCriteria && !checks.length) || checks.some((check) => check.status !== 'passed')) {
    issues.push({
      code: 'acceptance-criteria-incomplete',
      field: 'successCriteria',
      message: 'Done requires every acceptance criterion to be explicitly passed.',
    });
  }
  const effectiveReport = report ?? task.verificationReport;
  // Atomic tasks must have a completed verification report before Done.
  if (task.atomic && !effectiveReport) {
    issues.push({
      code: 'review-evidence-missing',
      field: 'verificationReport',
      message: 'Atomic tasks require a completed verification report (run verify_completion) before Done.',
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
  task: KanbanTask,
  input: KanbanTaskTransitionInput,
  issues: KanbanLifecycleValidationIssue[],
): void {
  issues.push(...validateDefinitionOfDone(task, task.verificationReport));
  if (!hasAttachmentUrl(input.attachment) || !hasText(input.action)) {
    issues.push({
      code: 'review-evidence-missing',
      message: 'Done requires reviewer action text and a persisted review attachment.',
    });
  }
}

/**
 * An evidence attachment must carry a nonblank URL to satisfy the Review/Done
 * guards. Rejects `undefined`, empty string, and whitespace-only URLs so a
 * merely present attachment object cannot satisfy the lifecycle guard.
 */
function hasAttachmentUrl(attachment: KanbanTaskTransitionInput['attachment']): boolean {
  return Boolean(attachment && hasText(attachment.url));
}

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
