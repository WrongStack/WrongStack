import type { KanbanBoard, KanbanEventContext, KanbanTask } from '@wrongstack/kanban';
import { getBoard, splitTask } from '@wrongstack/kanban';
import { fail } from './kanban-tool-results.js';
import type { KanbanToolInput, KanbanToolOutput } from './kanban-tool-types.js';

/** Shared split handler used by both split_task and split_atomic. */
export async function handleSplitTask(
  projectRoot: string,
  input: KanbanToolInput,
  extraSplitOptions: Record<string, unknown>,
  eventContext: KanbanEventContext,
): Promise<KanbanToolOutput> {
  const boardId = input.boardId;
  const taskId = input.taskId;
  const childTitles = input.childTitles;
  if (!boardId || !taskId || !childTitles?.length) {
    return fail('split requires boardId, taskId, and at least one childTitles.');
  }
  // Destructure the optional SplitKanbanTaskInput fields from the tool input.
  // childTitles→titles and targetColumnId→columnId are the only renames.
  const {
    targetColumnId,
    inheritAssignment,
    inheritLabels,
    inheritSuccessCriteria,
    inheritGoalMetrics,
    inheritDependencies,
    chainChildren,
    rewireDependents,
  } = input;
  const result = await splitTask(
    projectRoot,
    boardId,
    taskId,
    {
      titles: childTitles,
      ...extraSplitOptions,
      ...(targetColumnId !== undefined ? { columnId: targetColumnId } : {}),
      ...(inheritAssignment !== undefined ? { inheritAssignment } : {}),
      ...(inheritLabels !== undefined ? { inheritLabels } : {}),
      ...(inheritSuccessCriteria !== undefined ? { inheritSuccessCriteria } : {}),
      ...(inheritGoalMetrics !== undefined ? { inheritGoalMetrics } : {}),
      ...(inheritDependencies !== undefined ? { inheritDependencies } : {}),
      ...(chainChildren !== undefined ? { chainChildren } : {}),
      ...(rewireDependents !== undefined ? { rewireDependents } : {}),
    },
    eventContext,
  );
  if (!result) return fail('Task not found.');
  const freshParent = result.board.tasks?.find((t: KanbanTask) => t.id === taskId);
  if (!freshParent) {
    return fail(
      `Split succeeded but parent ${taskId} not found in returned board. ` +
        `Children: [${result.children.map((c) => c.id).join(', ')}].`,
    );
  }
  return {
    ok: true,
    message: `${result.children.length} child task(s) created.`,
    board: result.board,
    task: freshParent,
    children: result.children,
  };
}

export async function requireBoard(
  projectRoot: string,
  boardId: string | undefined,
): Promise<KanbanBoard | null> {
  return boardId ? getBoard(projectRoot, boardId) : null;
}
