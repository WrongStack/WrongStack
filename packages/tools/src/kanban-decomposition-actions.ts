import type { Context } from '@wrongstack/core/agent';
import type { KanbanTask } from '@wrongstack/kanban';
import {
  assessTaskAtomicity,
  proposeTaskDecomposition,
  updateTask,
  verifyTaskCompletion,
} from '@wrongstack/kanban';
import { recordKanbanVerificationEvidence } from './kanban-evidence-bridge.js';
import { fail, okTask } from './kanban-tool-results.js';
import type { KanbanToolInput, KanbanToolOutput } from './kanban-tool-types.js';

export async function handleKanbanDecompositionAction(
  projectRoot: string,
  input: KanbanToolInput,
  ctx: Context,
): Promise<KanbanToolOutput | undefined> {
  const eventContext = {
    sessionId: ctx.eventSessionId(),
    ...(ctx.agentId !== undefined ? { actor: ctx.agentId } : {}),
  };
  switch (input.action) {
    case 'assess_atomicity': {
      if (!input.boardId || !input.taskId) {
        return fail('assess_atomicity requires boardId and taskId.');
      }
      const result = await assessTaskAtomicity(projectRoot, input.boardId, input.taskId, {
        assessedBy: 'agent',
        eventContext,
      });
      if (!result) return fail('Task not found.');
      const failing = result.assessment.criteria
        .filter((entry) => entry.score < 1)
        .map((entry) => entry.reason);
      const guidance =
        result.assessment.verdict === 'needs_decomposition'
          ? ` This task should be split before dispatch — call propose_decomposition with 2+ subtasks (each with one verifiable success criterion). Reasons: ${failing.join(' | ')}`
          : result.assessment.verdict === 'composite'
            ? ' Container task: work happens in its children; it is verified via subtask aggregation.'
            : '';
      return okTask(
        result.board,
        result.task,
        `Atomicity verdict: ${result.assessment.verdict} (score ${result.assessment.score}).${guidance}`,
      );
    }
    case 'propose_decomposition': {
      if (!input.boardId || !input.taskId || !input.subtasks?.length) {
        return fail('propose_decomposition requires boardId, taskId, and subtasks (2+).');
      }
      if (input.subtasks.length < 2) {
        return fail('propose_decomposition requires at least two subtasks.');
      }
      const invalid = input.subtasks.find(
        (subtask) => typeof subtask?.title !== 'string' || !subtask.title.trim(),
      );
      if (invalid) return fail('Every proposed subtask needs a non-blank title.');
      const result = await proposeTaskDecomposition(
        projectRoot,
        input.boardId,
        input.taskId,
        {
          subtasks: input.subtasks,
          ...(input.note !== undefined ? { rationale: input.note } : {}),
          ...(ctx.agentId !== undefined ? { proposedBy: ctx.agentId } : {}),
        },
        eventContext,
      );
      if (!result) return fail('Task not found.');
      const message =
        result.proposal.status === 'applied'
          ? `Decomposition applied: ${result.proposal.appliedChildTaskIds?.length ?? 0} child tasks created (parent marked atomic).`
          : 'Decomposition proposal recorded — awaiting approval (board policy is "propose"). It can be approved from the WebUI or via update_task.';
      return okTask(result.board, result.task, message);
    }
    case 'verify_completion': {
      if (!input.boardId || !input.taskId) {
        return fail('verify_completion requires boardId and taskId.');
      }
      const verResult = await verifyTaskCompletion(projectRoot, input.boardId, input.taskId);
      const persistedBoard = await updateTask(
        projectRoot,
        input.boardId,
        input.taskId,
        {
          verificationReport: verResult.report,
          successCriteria: verResult.task.successCriteria,
        },
        eventContext,
      );
      if (!persistedBoard) {
        return {
          ok: false,
          verdict: verResult.report.verdict,
          message:
            `Verification succeeded but persist failed: ${verResult.report.markdownSummary}. ` +
            `Board may be stale — re-run verify_completion.`,
          board: verResult.board,
        };
      }
      recordKanbanVerificationEvidence(ctx, verResult.report);
      const freshTask = persistedBoard.tasks?.find((t: KanbanTask) => t.id === input.taskId);
      const deterministicVerdicts = ['passed', 'failed', 'needs_human', 'incomplete'] as const;
      return {
        ok: deterministicVerdicts.includes(
          verResult.report.verdict as (typeof deterministicVerdicts)[number],
        ),
        verdict: verResult.report.verdict,
        message: verResult.report.markdownSummary,
        board: persistedBoard,
        task: freshTask ?? verResult.task,
      };
    }
    default:
      return undefined;
  }
}
