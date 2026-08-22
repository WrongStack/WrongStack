import { mutateBoard } from '../../storage.js';
import type {
  KanbanBoard,
  KanbanBoardLifecyclePolicy,
  KanbanLifecycleTransition,
} from '../../types.js';
import type {
  AdoptManagedLifecycleInput,
  KanbanTaskTransitionResult,
  RepairManagedProjectionInput,
} from '../../types-operations.js';
import { createBoardHistoryEntry, emitBoardHistoryEvent, findTask, nowIso } from '../_internal.js';
import { KanbanLifecycleError } from '../lifecycle-error.js';
import { hasText } from './definition-of-done.js';
import {
  isManagedTombstone,
  lifecycleStageForColumn,
  STATUS_BY_STAGE,
  validateManagedLifecyclePolicy,
} from './stage-helpers.js';

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
    if (!board.completionGate || board.completionGate.enforcement === 'off') {
      board.completionGate = { enforcement: 'strict' };
    }
    board.updatedAt = at;
    for (const task of board.tasks) {
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
    if (isManagedTombstone(board, task)) {
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
