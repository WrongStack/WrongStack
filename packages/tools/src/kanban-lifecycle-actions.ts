import { randomUUID } from 'node:crypto';
import type { Context } from '@wrongstack/core/agent';
import {
  addTask,
  assignTask,
  claimReadyTask,
  copyTaskToBoard,
  evaluateContractGraphReadiness,
  finalizeTaskCompletion,
  getBoard,
  getTask,
  getTaskChain,
  heartbeatTaskAssignment,
  mergeTasks,
  moveTask,
  recoverStaleTaskAssignments,
  releaseTaskClaim,
  removeTask,
  repairManagedTaskProjection,
  resolveAutoAccept,
  setTaskChain,
  stripLifecycleIssues,
  transferTaskToBoard,
  transitionTask,
  updateTask,
  updateTaskAssignment,
  verifyTaskCompletion,
} from '@wrongstack/kanban';
import { recordKanbanVerificationEvidence } from './kanban-evidence-bridge.js';
import { handleSplitTask } from './kanban-split-task-handler.js';
import { assignmentInput, taskInput, taskPatch } from './kanban-task-inputs.js';
import {
  atomicityNudge,
  fail,
  okBoard,
  okTask,
  readEnvGateEnforcement,
} from './kanban-tool-results.js';
import type { KanbanToolInput, KanbanToolOutput } from './kanban-tool-types.js';
import { applySessionKanbanTaskToSource } from './session-kanban.js';

async function syncContextTask(
  ctx: Context,
  task: import('@wrongstack/kanban').KanbanTask | undefined,
  options: { remove?: boolean } = {},
): Promise<void> {
  if (!ctx?.state || !task) return;
  try {
    await applySessionKanbanTaskToSource(ctx, task, options);
  } catch {
    // best-effort sync
  }
}

export async function handleKanbanLifecycleAction(
  projectRoot: string,
  input: KanbanToolInput,
  ctx: Context,
): Promise<KanbanToolOutput | undefined> {
  const eventContext = {
    sessionId: ctx.eventSessionId(),
    ...(ctx.agentId !== undefined ? { actor: ctx.agentId } : {}),
  };
  switch (input.action) {
    case 'add_task': {
      if (!input.boardId || !input.title) return fail('add_task requires boardId and title.');
      const result = await addTask(projectRoot, input.boardId, taskInput(input), eventContext);
      if (!result) return fail('Board not found.');
      await syncContextTask(ctx, result.task);
      return okTask(result.board, result.task, `Task added.${atomicityNudge(result.task)}`);
    }
    case 'split_task': {
      if (!input.boardId || !input.taskId || !input.childTitles?.length) {
        return fail('split_task requires boardId, taskId, and childTitles.');
      }
      return handleSplitTask(projectRoot, input, {}, eventContext);
    }
    case 'merge_tasks': {
      if (!input.boardId || !input.taskIds?.length || !input.title) {
        return fail('merge_tasks requires boardId, taskIds, and title.');
      }
      const result = await mergeTasks(
        projectRoot,
        input.boardId,
        {
          taskIds: input.taskIds,
          title: input.title,
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.targetColumnId !== undefined ? { targetColumnId: input.targetColumnId } : {}),
          ...(input.preserveAssignment !== undefined
            ? { preserveAssignment: input.preserveAssignment }
            : {}),
          ...(input.closeSourceTasks !== undefined
            ? { closeSourceTasks: input.closeSourceTasks }
            : {}),
        },
        eventContext,
      );
      return result
        ? okTask(result.board, result.task, 'Tasks merged.')
        : fail('Board or task not found.');
    }
    case 'copy_task': {
      if (!input.boardId || !input.taskId || !input.targetBoardId) {
        return fail('copy_task requires boardId, taskId, and targetBoardId.');
      }
      const result = await copyTaskToBoard(
        projectRoot,
        input.boardId,
        input.taskId,
        input.targetBoardId,
        {
          ...(input.targetColumnId !== undefined ? { targetColumnId: input.targetColumnId } : {}),
          ...(input.order !== undefined ? { targetOrder: input.order } : {}),
          ...(input.preserveAssignment !== undefined
            ? { preserveAssignment: input.preserveAssignment }
            : {}),
          ...(input.preserveDependencies !== undefined
            ? { preserveDependencies: input.preserveDependencies }
            : {}),
          eventContext,
        },
      );
      return result
        ? okTask(result.targetBoard, result.task, 'Task copied to target board.')
        : fail('Board or task not found.');
    }
    case 'transfer_task': {
      if (!input.boardId || !input.taskId || !input.targetBoardId) {
        return fail('transfer_task requires boardId, taskId, and targetBoardId.');
      }
      const result = await transferTaskToBoard(
        projectRoot,
        input.boardId,
        input.taskId,
        input.targetBoardId,
        {
          ...(input.targetColumnId !== undefined ? { targetColumnId: input.targetColumnId } : {}),
          ...(input.order !== undefined ? { targetOrder: input.order } : {}),
          ...(input.preserveAssignment !== undefined
            ? { preserveAssignment: input.preserveAssignment }
            : {}),
          ...(input.preserveDependencies !== undefined
            ? { preserveDependencies: input.preserveDependencies }
            : {}),
          eventContext,
        },
      );
      return result
        ? okTask(result.targetBoard, result.task, 'Task transferred to target board.')
        : fail('Board or task not found.');
    }
    case 'get_task': {
      if (!input.boardId || !input.taskId) return fail('get_task requires boardId and taskId.');
      const task = await getTask(projectRoot, input.boardId, input.taskId);
      return task ? { ok: true, message: 'Task loaded.', task } : fail('Task not found.');
    }
    case 'start_task': {
      if (!input.boardId || !input.taskId || !input.author || !input.transitionComment) {
        return fail('start_task requires boardId, taskId, author, and transitionComment.');
      }
      let board = await getBoard(projectRoot, input.boardId);
      let task = board?.tasks.find((candidate) => candidate.id === input.taskId);
      if (!board || !task) return fail('Board or task not found.');
      const readiness = evaluateContractGraphReadiness(board, task.id);
      if (!readiness.ready) {
        return fail(
          `Task is not implementation-ready: ${readiness.issues.map((issue) => issue.message).join(' | ')}`,
        );
      }
      if (board.lifecycle?.mode !== 'managed') {
        const now = new Date();
        const assigned = await updateTaskAssignment(
          projectRoot,
          board.id,
          task.id,
          {
            status: 'running',
            agentId: input.agentId ?? input.author,
            leaseId: input.leaseId ?? randomUUID(),
            claimedAt: input.claimedAt ?? now.toISOString(),
            heartbeatAt: input.heartbeatAt ?? now.toISOString(),
            leaseExpiresAt:
              input.leaseExpiresAt ?? new Date(now.getTime() + 15 * 60_000).toISOString(),
            attempt: input.attempt ?? 1,
            maxAttempts: input.maxAttempts ?? 3,
          },
          eventContext,
        );
        if (!assigned) return fail('Task assignment could not be started.');
        const started = await updateTask(
          projectRoot,
          board.id,
          task.id,
          { status: 'in_progress' },
          eventContext,
        );
        const current = started ?? assigned;
        const claimed = task;
        const currentTask =
          current.tasks.find((candidate) => candidate.id === claimed.id) ?? claimed;
        ctx.setCurrentKanbanTask?.(currentTask.id, current.id);
        return okTask(
          current,
          currentTask,
          'Task is active and bound to this run for attribution. This board is not in managed lifecycle mode, so runtime Kanban governance was not bound to it.',
        );
      }
      let stage = task.lifecycle?.currentStage;
      if (stage === 'backlog') {
        const moved = await transitionTask(projectRoot, board.id, task.id, {
          to: 'todo',
          sessionId: eventContext.sessionId,
          actor: input.author,
          comment: input.transitionComment,
        });
        if (!moved) return fail('Task could not enter Todo.');
        board = moved.board;
        task = moved.task;
        stage = task.lifecycle?.currentStage;
      }
      if (stage === 'todo' || stage === 'review') {
        const now = new Date();
        const leaseId = input.leaseId ?? randomUUID();
        const assigned = await updateTaskAssignment(
          projectRoot,
          board.id,
          task.id,
          {
            status: 'running',
            agentId: input.agentId ?? input.author,
            leaseId,
            claimedAt: input.claimedAt ?? now.toISOString(),
            heartbeatAt: input.heartbeatAt ?? now.toISOString(),
            leaseExpiresAt:
              input.leaseExpiresAt ?? new Date(now.getTime() + 15 * 60_000).toISOString(),
            attempt: input.attempt ?? 1,
            maxAttempts: input.maxAttempts ?? 3,
          },
          eventContext,
        );
        if (!assigned) return fail('Task assignment could not be started.');
        const moved = await transitionTask(projectRoot, board.id, task.id, {
          to: 'running',
          sessionId: eventContext.sessionId,
          actor: input.author,
          comment: input.transitionComment,
        });
        if (!moved) return fail('Task could not enter Running.');
        board = moved.board;
        task = moved.task;
        stage = task.lifecycle?.currentStage;
      }
      if (stage !== 'running' || task.assignment?.status !== 'running') {
        return fail(
          `start_task only accepts Backlog, Todo, Review repair, or live Running cards (current: ${stage ?? 'unknown'}).`,
        );
      }
      ctx.setCurrentKanbanTask(task.id, board.id);
      await syncContextTask(ctx, task);
      return okTask(
        board,
        task,
        'Task is active; runtime Kanban governance is now bound to this run.',
      );
    }
    case 'update_task': {
      if (!input.boardId || !input.taskId) return fail('update_task requires boardId and taskId.');
      const board = await updateTask(
        projectRoot,
        input.boardId,
        input.taskId,
        taskPatch(input),
        eventContext,
      );
      if (board) {
        await syncContextTask(
          ctx,
          board.tasks.find((t) => t.id === input.taskId),
        );
      }
      return board ? okBoard(board, 'Task updated.') : fail('Task not found.');
    }
    case 'transition_task': {
      if (
        !input.boardId ||
        !input.taskId ||
        !input.lifecycleStage ||
        !input.author ||
        !input.transitionComment
      ) {
        return fail(
          'transition_task requires boardId, taskId, lifecycleStage, author, and transitionComment.',
        );
      }
      if (input.lifecycleStage === 'done') {
        const boardBefore = await getBoard(projectRoot, input.boardId);
        const taskBefore = boardBefore
          ? await getTask(projectRoot, input.boardId, input.taskId)
          : null;
        if (
          boardBefore &&
          taskBefore &&
          !taskBefore.verificationReport &&
          (taskBefore.atomic || Boolean(taskBefore.successCriteria?.length))
        ) {
          const preGate = await verifyTaskCompletion(projectRoot, input.boardId, taskBefore.id, {
            persist: false,
          });
          await updateTask(
            projectRoot,
            input.boardId,
            taskBefore.id,
            {
              verificationReport: preGate.report,
              successCriteria: preGate.task.successCriteria,
            },
            eventContext,
          );
        }
      }
      const result = await transitionTask(projectRoot, input.boardId, input.taskId, {
        to: input.lifecycleStage,
        sessionId: eventContext.sessionId,
        actor: input.author,
        comment: input.transitionComment,
        ...(input.transitionAction !== undefined ? { action: input.transitionAction } : {}),
        ...(input.tickChecks !== undefined ? { tickChecks: input.tickChecks } : {}),
        ...(input.attachmentUrl !== undefined
          ? {
              attachment: {
                url: input.attachmentUrl,
                type: input.attachmentType ?? 'url',
                ...(input.attachmentTitle !== undefined ? { title: input.attachmentTitle } : {}),
              },
            }
          : {}),
        patch: taskPatch(input),
      });
      if (result && input.lifecycleStage === 'done' && result.task.verificationReport) {
        recordKanbanVerificationEvidence(ctx, result.task.verificationReport);
      }
      if (result?.task) {
        await syncContextTask(ctx, result.task);
      }
      return result
        ? okTask(result.board, result.task, `Task advanced to ${result.transition.to}.`)
        : fail('Board or task not found.');
    }
    case 'repair_managed_projection': {
      if (!input.boardId || !input.taskId || !input.author || !input.transitionComment) {
        return fail(
          'repair_managed_projection requires boardId, taskId, author, and transitionComment.',
        );
      }
      const result = await repairManagedTaskProjection(projectRoot, input.boardId, input.taskId, {
        actor: input.author,
        comment: input.transitionComment,
      });
      if (result?.task) {
        await syncContextTask(ctx, result.task);
      }
      return result
        ? okTask(
            result.board,
            result.task,
            'Managed card projection repaired from lifecycle history.',
          )
        : fail('Board or task not found.');
    }
    case 'move_task': {
      if (!input.boardId || !input.taskId || !input.targetColumnId) {
        return fail('move_task requires boardId, taskId, and targetColumnId.');
      }
      const board = await moveTask(
        projectRoot,
        input.boardId,
        input.taskId,
        input.targetColumnId,
        input.order,
        eventContext,
      );
      if (board) {
        await syncContextTask(
          ctx,
          board.tasks.find((t) => t.id === input.taskId),
        );
      }
      return board ? okBoard(board, 'Task moved.') : fail('Move failed.');
    }
    case 'delete_task': {
      if (!input.boardId || !input.taskId) return fail('delete_task requires boardId and taskId.');
      const boardBefore = await getBoard(projectRoot, input.boardId);
      const taskToDelete = boardBefore?.tasks.find((t) => t.id === input.taskId);
      const board = await removeTask(projectRoot, input.boardId, input.taskId, eventContext);
      if (board && ctx.currentKanbanTaskId === input.taskId) {
        ctx.setCurrentKanbanTask?.(undefined, ctx.currentKanbanBoardId);
      }
      if (board && taskToDelete) {
        await syncContextTask(ctx, taskToDelete, { remove: true });
      }
      return board ? okBoard(board, 'Task deleted.') : fail('Task not found.');
    }
    case 'set_chain': {
      if (!input.boardId || !input.taskIds?.length) {
        return fail('set_chain requires boardId and taskIds.');
      }
      const result = await setTaskChain(
        projectRoot,
        input.boardId,
        {
          taskIds: input.taskIds,
          ...(input.chainId !== undefined ? { chainId: input.chainId } : {}),
          ...(input.enforceDependencies !== undefined
            ? { enforceDependencies: input.enforceDependencies }
            : {}),
        },
        eventContext,
      );
      return result
        ? {
            ok: true,
            message: `Chain set: ${result.chainId}`,
            board: result.board,
            chain: result.tasks,
          }
        : fail('Board or task not found.');
    }
    case 'get_chain': {
      if (!input.boardId || !(input.taskId || input.chainId)) {
        return fail('get_chain requires boardId and taskId or chainId.');
      }
      const result = await getTaskChain(
        projectRoot,
        input.boardId,
        input.taskId ?? input.chainId ?? '',
      );
      return result
        ? {
            ok: true,
            message: `Chain loaded: ${result.chainId}`,
            board: result.board,
            chain: result.tasks,
          }
        : fail('Chain not found.');
    }
    case 'claim_task': {
      const result = await claimReadyTask(
        projectRoot,
        {
          ...(input.boardId !== undefined ? { boardId: input.boardId } : {}),
          ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
          ...assignmentInput(input),
          status: input.assignmentStatus ?? 'queued',
        },
        eventContext,
      );
      return result
        ? okTask(result.board, result.task, 'Task claimed.')
        : fail('No ready kanban task matched the claim.');
    }
    case 'release_task': {
      if (!input.boardId || !input.taskId) {
        return fail('release_task requires boardId and taskId.');
      }
      const board = await releaseTaskClaim(
        projectRoot,
        input.boardId,
        input.taskId,
        {
          ...(input.releaseStatus !== undefined ? { status: input.releaseStatus } : {}),
          ...(input.releaseReason !== undefined ? { reason: input.releaseReason } : {}),
          ...(input.clearAssignee !== undefined ? { clearAssignee: input.clearAssignee } : {}),
        },
        eventContext,
      );
      return board ? okBoard(board, 'Task claim released.') : fail('Task not found.');
    }
    case 'assign_task': {
      if (!input.boardId || !input.taskId) return fail('assign_task requires boardId and taskId.');
      const board = await assignTask(
        projectRoot,
        input.boardId,
        input.taskId,
        assignmentInput(input),
        eventContext,
      );
      return board ? okBoard(board, 'Task assigned.') : fail('Task not found.');
    }
    case 'mark_assignment': {
      if (!input.boardId || !input.taskId)
        return fail('mark_assignment requires boardId and taskId.');
      const assignmentStatus =
        input.assignmentStatus ??
        (input.status === 'completed' ? 'completed' : input.error ? 'failed' : undefined);
      const board = await updateTaskAssignment(
        projectRoot,
        input.boardId,
        input.taskId,
        {
          ...(assignmentStatus !== undefined ? { status: assignmentStatus } : {}),
          ...(input.subagentId !== undefined ? { subagentId: input.subagentId } : {}),
          ...(input.runTaskId !== undefined ? { runTaskId: input.runTaskId } : {}),
          ...(input.lastResult !== undefined ? { lastResult: input.lastResult } : {}),
          ...(input.error !== undefined ? { error: input.error } : {}),
          ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
          ...(input.leaseId !== undefined ? { leaseId: input.leaseId } : {}),
          ...(input.claimedAt !== undefined ? { claimedAt: input.claimedAt } : {}),
          ...(input.heartbeatAt !== undefined ? { heartbeatAt: input.heartbeatAt } : {}),
          ...(input.leaseExpiresAt !== undefined ? { leaseExpiresAt: input.leaseExpiresAt } : {}),
          ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
          ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
        },
        {
          ...eventContext,
          ...(input.expectedLeaseId !== undefined
            ? { expectedLeaseId: input.expectedLeaseId }
            : {}),
        },
      );
      if (!board) return fail('Task not found.');

      if (assignmentStatus === 'completed' && board.lifecycle?.mode !== 'managed') {
        const envGate = readEnvGateEnforcement();
        const finalized = await finalizeTaskCompletion(projectRoot, board.id, input.taskId, {
          ...(board.completionGate === undefined && envGate !== undefined
            ? { enforcement: envGate }
            : {}),
          eventContext,
        });
        if (finalized) {
          if (finalized.gate.report) {
            recordKanbanVerificationEvidence(ctx, finalized.gate.report);
          }
          const gateSummary = {
            enforcement: finalized.gate.enforcement,
            allowed: finalized.gate.allowed,
            verdict: finalized.gate.verdict,
            issues: finalized.gate.issues.map((issue) => issue.message),
          };
          const gateMessage = finalized.gate.allowed
            ? `Completion gate ${finalized.gate.verdict === 'skipped' ? 'passed' : 'passed'}; task completed.`
            : finalized.gate.enforcement === 'strict'
              ? `Completion gate BLOCKED (verdict: ${finalized.gate.verdict}); task parked in review. Issues: ${gateSummary.issues.join(' | ')}`
              : `Completion gate failed softly (verdict: ${finalized.gate.verdict}); task completed with warnings. Issues: ${gateSummary.issues.join(' | ')}`;
          await syncContextTask(ctx, finalized.task);
          return {
            ...okTask(finalized.board, finalized.task, `Assignment updated. ${gateMessage}`),
            gate: gateSummary,
          };
        }
      } else if (board.lifecycle?.mode === 'managed') {
        const managedTask = board.tasks.find((candidate) => candidate.id === input.taskId);
        const stage = managedTask?.lifecycle?.currentStage;
        const actor = ctx.agentId ?? 'kanban-agent';
        let transitionResult: Awaited<ReturnType<typeof transitionTask>> = null;
        const lifecycleWarnings: string[] = [];

        if (assignmentStatus === 'running' && stage === 'todo') {
          try {
            transitionResult = await transitionTask(projectRoot, board.id, input.taskId, {
              to: 'running',
              sessionId: eventContext.sessionId,
              actor,
              comment: 'Work started.',
            });
          } catch (err: unknown) {
            lifecycleWarnings.push(
              `Lifecycle transition to Running deferred: ${stripLifecycleIssues(err instanceof Error ? err.message : String(err))}`,
            );
          }
        }
        if (assignmentStatus === 'completed' && stage === 'running') {
          const comment =
            typeof input.lastResult === 'string' && input.lastResult.trim().length > 0
              ? input.lastResult.trim().slice(0, 1000)
              : 'Work completed.';
          try {
            transitionResult = await transitionTask(projectRoot, board.id, input.taskId, {
              to: 'review',
              sessionId: eventContext.sessionId,
              actor,
              comment,
              attachment: {
                url: `kanban://task/${input.taskId}/result`,
                title: 'Worker completion result',
                type: 'file',
              },
              patch: {
                ...(input.agentId !== undefined ? { assignedAgent: input.agentId } : {}),
              },
            });
          } catch (err: unknown) {
            lifecycleWarnings.push(
              `Lifecycle transition to Review failed: ${stripLifecycleIssues(err instanceof Error ? err.message : String(err))}`,
            );
          }

          if (transitionResult) {
            const hasCriteria =
              (transitionResult.task.successCriteria?.length ?? 0) > 0 ||
              transitionResult.task.atomic === true;

            if (hasCriteria) {
              try {
                const verResult = await verifyTaskCompletion(projectRoot, board.id, input.taskId);
                if (verResult.report) {
                  recordKanbanVerificationEvidence(ctx, verResult.report);
                }
                await updateTask(
                  projectRoot,
                  board.id,
                  input.taskId,
                  {
                    verificationReport: verResult.report,
                    successCriteria: verResult.task.successCriteria,
                  },
                  eventContext,
                );

                const verdict = verResult.report.verdict;
                if (verdict === 'passed' && !resolveAutoAccept(board)) {
                  lifecycleWarnings.push(
                    'Verification passed, but this board does not auto-accept. ' +
                      'The card is in Review awaiting an explicit transition_task to done.',
                  );
                } else if (verdict === 'passed') {
                  try {
                    const doneResult = await transitionTask(projectRoot, board.id, input.taskId, {
                      to: 'done',
                      sessionId: eventContext.sessionId,
                      actor,
                      action: 'Automated acceptance after verification',
                      comment: 'Auto-accepted: verification passed.',
                      attachment: {
                        url: `kanban://task/${input.taskId}/verification`,
                        title: 'Auto-verification result',
                        type: 'file',
                      },
                    });
                    transitionResult = doneResult;
                  } catch (acceptErr: unknown) {
                    lifecycleWarnings.push(
                      `Auto-accept to Done deferred: ${acceptErr instanceof Error ? acceptErr.message : String(acceptErr)}`,
                    );
                  }
                } else {
                  lifecycleWarnings.push(
                    `Verification verdict: ${verdict} — card left in Review for manual acceptance.`,
                  );
                }
              } catch (verifyErr: unknown) {
                lifecycleWarnings.push(
                  `Auto-verification error: ${verifyErr instanceof Error ? verifyErr.message : String(verifyErr)}`,
                );
              }
            } else {
              lifecycleWarnings.push(
                'No automatic success criteria — card left in Review for manual verification.',
              );
            }
          }
        }

        const responseBoard = transitionResult?.board ?? board;
        const responseTask = transitionResult?.task ?? managedTask!;
        const msgParts = ['Assignment updated.'];
        if (transitionResult) {
          msgParts.push(`Card advanced to ${transitionResult.transition.to}.`);
        }
        for (const w of lifecycleWarnings) msgParts.push(`Warning: ${w}`);
        await syncContextTask(ctx, responseTask);
        return okTask(responseBoard, responseTask, msgParts.join(' '));
      }
      return okBoard(board, 'Assignment updated.');
    }
    case 'heartbeat_assignment': {
      if (!input.boardId || !input.taskId) {
        return fail('heartbeat_assignment requires boardId and taskId.');
      }
      const board = await heartbeatTaskAssignment(
        projectRoot,
        input.boardId,
        input.taskId,
        {
          ...(input.heartbeatAt !== undefined ? { heartbeatAt: input.heartbeatAt } : {}),
          ...(input.leaseExpiresAt !== undefined ? { leaseExpiresAt: input.leaseExpiresAt } : {}),
          ...(input.expectedLeaseId !== undefined
            ? { expectedLeaseId: input.expectedLeaseId }
            : {}),
        },
        eventContext,
      );
      return board
        ? okBoard(board, 'Assignment heartbeat updated.')
        : fail('Task assignment not found.');
    }
    case 'recover_stale': {
      if (!input.boardId) return fail('recover_stale requires boardId.');
      const policyFields = [
        input.recoveryPolicyFailOnCostCeiling !== undefined,
        input.recoveryPolicyReleaseOnFailureKinds !== undefined,
        input.recoveryPolicyReleaseOnHeartbeatDue !== undefined,
        input.recoveryPolicyRetryPolicyOverride !== undefined,
      ].some(Boolean);
      const result = await recoverStaleTaskAssignments(
        projectRoot,
        input.boardId,
        {
          ...(input.recoveryMode !== undefined ? { mode: input.recoveryMode } : {}),
          ...(input.recoveryNow !== undefined ? { now: input.recoveryNow } : {}),
          ...(input.releaseReason !== undefined ? { reason: input.releaseReason } : {}),
          ...(input.clearAssignee !== undefined ? { clearAssignee: input.clearAssignee } : {}),
          ...(policyFields
            ? {
                policy: {
                  ...(input.recoveryPolicyFailOnCostCeiling !== undefined
                    ? { failWhenCostCeilingSet: input.recoveryPolicyFailOnCostCeiling }
                    : {}),
                  ...(input.recoveryPolicyReleaseOnFailureKinds !== undefined
                    ? {
                        releaseOnFailureKinds: input.recoveryPolicyReleaseOnFailureKinds,
                      }
                    : {}),
                  ...(input.recoveryPolicyReleaseOnHeartbeatDue !== undefined
                    ? {
                        releaseOnHeartbeatDue: input.recoveryPolicyReleaseOnHeartbeatDue,
                      }
                    : {}),
                  ...(input.recoveryPolicyRetryPolicyOverride !== undefined
                    ? {
                        retryPolicyOverride: input.recoveryPolicyRetryPolicyOverride,
                      }
                    : {}),
                },
              }
            : {}),
        },
        eventContext,
      );
      return result
        ? {
            ok: true,
            message: `Recovered ${result.tasks.length} stale assignment(s).`,
            board: result.board,
            recoveredTasks: result.tasks,
          }
        : { ok: true, message: 'No stale assignment matched.', recoveredTasks: [] };
    }
    default:
      return undefined;
  }
}
