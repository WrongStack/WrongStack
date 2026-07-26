import {
  addCheckToTask,
  addDependency,
  addGoalMetricToTask,
  addLinkToTask,
  addNoteToTask,
  updateCheckOnTask,
  updateGoalMetricOnTask,
} from '@wrongstack/kanban';
import { fail, okBoard } from './kanban-tool-results.js';
import { handleSplitTask } from './kanban-split-task-handler.js';
import type { KanbanToolInput, KanbanToolOutput } from './kanban-tool-types.js';

export async function handleKanbanDetailAction(
  projectRoot: string,
  input: KanbanToolInput,
): Promise<KanbanToolOutput | undefined> {
  switch (input.action) {
    case 'add_dependency': {
      if (!input.boardId || !input.taskId || !input.dependencyTaskId) {
        return fail('add_dependency requires boardId, taskId, and dependencyTaskId.');
      }
      const board = await addDependency(
        projectRoot,
        input.boardId,
        input.taskId,
        input.dependencyTaskId,
      );
      return board ? okBoard(board, 'Dependency added.') : fail('Task not found.');
    }
    case 'add_goal_metric': {
      if (!input.boardId || !input.taskId || !input.metricName) {
        return fail('add_goal_metric requires boardId, taskId, and metricName.');
      }
      const board = await addGoalMetricToTask(projectRoot, input.boardId, input.taskId, {
        name: input.metricName,
        ...(input.metricStatus !== undefined ? { status: input.metricStatus } : {}),
        ...(input.metricTarget !== undefined ? { target: input.metricTarget } : {}),
        ...(input.metricCurrent !== undefined ? { current: input.metricCurrent } : {}),
        ...(input.metricUnit !== undefined ? { unit: input.metricUnit } : {}),
        ...(input.metricNotes !== undefined ? { notes: input.metricNotes } : {}),
      });
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
          ...(input.metricUnit !== undefined ? { unit: input.metricUnit } : {}),
          ...(input.metricNotes !== undefined ? { notes: input.metricNotes } : {}),
        },
      );
      return board ? okBoard(board, 'Goal metric updated.') : fail('Metric not found.');
    }
    case 'add_check': {
      if (!input.boardId || !input.taskId || !input.checkDescription) {
        return fail('add_check requires boardId, taskId, and checkDescription.');
      }
      const board = await addCheckToTask(projectRoot, input.boardId, input.taskId, {
        description: input.checkDescription,
        type: 'manual',
        status: input.checkStatus,
      });
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
        },
      );
      return board ? okBoard(board, 'Check updated.') : fail('Check not found.');
    }
    case 'add_note': {
      if (!input.boardId || !input.taskId || !input.note)
        return fail('add_note requires boardId, taskId, and note.');
      const board = await addNoteToTask(projectRoot, input.boardId, input.taskId, {
        author: input.author ?? 'agent',
        content: input.note,
      });
      return board ? okBoard(board, 'Note added.') : fail('Task not found.');
    }
    case 'add_link': {
      if (!input.boardId || !input.taskId || !input.url)
        return fail('add_link requires boardId, taskId, and url.');
      const board = await addLinkToTask(projectRoot, input.boardId, input.taskId, {
        url: input.url,
        type: input.linkType ?? 'url',
        ...(input.linkTitle !== undefined ? { title: input.linkTitle } : {}),
      });
      return board ? okBoard(board, 'Link added.') : fail('Task not found.');
    }
    case 'split_atomic': {
      if (!input.boardId || !input.taskId || !input.childTitles?.length) {
        return fail('split_atomic requires boardId, taskId, and childTitles (at least one).');
      }
      return handleSplitTask(projectRoot, input, { atomic: true });
    }
    default:
      return undefined;
  }
}
