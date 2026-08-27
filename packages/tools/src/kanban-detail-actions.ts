import type { Context } from '@wrongstack/core/agent';
import {
  addCheckToTask,
  addDependency,
  addGoalMetricToTask,
  addLinkToTask,
  addNoteToTask,
  getKanbanWorkbench,
  removeCheckFromTask,
  updateCheckOnTask,
  updateGoalMetricOnTask,
} from '@wrongstack/kanban';
import { handleSplitTask } from './kanban-split-task-handler.js';
import { fail, okBoard } from './kanban-tool-results.js';
import type { KanbanToolInput, KanbanToolOutput } from './kanban-tool-types.js';

export async function handleKanbanDetailAction(
  projectRoot: string,
  input: KanbanToolInput,
  ctx: Context,
): Promise<KanbanToolOutput | undefined> {
  const eventContext = {
    sessionId: ctx.eventSessionId(),
    ...(ctx.agentId !== undefined ? { actor: ctx.agentId } : {}),
  };
  switch (input.action) {
    case 'workbench': {
      const workbench = await getKanbanWorkbench(projectRoot, {
        ...(input.limit !== undefined
          ? { limitPerLane: input.limit, alertLimit: input.limit }
          : {}),
      });
      return {
        ok: true,
        message: `${workbench.totals.now} now, ${workbench.totals.next} next, ${workbench.totals.blocked} blocked, ${workbench.totals.review} review; ${workbench.alertTotal} alert(s).`,
        workbench,
      };
    }
    case 'add_dependency': {
      if (!input.boardId || !input.taskId || !input.dependencyTaskId) {
        return fail('add_dependency requires boardId, taskId, and dependencyTaskId.');
      }
      const board = await addDependency(
        projectRoot,
        input.boardId,
        input.taskId,
        input.dependencyTaskId,
        eventContext,
      );
      return board ? okBoard(board, 'Dependency added.') : fail('Task not found.');
    }
    case 'add_goal_metric': {
      if (!input.boardId || !input.taskId || !input.metricName) {
        return fail('add_goal_metric requires boardId, taskId, and metricName.');
      }
      const board = await addGoalMetricToTask(
        projectRoot,
        input.boardId,
        input.taskId,
        {
          name: input.metricName,
          ...(input.metricStatus !== undefined ? { status: input.metricStatus } : {}),
          ...(input.metricTarget !== undefined ? { target: input.metricTarget } : {}),
          ...(input.metricCurrent !== undefined ? { current: input.metricCurrent } : {}),
          ...(input.metricDirection !== undefined ? { direction: input.metricDirection } : {}),
          ...(input.metricUnit !== undefined ? { unit: input.metricUnit } : {}),
          ...(input.metricNotes !== undefined ? { notes: input.metricNotes } : {}),
        },
        eventContext,
      );
      return board ? okBoard(board, 'Goal metric added.') : fail('Task not found.');
    }
    case 'update_goal_metric': {
      if (!input.boardId || !input.taskId || !input.metricId) {
        return fail('update_goal_metric requires boardId, taskId, and metricId.');
      }
      const board = await updateGoalMetricOnTask(
        projectRoot,
        input.boardId,
        input.taskId,
        input.metricId,
        {
          ...(input.metricName !== undefined ? { name: input.metricName } : {}),
          ...(input.metricStatus !== undefined ? { status: input.metricStatus } : {}),
          ...(input.metricTarget !== undefined ? { target: input.metricTarget } : {}),
          ...(input.metricCurrent !== undefined ? { current: input.metricCurrent } : {}),
          ...(input.metricDirection !== undefined ? { direction: input.metricDirection } : {}),
          ...(input.metricUnit !== undefined ? { unit: input.metricUnit } : {}),
          ...(input.metricNotes !== undefined ? { notes: input.metricNotes } : {}),
        },
        eventContext,
      );
      return board ? okBoard(board, 'Goal metric updated.') : fail('Metric not found.');
    }
    case 'add_check': {
      if (!input.boardId || !input.taskId || !input.checkDescription) {
        return fail('add_check requires boardId, taskId, and checkDescription.');
      }
      // `manual` is the fallback, not the only option — see the note in
      // kanban-task-inputs.ts on why hard-coding it made every agent-authored
      // criterion unverifiable.
      const board = await addCheckToTask(
        projectRoot,
        input.boardId,
        input.taskId,
        {
          description: input.checkDescription,
          type: input.checkType ?? 'manual',
          status: input.checkStatus,
          ...(input.checkNotes !== undefined ? { notes: input.checkNotes } : {}),
        },
        eventContext,
      );
      return board ? okBoard(board, 'Check added.') : fail('Task not found.');
    }
    case 'update_check': {
      if (!input.boardId || !input.taskId || !input.checkId) {
        return fail('update_check requires boardId, taskId, and checkId.');
      }
      const board = await updateCheckOnTask(
        projectRoot,
        input.boardId,
        input.taskId,
        input.checkId,
        {
          ...(input.checkDescription !== undefined ? { description: input.checkDescription } : {}),
          ...(input.checkStatus !== undefined ? { status: input.checkStatus } : {}),
          // Promoting an existing manual criterion to an executable one is the
          // common repair: the card was written before anyone knew the command.
          ...(input.checkType !== undefined ? { type: input.checkType } : {}),
          ...(input.checkNotes !== undefined ? { notes: input.checkNotes } : {}),
        },
        eventContext,
      );
      return board ? okBoard(board, 'Check updated.') : fail('Check not found.');
    }
    case 'remove_check': {
      if (!input.boardId || !input.taskId || !input.checkId) {
        return fail('remove_check requires boardId, taskId, and checkId.');
      }
      // The truthful way out of a criterion that turned out not to apply.
      // Done refuses to advance while any criterion is not `passed`, so
      // without this the only alternatives were marking it passed — a lie —
      // or leaving the card parked forever.
      const board = await removeCheckFromTask(
        projectRoot,
        input.boardId,
        input.taskId,
        input.checkId,
        eventContext,
      );
      return board
        ? okBoard(board, 'Acceptance criterion removed.')
        : fail('Check not found on this task.');
    }
    case 'add_note': {
      if (!input.boardId || !input.taskId || !input.note)
        return fail('add_note requires boardId, taskId, and note.');
      const board = await addNoteToTask(
        projectRoot,
        input.boardId,
        input.taskId,
        {
          author: input.author ?? 'agent',
          content: input.note,
        },
        eventContext,
      );
      return board ? okBoard(board, 'Note added.') : fail('Task not found.');
    }
    case 'add_link': {
      if (!input.boardId || !input.taskId || !input.url)
        return fail('add_link requires boardId, taskId, and url.');
      const board = await addLinkToTask(
        projectRoot,
        input.boardId,
        input.taskId,
        {
          url: input.url,
          type: input.linkType ?? 'url',
          ...(input.linkTitle !== undefined ? { title: input.linkTitle } : {}),
        },
        eventContext,
      );
      return board ? okBoard(board, 'Link added.') : fail('Task not found.');
    }
    case 'split_atomic': {
      if (!input.boardId || !input.taskId || !input.childTitles?.length) {
        return fail('split_atomic requires boardId, taskId, and childTitles (at least one).');
      }
      return handleSplitTask(projectRoot, input, { atomic: true }, eventContext);
    }
    default:
      return undefined;
  }
}
