import type {
  KanbanBoard,
  KanbanLifecycleStage,
  KanbanTask,
  KanbanTaskStatus,
} from '../../types.js';
import type { KanbanLifecycleValidationIssue } from '../../types-operations.js';
import { KanbanLifecycleError } from '../lifecycle-error.js';
import { hasText, requireDetail } from './definition-of-done.js';

export const KANBAN_AGENT_STAGES: readonly KanbanLifecycleStage[] = [
  'backlog',
  'todo',
  'running',
  'review',
  'done',
];

export const STATUS_BY_STAGE: Readonly<Record<KanbanLifecycleStage, KanbanTaskStatus>> = {
  backlog: 'pending',
  todo: 'ready',
  running: 'in_progress',
  review: 'review',
  done: 'completed',
};

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

export function currentManagedStage(board: KanbanBoard, task: KanbanTask): KanbanLifecycleStage {
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

export function isManagedTombstone(board: KanbanBoard, task: KanbanTask): boolean {
  return board.lifecycle?.mode === 'managed' && task.status === 'archived';
}

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
