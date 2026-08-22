/**
 * Explicit atomicity assessment surface: re-scores a task on demand, persists
 * the result, and emits a durable `task.atomicity.assessed` board event.
 * Automatic stamping at creation/split time lives in _internal.stampAtomicityAssessment.
 */

import { assessAtomicity, candidateFromKanbanTask } from '../atomicity/assess.js';
import { mutateBoard } from '../storage.js';
import type {
  AtomicityRuleSetConfig,
  KanbanAtomicityAssessment,
  KanbanBoard,
  KanbanEvent,
  KanbanEventContext,
  KanbanTask,
} from '../types.js';
import { createKanbanEvent, emitKanbanEvent, findTask, nowIso } from './_internal.js';

export interface AssessTaskAtomicityOptions {
  /** Overrides the board policy's rule-set config for this run only. */
  config?: AtomicityRuleSetConfig | undefined;
  assessedBy?: KanbanAtomicityAssessment['assessedBy'] | undefined;
  eventContext?: KanbanEventContext | undefined;
}

export async function assessTaskAtomicity(
  projectRoot: string,
  boardId: string,
  taskId: string,
  options: AssessTaskAtomicityOptions = {},
): Promise<{
  board: KanbanBoard;
  task: KanbanTask;
  assessment: KanbanAtomicityAssessment;
} | null> {
  let event: KanbanEvent | undefined;
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    if (!task) return null;
    const assessment = assessAtomicity(
      candidateFromKanbanTask(task),
      options.config ?? board.atomicity?.config,
      { assessedBy: options.assessedBy },
    );
    task.atomicityAssessment = assessment;
    task.updatedAt = nowIso();
    board.updatedAt = task.updatedAt;
    event = createKanbanEvent(board.id, task, 'task.atomicity.assessed', {
      ...options.eventContext,
      after: {
        verdict: assessment.verdict,
        score: assessment.score,
        criteria: assessment.criteria.map((entry) => ({
          id: entry.id,
          score: entry.score,
          reason: entry.reason,
        })),
      },
    });
    return { task, assessment };
  });
  if (updated?.result && event) await emitKanbanEvent(projectRoot, event);
  return updated?.result
    ? { board: updated.board, task: updated.result.task, assessment: updated.result.assessment }
    : null;
}
