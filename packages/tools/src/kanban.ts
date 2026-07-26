// Kanban data model + manager moved from @wrongstack/core to the standalone
// @wrongstack/kanban package; only the Tool contract and the task-graph
// serialization types still come from core.
import { deserializeTaskGraph, serializeTaskGraph } from '@wrongstack/core/tasking';
import type { SerializableTaskGraph, Tool } from '@wrongstack/core/types';
import { loadTasks } from '@wrongstack/core/storage';
import type { KanbanBoard, KanbanTask } from '@wrongstack/kanban';
import {
  addCheckToTask,
  addColumn,
  addDependency,
  addGoalMetricToTask,
  addLinkToTask,
  addNoteToTask,
  addTask,
  assignTask,
  claimReadyTask,
  copyTaskToBoard,
  createBoard,
  createBoardFromTaskGraph,
  duplicateBoard,
  exportBoardAsMarkdown,
  exportBoardToTaskGraph,
  createBoardFromText,
  getBoard,
  getKanbanOrchestrationSnapshot,
  getKanbanQueueHealth,
  getTask,
  getTaskChain,
  heartbeatTaskAssignment,
  listBoards,
  listKanbanEvents,
  listReadyTasks,
  mergeTasks,
  moveTask,
  parseLinesIntoTasks,
  recoverStaleTaskAssignments,
  releaseTaskClaim,
  removeBoard,
  removeColumn,
  removeTask,
  searchKanban,
  setTaskChain,
  splitTask,
  syncBoardFromTaskGraph,
  transitionTask,
  transferTaskToBoard,
  touchKanbanPresence,
  updateBoard,
  updateCheckOnTask,
  updateColumn,
  updateGoalMetricOnTask,
  updateTask,
  updateTaskAssignment,
  verifyTaskCompletion,
  finalizeTaskCompletion,
  assessTaskAtomicity,
  proposeTaskDecomposition,
} from '@wrongstack/kanban';
import { recordKanbanVerificationEvidence } from './kanban-evidence-bridge.js';
import {
  atomicityNudge,
  fail,
  okBoard,
  okTask,
  readEnvGateEnforcement,
} from './kanban-tool-results.js';
import { assignmentInput, taskInput, taskPatch } from './kanban-task-inputs.js';
import {
  KANBAN_INPUT_SCHEMA,
  KANBAN_TOOL_DESCRIPTION,
  KANBAN_TOOL_USAGE_HINT,
} from './kanban-tool-schema.js';
import type { KanbanToolInput, KanbanToolOutput } from './kanban-tool-types.js';
import { taskFileToSerializedGraph } from './session-kanban.js';

export const kanbanTool: Tool<KanbanToolInput, KanbanToolOutput> = {
  name: 'kanban',
  category: 'Project',
  description: KANBAN_TOOL_DESCRIPTION,
  usageHint: KANBAN_TOOL_USAGE_HINT,
  permission: 'confirm',
  mutating: true,
  capabilities: ['fs.write'],
  icon: 'task',
  timeoutMs: 5_000,
  inputSchema: KANBAN_INPUT_SCHEMA,
  async execute(input, ctx) {
    const projectRoot = ctx.projectRoot;
    if (!projectRoot) return fail('No project root is available.');

    const withPresence = async (result: KanbanToolOutput): Promise<KanbanToolOutput> => {
      const boardId = result.board?.id ?? input.boardId;
      if (!result.ok || !boardId || !ctx.session?.id || !ctx.agentId) return result;
      try {
        const board = await touchKanbanPresence(projectRoot, boardId, {
          sessionId: ctx.session.id,
          agentId: ctx.agentId,
          agentName: ctx.agentName,
          taskId: input.taskId ?? result.task?.id,
          runTaskId: input.runTaskId,
        });
        return board ? { ...result, board } : result;
      } catch {
        // Presence is observational. A failed heartbeat must not turn a
        // successful board mutation into an apparent task failure.
        return result;
      }
    };

    try {
      const result = await (async (): Promise<KanbanToolOutput> => {
        switch (input.action) {
        case 'list_boards': {
          const boards = await listBoards(projectRoot);
          return { ok: true, message: `${boards.length} board(s).`, boards };
        }
        case 'get_board': {
          const board = await requireBoard(projectRoot, input.boardId);
          return board ? okBoard(board) : fail('Board not found.');
        }
        case 'create_board': {
          if (!input.title) return fail('create_board requires title.');
          const board = await createBoard(projectRoot, {
            title: input.title,
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.tags !== undefined ? { tags: input.tags } : {}),
            ...(input.generatedBy !== undefined ? { generatedBy: input.generatedBy } : {}),
            ...(input.atomicityMode !== undefined
              ? {
                  atomicity: {
                    mode: input.atomicityMode,
                    decomposition: input.atomicityDecomposition ?? 'propose',
                  },
                }
              : {}),
            ...(input.gateEnforcement !== undefined
              ? { completionGate: { enforcement: input.gateEnforcement } }
              : {}),
          });
          return { ok: true, message: `Board created: ${board.title}`, board };
        }
        case 'update_board': {
          if (!input.boardId) return fail('update_board requires boardId.');
          const board = await updateBoard(projectRoot, input.boardId, {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.tags !== undefined ? { tags: input.tags } : {}),
            ...(input.atomicityMode !== undefined
              ? {
                  atomicity: {
                    mode: input.atomicityMode,
                    decomposition: input.atomicityDecomposition ?? 'propose',
                  },
                }
              : {}),
            ...(input.gateEnforcement !== undefined
              ? { completionGate: { enforcement: input.gateEnforcement } }
              : {}),
          });
          return board ? okBoard(board, 'Board updated.') : fail('Board not found.');
        }
        case 'duplicate_board': {
          if (!input.boardId) return fail('duplicate_board requires boardId.');
          const board = await duplicateBoard(projectRoot, input.boardId, {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.generatedBy !== undefined ? { generatedBy: input.generatedBy } : {}),
            ...(input.includeTasks !== undefined ? { includeTasks: input.includeTasks } : {}),
            ...(input.includeCompletedTasks !== undefined
              ? { includeCompletedTasks: input.includeCompletedTasks }
              : {}),
            ...(input.preserveAssignment !== undefined
              ? { preserveAssignment: input.preserveAssignment }
              : {}),
          });
          return board ? okBoard(board, 'Board duplicated.') : fail('Board not found.');
        }
        case 'delete_board': {
          if (!input.boardId) return fail('delete_board requires boardId.');
          const removed = await removeBoard(projectRoot, input.boardId);
          return { ok: removed, message: removed ? 'Board deleted.' : 'Board not found.' };
        }
        case 'generate_board': {
          if (!input.description) return fail('generate_board requires description.');
          const boardInput = createBoardFromText({
            description: input.description,
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.context !== undefined ? { context: input.context } : {}),
            ...(input.columns !== undefined ? { columns: input.columns } : {}),
          });
          const board = await createBoard(projectRoot, boardInput);
          for (const taskInput of parseLinesIntoTasks(
            input.description,
            board.columns[0]?.id ?? 'backlog',
          )) {
            await addTask(projectRoot, board.id, taskInput);
          }
          return okBoard((await getBoard(projectRoot, board.id)) ?? board, 'Board generated.');
        }
        case 'export_markdown': {
          const board = await requireBoard(projectRoot, input.boardId);
          if (!board) return fail('Board not found.');
          return {
            ok: true,
            message: 'Board exported.',
            board,
            markdown: exportBoardAsMarkdown(board),
          };
        }
        case 'export_task_graph': {
          if (!input.boardId) return fail('export_task_graph requires boardId.');
          const exported = await exportBoardToTaskGraph(projectRoot, input.boardId, {
            ...(input.graphId !== undefined ? { graphId: input.graphId } : {}),
            ...(input.specId !== undefined ? { specId: input.specId } : {}),
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.preserveOriginTaskIds !== undefined
              ? { preserveOriginTaskIds: input.preserveOriginTaskIds }
              : {}),
            ...(input.includeArchived !== undefined
              ? { includeArchived: input.includeArchived }
              : {}),
          });
          if (!exported) return fail('Board not found.');
          return {
            ok: true,
            message: `Task graph exported with ${exported.graph.nodes.size} node(s).`,
            board: exported.board,
            taskGraph: serializeTaskGraph(exported.graph),
          };
        }
        case 'sync_task_graph': {
          if (!input.boardId || !input.taskGraph) {
            return fail('sync_task_graph requires boardId and taskGraph.');
          }
          const graph = deserializeTaskGraph(input.taskGraph as SerializableTaskGraph);
          const result = await syncBoardFromTaskGraph(projectRoot, input.boardId, graph, {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.tags !== undefined ? { tags: input.tags } : {}),
            ...(input.generatedBy !== undefined ? { generatedBy: input.generatedBy } : {}),
            ...(input.sourceSystem !== undefined ? { sourceSystem: input.sourceSystem } : {}),
            ...(input.phaseId !== undefined ? { phaseId: input.phaseId } : {}),
            ...(input.includeCompletedTasks !== undefined
              ? { includeCompletedTasks: input.includeCompletedTasks }
              : {}),
            ...(input.archiveMissingTasks !== undefined
              ? { archiveMissingTasks: input.archiveMissingTasks }
              : {}),
            ...(input.preserveManualDependencies !== undefined
              ? { preserveManualDependencies: input.preserveManualDependencies }
              : {}),
          });
          return result
            ? {
                ok: true,
                message: `Task graph synced: ${result.createdTaskIds.length} created, ${result.updatedTaskIds.length} updated, ${result.archivedTaskIds.length} archived.`,
                board: result.board,
              }
            : fail('Board not found.');
        }
        case 'create_from_graph': {
          if (!input.taskGraph) return fail('create_from_graph requires taskGraph.');
          const graph = deserializeTaskGraph(input.taskGraph as SerializableTaskGraph);
          const { board } = await createBoardFromTaskGraph(projectRoot, graph, {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.tags !== undefined ? { tags: input.tags } : {}),
            ...(input.generatedBy !== undefined ? { generatedBy: input.generatedBy } : {}),
            ...(input.sourceSystem !== undefined ? { sourceSystem: input.sourceSystem } : {}),
            ...(input.phaseId !== undefined ? { phaseId: input.phaseId } : {}),
            ...(input.includeCompletedTasks !== undefined
              ? { includeCompletedTasks: input.includeCompletedTasks }
              : {}),
          });
          return {
            ok: true,
            message: `Created board "${board.title}" from task graph with ${board.tasks.length} tasks.`,
            board,
          };
        }
        case 'import_session_tasks': {
          // One-way projection: mirror this session's `.tasks.json` (the `task`
          // tool's list) into a kanban board so session work shows up on a board
          // without swapping the task tool's storage. Origin-keyed + re-runnable.
          const taskPath = (ctx.meta as Record<string, unknown>)?.['task.path'] as
            | string
            | undefined;
          if (!taskPath) return fail('No session task file for this session.');
          const file = await loadTasks(taskPath);
          if (!file || file.tasks.length === 0) return fail('No session tasks to import.');
          const sessionId = ctx.session?.id ?? file.sessionId ?? 'session';
          const graph = deserializeTaskGraph(taskFileToSerializedGraph(file.tasks, sessionId));
          const tags = ['session', `session:${sessionId}`];
          const existing = (await listBoards(projectRoot)).find((b) =>
            b.tags?.includes(`session:${sessionId}`),
          );
          if (existing) {
            const result = await syncBoardFromTaskGraph(projectRoot, existing.id, graph, {
              sourceSystem: 'session',
              tags,
              archiveMissingTasks: true,
              includeCompletedTasks: true,
            });
            return result
              ? {
                  ok: true,
                  message: `Synced ${file.tasks.length} session tasks into board "${result.board.title}".`,
                  board: result.board,
                }
              : fail('Session board vanished mid-sync.');
          }
          const { board } = await createBoardFromTaskGraph(projectRoot, graph, {
            title: `Session tasks (${sessionId.slice(0, 8)})`,
            sourceSystem: 'session',
            tags,
          });
          return {
            ok: true,
            message: `Imported ${file.tasks.length} session tasks into new board "${board.title}".`,
            board,
          };
        }
        case 'search_tasks': {
          const tasks = await searchKanban(projectRoot, {
            query: input.query,
            boardId: input.boardId,
            assignedAgent: input.agentId,
            status: input.status,
            priority: input.priority,
            label: input.labels?.[0],
            chainId: input.chainId,
          });
          return { ok: true, message: `${tasks.length} task(s) matched.`, tasks };
        }
        case 'ready_tasks': {
          const tasks = await listReadyTasks(projectRoot, {
            query: input.query,
            boardId: input.boardId,
            assignedAgent: input.agentId,
            priority: input.priority,
            label: input.labels?.[0],
            chainId: input.chainId,
            limit: input.limit,
          });
          return { ok: true, message: `${tasks.length} ready task(s).`, tasks };
        }
        case 'snapshot': {
          const snapshot = await getKanbanOrchestrationSnapshot(projectRoot, {
            query: input.query,
            boardId: input.boardId,
            assignedAgent: input.agentId,
            status: input.status,
            priority: input.priority,
            label: input.labels?.[0],
            chainId: input.chainId,
          });
          return {
            ok: true,
            message: `${snapshot.ready.length} ready, ${snapshot.running.length} running, ${snapshot.blocked.length} blocked.`,
            snapshot,
          };
        }
        case 'add_column': {
          if (!input.boardId || !input.title) return fail('add_column requires boardId and title.');
          const result = await addColumn(projectRoot, input.boardId, {
            title: input.title,
            ...(input.description !== undefined ? { description: input.description } : {}),
          });
          return result ? okBoard(result.board, 'Column added.') : fail('Board not found.');
        }
        case 'update_column': {
          if (!input.boardId || !input.columnId)
            return fail('update_column requires boardId and columnId.');
          const board = await updateColumn(projectRoot, input.boardId, input.columnId, {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.order !== undefined ? { order: input.order } : {}),
          });
          return board ? okBoard(board, 'Column updated.') : fail('Column not found.');
        }
        case 'delete_column': {
          if (!input.boardId || !input.columnId)
            return fail('delete_column requires boardId and columnId.');
          const board = await removeColumn(projectRoot, input.boardId, input.columnId, {
            moveTasksToColumnId: input.moveTasksToColumnId,
          });
          return board ? okBoard(board, 'Column deleted.') : fail('Column not found.');
        }
        case 'add_task': {
          if (!input.boardId || !input.title) return fail('add_task requires boardId and title.');
          const result = await addTask(projectRoot, input.boardId, taskInput(input));
          if (!result) return fail('Board not found.');
          return okTask(
            result.board,
            result.task,
            `Task added.${atomicityNudge(result.task)}`,
          );
        }
        case 'split_task': {
          if (!input.boardId || !input.taskId || !input.childTitles?.length) {
            return fail('split_task requires boardId, taskId, and childTitles.');
          }
          return handleSplitTask(projectRoot, input, {});
        }
        case 'merge_tasks': {
          if (!input.boardId || !input.taskIds?.length || !input.title) {
            return fail('merge_tasks requires boardId, taskIds, and title.');
          }
          const result = await mergeTasks(projectRoot, input.boardId, {
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
          });
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
              ...(input.targetColumnId !== undefined
                ? { targetColumnId: input.targetColumnId }
                : {}),
              ...(input.order !== undefined ? { targetOrder: input.order } : {}),
              ...(input.preserveAssignment !== undefined
                ? { preserveAssignment: input.preserveAssignment }
                : {}),
              ...(input.preserveDependencies !== undefined
                ? { preserveDependencies: input.preserveDependencies }
                : {}),
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
              ...(input.targetColumnId !== undefined
                ? { targetColumnId: input.targetColumnId }
                : {}),
              ...(input.order !== undefined ? { targetOrder: input.order } : {}),
              ...(input.preserveAssignment !== undefined
                ? { preserveAssignment: input.preserveAssignment }
                : {}),
              ...(input.preserveDependencies !== undefined
                ? { preserveDependencies: input.preserveDependencies }
                : {}),
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
        case 'update_task': {
          if (!input.boardId || !input.taskId)
            return fail('update_task requires boardId and taskId.');
          const board = await updateTask(
            projectRoot,
            input.boardId,
            input.taskId,
            taskPatch(input),
          );
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
          // Pre-gate for Done: transitionTask's validateDoneEvidence trusts a
          // persisted verificationReport but never runs the verifier itself.
          // When the target is done and the task lacks a report, run the
          // verifier and persist report + refreshed criteria first so the
          // transition is judged on fresh evidence.
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
              await updateTask(projectRoot, input.boardId, taskBefore.id, {
                verificationReport: preGate.report,
                successCriteria: preGate.task.successCriteria,
              });
            }
          }
          const result = await transitionTask(projectRoot, input.boardId, input.taskId, {
            to: input.lifecycleStage,
            actor: input.author,
            comment: input.transitionComment,
            ...(input.transitionAction !== undefined
              ? { action: input.transitionAction }
              : {}),
            ...(input.attachmentUrl !== undefined
              ? {
                  attachment: {
                    url: input.attachmentUrl,
                    type: input.attachmentType ?? 'url',
                    ...(input.attachmentTitle !== undefined
                      ? { title: input.attachmentTitle }
                      : {}),
                  },
                }
              : {}),
            patch: taskPatch(input),
          });
          if (result && input.lifecycleStage === 'done' && result.task.verificationReport) {
            recordKanbanVerificationEvidence(ctx, result.task.verificationReport);
          }
          return result
            ? okTask(result.board, result.task, `Task advanced to ${result.transition.to}.`)
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
          );
          return board ? okBoard(board, 'Task moved.') : fail('Move failed.');
        }
        case 'delete_task': {
          if (!input.boardId || !input.taskId)
            return fail('delete_task requires boardId and taskId.');
          const board = await removeTask(projectRoot, input.boardId, input.taskId);
          return board ? okBoard(board, 'Task deleted.') : fail('Task not found.');
        }
        case 'set_chain': {
          if (!input.boardId || !input.taskIds?.length) {
            return fail('set_chain requires boardId and taskIds.');
          }
          const result = await setTaskChain(projectRoot, input.boardId, {
            taskIds: input.taskIds,
            ...(input.chainId !== undefined ? { chainId: input.chainId } : {}),
            ...(input.enforceDependencies !== undefined
              ? { enforceDependencies: input.enforceDependencies }
              : {}),
          });
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
          const result = await claimReadyTask(projectRoot, {
            ...(input.boardId !== undefined ? { boardId: input.boardId } : {}),
            ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
            ...assignmentInput(input),
            status: input.assignmentStatus ?? 'queued',
          });
          return result
            ? okTask(result.board, result.task, 'Task claimed.')
            : fail('No ready kanban task matched the claim.');
        }
        case 'release_task': {
          if (!input.boardId || !input.taskId) {
            return fail('release_task requires boardId and taskId.');
          }
          const board = await releaseTaskClaim(projectRoot, input.boardId, input.taskId, {
            ...(input.releaseStatus !== undefined ? { status: input.releaseStatus } : {}),
            ...(input.releaseReason !== undefined ? { reason: input.releaseReason } : {}),
            ...(input.clearAssignee !== undefined ? { clearAssignee: input.clearAssignee } : {}),
          });
          return board ? okBoard(board, 'Task claim released.') : fail('Task not found.');
        }
        case 'assign_task': {
          if (!input.boardId || !input.taskId)
            return fail('assign_task requires boardId and taskId.');
          const board = await assignTask(
            projectRoot,
            input.boardId,
            input.taskId,
            assignmentInput(input),
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
            // Ownership fence: when expectedLeaseId is supplied, the write is
            // applied only if the current assignment still holds this lease.
            // This prevents a recovered+reassigned stale worker's terminal
            // mark_assignment from overwriting the successor's state. The check
            // is atomic inside updateTaskAssignment's mutateBoard lock.
            input.expectedLeaseId !== undefined
              ? { expectedLeaseId: input.expectedLeaseId }
              : {},
          );
          if (!board) return fail('Task not found.');
          // Universal completion gate: a completed assignment was parked in
          // review by updateTaskAssignment; finalize runs the verifier and
          // applies the final status (async — cannot happen inside the board
          // mutation). Env fallback applies only when the board carries no
          // explicit completionGate policy; the kanban package never reads env.
          if (assignmentStatus === 'completed') {
            const envGate = readEnvGateEnforcement();
            const finalized = await finalizeTaskCompletion(projectRoot, board.id, input.taskId, {
              ...(board.completionGate === undefined && envGate !== undefined
                ? { enforcement: envGate }
                : {}),
              ...(ctx.agentId !== undefined ? { eventContext: { actor: ctx.agentId } } : {}),
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
                ? `Completion gate ${finalized.gate.verdict === 'skipped' ? 'skipped' : 'passed'}; task completed.`
                : finalized.gate.enforcement === 'strict'
                  ? `Completion gate BLOCKED (verdict: ${finalized.gate.verdict}); task parked in review. Issues: ${gateSummary.issues.join(' | ')}`
                  : `Completion gate failed softly (verdict: ${finalized.gate.verdict}); task completed with warnings. Issues: ${gateSummary.issues.join(' | ')}`;
              return {
                ...okTask(finalized.board, finalized.task, `Assignment updated. ${gateMessage}`),
                gate: gateSummary,
              };
            }
          }
          return okBoard(board, 'Assignment updated.');
        }
        case 'heartbeat_assignment': {
          if (!input.boardId || !input.taskId) {
            return fail('heartbeat_assignment requires boardId and taskId.');
          }
          const board = await heartbeatTaskAssignment(projectRoot, input.boardId, input.taskId, {
            ...(input.heartbeatAt !== undefined ? { heartbeatAt: input.heartbeatAt } : {}),
            ...(input.leaseExpiresAt !== undefined ? { leaseExpiresAt: input.leaseExpiresAt } : {}),
            // Ownership fence: when expectedLeaseId is supplied, the renewal
            // is applied only if the current assignment still holds this lease.
            // This prevents a recovered+reassigned stale worker's heartbeat
            // from renewing the successor's lease. The check is atomic inside
            // heartbeatTaskAssignment's mutateBoard lock.
            ...(input.expectedLeaseId !== undefined
              ? { expectedLeaseId: input.expectedLeaseId }
              : {}),
          });
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
          const result = await recoverStaleTaskAssignments(projectRoot, input.boardId, {
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
          });
          return result
            ? {
                ok: true,
                message: `Recovered ${result.tasks.length} stale assignment(s).`,
                board: result.board,
                recoveredTasks: result.tasks,
              }
            : { ok: true, message: 'No stale assignment matched.', recoveredTasks: [] };
        }
        case 'events': {
          if (!input.boardId) return fail('events requires boardId.');
          const eventList = await listKanbanEvents(projectRoot, input.boardId);
          return {
            ok: true,
            message: `${eventList.length} event(s).`,
            events: eventList,
          };
        }
        case 'queue_health': {
          const health = await getKanbanQueueHealth(projectRoot, {
            ...(input.boardId !== undefined ? { boardId: input.boardId } : {}),
          });
          return {
            ok: true,
            message: `Counts: ready=${health.counts.ready}, running=${health.counts.running}, stale=${health.staleAssignments.count}.`,
            queueHealth: health,
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
              ...(input.checkDescription !== undefined
                ? { description: input.checkDescription }
                : {}),
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
        case 'assess_atomicity': {
          if (!input.boardId || !input.taskId) {
            return fail('assess_atomicity requires boardId and taskId.');
          }
          const result = await assessTaskAtomicity(projectRoot, input.boardId, input.taskId, {
            assessedBy: 'agent',
            ...(ctx.agentId !== undefined ? { eventContext: { actor: ctx.agentId } } : {}),
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
            ctx.agentId !== undefined ? { actor: ctx.agentId } : {},
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
          // Persist verificationReport AND updated successCriteria atomically
          // in a single board mutation so there is no window where the report
          // exists but criteria are stale. Always persist both — the verifier
          // may have updated individual criterion status/checkedBy/checkedAt
          // on the in-memory task, and the comparison would always be false
          // because both references point to the same updated object.
          const persistedBoard = await updateTask(projectRoot, input.boardId, input.taskId, {
            verificationReport: verResult.report,
            successCriteria: verResult.task.successCriteria,
          });
          if (!persistedBoard) {
            // Return structured failure so callers can inspect the
            // verification verdict and report without re-running.
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
          // ok is true whenever the verifier produced a deterministic verdict
          // (passed/failed/needs_human/incomplete). Callers should inspect the
          // `verdict` field to distinguish success from human-review-needed;
          // ok: false is reserved for thrown errors that never produced a report.
          const deterministicVerdicts = ['passed', 'failed', 'needs_human', 'incomplete'] as const;
          return {
            ok: deterministicVerdicts.includes(verResult.report.verdict as typeof deterministicVerdicts[number]),
            verdict: verResult.report.verdict,
            message: verResult.report.markdownSummary,
            board: persistedBoard,
            task: freshTask ?? verResult.task,
          };
        }
        case 'split_atomic': {
          if (!input.boardId || !input.taskId || !input.childTitles?.length) {
            return fail('split_atomic requires boardId, taskId, and childTitles (at least one).');
          }
          return handleSplitTask(projectRoot, input, { atomic: true });
        }
        default:
          return fail(`Unknown kanban action: ${(input as { action: string }).action}`);
        }
      })();
      return withPresence(result);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
};

/** Shared split handler used by both split_task and split_atomic. */
async function handleSplitTask(
  projectRoot: string,
  input: KanbanToolInput,
  extraSplitOptions: Record<string, unknown>,
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
  const result = await splitTask(projectRoot, boardId, taskId, {
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
  });
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

async function requireBoard(
  projectRoot: string,
  boardId: string | undefined,
): Promise<KanbanBoard | null> {
  return boardId ? getBoard(projectRoot, boardId) : null;
}
