// Kanban data model + manager moved from @wrongstack/core to the standalone
import { randomUUID } from 'node:crypto';
// @wrongstack/kanban package; only the Tool contract and the task-graph
// serialization types still come from core.
import { loadTasks } from '@wrongstack/core/storage';
import { deserializeTaskGraph, serializeTaskGraph } from '@wrongstack/core/tasking';
import type { SerializableTaskGraph, Tool } from '@wrongstack/core/types';
import {
  addTask,
  adoptManagedLifecycle,
  assignTask,
  claimReadyTask,
  copyTaskToBoard,
  createBoard,
  createBoardFromTaskGraph,
  createBoardFromText,
  duplicateBoard,
  evaluateContractGraphReadiness,
  exportBoardAsMarkdown,
  exportBoardToTaskGraph,
  finalizeTaskCompletion,
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
  removeTask,
  repairManagedTaskProjection,
  resolveAutoAccept,
  searchKanban,
  setTaskChain,
  stripLifecycleIssues,
  syncBoardFromTaskGraph,
  transferTaskToBoard,
  transitionTask,
  updateBoard,
  updateTask,
  updateTaskAssignment,
  verifyTaskCompletion,
} from '@wrongstack/kanban';
import {
  boardCreateInput,
  boardUpdatePatch,
  duplicateBoardOptions,
} from './kanban-board-inputs.js';
import { handleKanbanContractAction } from './kanban-contract-actions.js';
import { handleKanbanDecompositionAction } from './kanban-decomposition-actions.js';
import { handleKanbanDetailAction } from './kanban-detail-actions.js';
import { recordKanbanVerificationEvidence } from './kanban-evidence-bridge.js';
import { createKanbanPresenceWrapper } from './kanban-presence.js';
import { handleSplitTask, requireBoard } from './kanban-split-task-handler.js';
import { assignmentInput, taskInput, taskPatch } from './kanban-task-inputs.js';
import {
  atomicityNudge,
  fail,
  okBoard,
  okTask,
  readEnvGateEnforcement,
} from './kanban-tool-results.js';
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
  // WS-046: gives permission decisions something to key on.
  // The action performed; kanban has no single file or path subject.
  subjectKey: 'action',
  mutating: true,
  capabilities: ['fs.write'],
  icon: 'task',
  timeoutMs: 30_000,
  inputSchema: KANBAN_INPUT_SCHEMA,
  async execute(input, ctx) {
    const projectRoot = ctx.projectRoot;
    if (!projectRoot) return fail('No project root is available.');

    const withPresence = createKanbanPresenceWrapper(projectRoot, input, ctx);

    try {
      const result = await (async (): Promise<KanbanToolOutput> => {
        const decompositionResult = await handleKanbanDecompositionAction(projectRoot, input, ctx);
        if (decompositionResult !== undefined) return decompositionResult;
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
            // Work fragments across boards when each new piece of work gets its
            // own board: the same card ends up in two places, or a board holds
            // a single task. Nothing here refuses the create — a genuinely
            // separate line of work deserves its own board — but the caller is
            // told what already exists so it can choose to continue instead.
            const existing = (await listBoards(projectRoot)).filter(
              (candidate) => (candidate.kind ?? 'project') === 'project',
            );
            const board = await createBoard(projectRoot, boardCreateInput(input, input.title));
            const note = existing.length
              ? ` ${existing.length} other project board(s) already exist: ${existing
                  .slice(0, 3)
                  .map((candidate) => `"${candidate.title}" (${candidate.taskCount} task(s))`)
                  .join(
                    ', ',
                  )}${existing.length > 3 ? ', …' : ''}. If this work belongs to one of them, add_task there instead and delete this board.`
              : '';
            return { ok: true, message: `Board created: ${board.title}.${note}`, board };
          }
          case 'update_board': {
            if (!input.boardId) return fail('update_board requires boardId.');
            const board = await updateBoard(projectRoot, input.boardId, boardUpdatePatch(input));
            return board ? okBoard(board, 'Board updated.') : fail('Board not found.');
          }
          case 'adopt_managed_lifecycle': {
            if (!input.boardId || !input.author || !input.transitionComment) {
              return fail(
                'adopt_managed_lifecycle requires boardId, author, transitionComment, and five ordered columns.',
              );
            }
            if (input.columns?.length !== 5) {
              return fail(
                'adopt_managed_lifecycle columns must be ordered as backlog, todo, running, review, done.',
              );
            }
            const [backlog, todo, running, review, done] = input.columns;
            if (!backlog || !todo || !running || !review || !done) {
              return fail('adopt_managed_lifecycle columns must contain five nonblank ids.');
            }
            const board = await adoptManagedLifecycle(projectRoot, input.boardId, {
              columns: { backlog, todo, running, review, done },
              actor: input.author,
              comment: input.transitionComment,
            });
            return board
              ? okBoard(board, 'Managed lifecycle adopted without moving existing cards.')
              : fail('Board not found.');
          }
          // Adoption used to be a one-way door: the strict lifecycle carries
          // acceptance-criteria, verification-report, review-evidence and
          // one-stage-at-a-time gates, and nothing on the tool surface could
          // undo it, so a board adopted once kept its ceremony forever. The
          // gates are worth having where a fleet is supervised; they are not
          // worth being unable to leave. Cards and columns are untouched.
          case 'release_managed_lifecycle': {
            if (!input.boardId) return fail('release_managed_lifecycle requires boardId.');
            const board = await updateBoard(projectRoot, input.boardId, { lifecycle: null });
            return board
              ? okBoard(
                  board,
                  'Managed lifecycle released; the board now tracks work without strict gates.',
                )
              : fail('Board not found.');
          }
          case 'duplicate_board': {
            if (!input.boardId) return fail('duplicate_board requires boardId.');
            const board = await duplicateBoard(
              projectRoot,
              input.boardId,
              duplicateBoardOptions(input),
            );
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
          case 'add_task': {
            if (!input.boardId || !input.title) return fail('add_task requires boardId and title.');
            const result = await addTask(projectRoot, input.boardId, taskInput(input));
            if (!result) return fail('Board not found.');
            return okTask(result.board, result.task, `Task added.${atomicityNudge(result.task)}`);
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
              ...(input.targetColumnId !== undefined
                ? { targetColumnId: input.targetColumnId }
                : {}),
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
            if (!input.boardId || !input.taskId)
              return fail('get_task requires boardId and taskId.');
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
            // A plain board has no lifecycle metadata, so every stage check
            // below reads `unknown` and the call could never succeed — the
            // action was written for managed boards only, which quietly made
            // "start the work" one more reason to adopt the full ceremony.
            // Claim it the way a plain board expresses the same thing.
            if (board.lifecycle?.mode !== 'managed') {
              const now = new Date();
              const assigned = await updateTaskAssignment(projectRoot, board.id, task.id, {
                status: 'running',
                agentId: input.agentId ?? input.author,
                leaseId: input.leaseId ?? randomUUID(),
                claimedAt: input.claimedAt ?? now.toISOString(),
                heartbeatAt: input.heartbeatAt ?? now.toISOString(),
                leaseExpiresAt:
                  input.leaseExpiresAt ?? new Date(now.getTime() + 15 * 60_000).toISOString(),
                attempt: input.attempt ?? 1,
                maxAttempts: input.maxAttempts ?? 3,
              });
              if (!assigned) return fail('Task assignment could not be started.');
              const started = await updateTask(projectRoot, board.id, task.id, {
                status: 'in_progress',
              });
              const current = started ?? assigned;
              const claimed = task;
              const currentTask =
                current.tasks.find((candidate) => candidate.id === claimed.id) ?? claimed;
              // Bind the card even though this board carries no governance
              // authority. Two different things were being decided by one
              // call: WHICH CARD IS THIS RUN WORKING (attribution) and WHICH
              // CARD MAY GATE MUTATIONS (governance). Withholding the binding
              // to withhold the second also withheld the first, so on a plain
              // board — the default — `currentKanbanTaskId` stayed undefined
              // forever: `recordFileEvent()` wrote `scope: 'session'` for every
              // edit and no file activity was ever attributed to a card. The
              // board said `in_progress` and the runtime could not say which
              // card that was.
              //
              // Binding is safe because the boundary decides governance from
              // the BOARD, not from the mere presence of a binding: it skips a
              // non-managed board (see evaluateToolKanbanBoundary). The one
              // behavioural gain is that a task-level `boundary` policy now
              // applies while its task is active — previously only the
              // board-level policy did, because the todo mirror bound the
              // board with an undefined task.
              // Optional-chained, unlike the managed branch below: attribution
              // is best-effort and must not turn "start the work" into a hard
              // failure on a host whose context does not implement it (the
              // subagent runner already guards this call the same way). The
              // managed branch keeps its unconditional call — there the
              // binding IS the governance identity, so silently skipping it
              // would be worse than failing.
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
              const assigned = await updateTaskAssignment(projectRoot, board.id, task.id, {
                status: 'running',
                agentId: input.agentId ?? input.author,
                leaseId,
                claimedAt: input.claimedAt ?? now.toISOString(),
                heartbeatAt: input.heartbeatAt ?? now.toISOString(),
                leaseExpiresAt:
                  input.leaseExpiresAt ?? new Date(now.getTime() + 15 * 60_000).toISOString(),
                attempt: input.attempt ?? 1,
                maxAttempts: input.maxAttempts ?? 3,
              });
              if (!assigned) return fail('Task assignment could not be started.');
              const moved = await transitionTask(projectRoot, board.id, task.id, {
                to: 'running',
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
            // Every non-managed board already returned from the plain-board
            // branch above, so this point is reached only in managed mode.
            // A second `mode !== 'managed'` guard used to sit here; it was
            // unreachable, and its message contradicted the one the reachable
            // branch returns.
            ctx.setCurrentKanbanTask(task.id, board.id);
            return okTask(
              board,
              task,
              'Task is active; runtime Kanban governance is now bound to this run.',
            );
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
                const preGate = await verifyTaskCompletion(
                  projectRoot,
                  input.boardId,
                  taskBefore.id,
                  {
                    persist: false,
                  },
                );
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
              ...(input.transitionAction !== undefined ? { action: input.transitionAction } : {}),
              ...(input.tickChecks !== undefined ? { tickChecks: input.tickChecks } : {}),
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
          case 'repair_managed_projection': {
            if (!input.boardId || !input.taskId || !input.author || !input.transitionComment) {
              return fail(
                'repair_managed_projection requires boardId, taskId, author, and transitionComment.',
              );
            }
            const result = await repairManagedTaskProjection(
              projectRoot,
              input.boardId,
              input.taskId,
              {
                actor: input.author,
                comment: input.transitionComment,
              },
            );
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
            );
            return board ? okBoard(board, 'Task moved.') : fail('Move failed.');
          }
          case 'delete_task': {
            if (!input.boardId || !input.taskId)
              return fail('delete_task requires boardId and taskId.');
            const board = await removeTask(projectRoot, input.boardId, input.taskId);
            // Deleting the card this run is bound to must not leave a dangling
            // identity behind. Under `tools.kanbanGovernance` a binding that
            // points at a card that no longer exists blocks every mutating
            // tool with "Active Kanban task not found" — the run would be held
            // hostage by its own cleanup. Clearing the task while keeping the
            // board keeps the session on the same board with no active card.
            if (board && ctx.currentKanbanTaskId === input.taskId) {
              ctx.setCurrentKanbanTask?.(undefined, ctx.currentKanbanBoardId);
            }
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
                ...(input.leaseExpiresAt !== undefined
                  ? { leaseExpiresAt: input.leaseExpiresAt }
                  : {}),
                ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
                ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
              },
              // Ownership fence: when expectedLeaseId is supplied, the write is
              // applied only if the current assignment still holds this lease.
              // This prevents a recovered+reassigned stale worker's terminal
              // mark_assignment from overwriting the successor's state. The check
              // is atomic inside updateTaskAssignment's mutateBoard lock.
              input.expectedLeaseId !== undefined ? { expectedLeaseId: input.expectedLeaseId } : {},
            );
            if (!board) return fail('Task not found.');
            // Universal completion gate: a completed assignment was parked in
            // review by updateTaskAssignment; finalize runs the verifier and
            // applies the final status (async — cannot happen inside the board
            // mutation). Env fallback applies only when the board carries no
            // explicit completionGate policy; the kanban package never reads env.
            if (assignmentStatus === 'completed' && board.lifecycle?.mode !== 'managed') {
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
            } else if (board.lifecycle?.mode === 'managed') {
              // ── Managed lifecycle auto-transition ──────────────────────
              // The worker's assignment status changes represent lifecycle
              // events. transitionTask atomically persists audit history,
              // evidence, and the correct column/status projection.  The
              // assignment telemetry was already persisted by
              // updateTaskAssignment above; this separate domain call
              // advances the card without violating the invariant that
              // assignment writes never fabricate lifecycle stages.
              //
              // When completed transitions to Review, verification runs
              // automatically and — if the verdict is passed/skipped — the
              // card auto-advances to Done without human intervention.
              // ------------------------------------------------------------
              const managedTask = board.tasks.find((candidate) => candidate.id === input.taskId);
              const stage = managedTask?.lifecycle?.currentStage;
              const actor = ctx.agentId ?? 'kanban-agent';
              let transitionResult: Awaited<ReturnType<typeof transitionTask>> = null;
              const lifecycleWarnings: string[] = [];

              if (assignmentStatus === 'running' && stage === 'todo') {
                try {
                  transitionResult = await transitionTask(projectRoot, board.id, input.taskId, {
                    to: 'running',
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
                // ── Running → Review ─────────────────────────────────────
                const comment =
                  typeof input.lastResult === 'string' && input.lastResult.trim().length > 0
                    ? input.lastResult.trim().slice(0, 1000)
                    : 'Work completed.';
                try {
                  transitionResult = await transitionTask(projectRoot, board.id, input.taskId, {
                    to: 'review',
                    actor,
                    comment,
                    attachment: {
                      url: `kanban://task/${input.taskId}/result`,
                      title: 'Worker completion result',
                      type: 'file',
                    },
                    patch: {
                      // Only patch non-description fields so the
                      // original card description is preserved.
                      ...(input.agentId !== undefined ? { assignedAgent: input.agentId } : {}),
                    },
                  });
                } catch (err: unknown) {
                  lifecycleWarnings.push(
                    `Lifecycle transition to Review failed: ${stripLifecycleIssues(err instanceof Error ? err.message : String(err))}`,
                  );
                }

                // ── Autonomous verify + accept ──────────────────────────
                // Card is now in Review.  When it has verifiable criteria
                // or is atomic, the system runs the verifier automatically
                // and — if the verdict allows — advances to Done.
                if (transitionResult) {
                  const hasCriteria =
                    (transitionResult.task.successCriteria?.length ?? 0) > 0 ||
                    transitionResult.task.atomic === true;

                  if (hasCriteria) {
                    try {
                      const verResult = await verifyTaskCompletion(
                        projectRoot,
                        board.id,
                        input.taskId,
                      );
                      if (verResult.report) {
                        recordKanbanVerificationEvidence(ctx, verResult.report);
                      }
                      await updateTask(projectRoot, board.id, input.taskId, {
                        verificationReport: verResult.report,
                        successCriteria: verResult.task.successCriteria,
                      });

                      const verdict = verResult.report.verdict;
                      if (verdict === 'passed' && !resolveAutoAccept(board)) {
                        // Verification succeeded; this board just reserves the
                        // final call for a reviewer. Say that plainly — the
                        // caller must not read it as a verification failure.
                        lifecycleWarnings.push(
                          'Verification passed, but this board does not auto-accept. ' +
                            'The card is in Review awaiting an explicit transition_task to done.',
                        );
                      } else if (verdict === 'passed') {
                        try {
                          const doneResult = await transitionTask(
                            projectRoot,
                            board.id,
                            input.taskId,
                            {
                              to: 'done',
                              actor,
                              action: 'Automated acceptance after verification',
                              comment: 'Auto-accepted: verification passed.',
                              attachment: {
                                url: `kanban://task/${input.taskId}/verification`,
                                title: 'Auto-verification result',
                                type: 'file',
                              },
                            },
                          );
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

              // ── Build the freshest possible response ──────────────
              // transitionResult carries the post-transition board; use
              // it instead of the stale snapshot from updateTaskAssignment.
              const responseBoard = transitionResult?.board ?? board;
              const responseTask = transitionResult?.task ?? managedTask!;
              const msgParts = ['Assignment updated.'];
              if (transitionResult) {
                msgParts.push(`Card advanced to ${transitionResult.transition.to}.`);
              }
              for (const w of lifecycleWarnings) msgParts.push(`Warning: ${w}`);
              return okTask(responseBoard, responseTask, msgParts.join(' '));
            }
            return okBoard(board, 'Assignment updated.');
          }
          case 'heartbeat_assignment': {
            if (!input.boardId || !input.taskId) {
              return fail('heartbeat_assignment requires boardId and taskId.');
            }
            const board = await heartbeatTaskAssignment(projectRoot, input.boardId, input.taskId, {
              ...(input.heartbeatAt !== undefined ? { heartbeatAt: input.heartbeatAt } : {}),
              ...(input.leaseExpiresAt !== undefined
                ? { leaseExpiresAt: input.leaseExpiresAt }
                : {}),
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
              message: `Counts: startable=${health.counts.startable}, running=${health.counts.running}, stale=${health.staleAssignments.count}.`,
              queueHealth: health,
            };
          }
          // Not every action is handled above. These are dispatched from here,
          // and the split has already cost real time: an agent that read this
          // file concluded `add_check` / `update_check` did not exist, wrote
          // that on a card, and spent a session trying to satisfy a gate it
          // already had the tool to clear. Keep this index in step with the
          // handlers.
          //
          //   kanban-detail-actions.ts  workbench · add_dependency ·
          //     add_goal_metric · update_goal_metric · add_check ·
          //     update_check · add_note · add_link · split_atomic
          //   kanban-decomposition-actions.ts  verify_completion ·
          //     assess_atomicity · propose_decomposition
          //   kanban-contract-actions.ts  get_contract_graph ·
          //     configure_contract_graph · upsert_contract_node ·
          //     remove_contract_node · add_contract_edge · remove_contract_edge
          default:
            {
              const contractResult = await handleKanbanContractAction(
                projectRoot,
                input,
                input.author ?? input.agentId,
              );
              if (contractResult !== undefined) return contractResult;
            }
            {
              const detailResult = await handleKanbanDetailAction(projectRoot, input);
              if (detailResult !== undefined) return detailResult;
            }
            return fail(`Unknown kanban action: ${(input as { action: string }).action}`);
        }
      })();
      return withPresence(result);
    } catch (err) {
      // Strip the lifecycle envelope: it is an IPC transport detail, and the
      // model reads whatever is in `message` as the explanation.
      return fail(stripLifecycleIssues(err instanceof Error ? err.message : String(err)));
    }
  },
  serialize(output, input) {
    return serializeKanbanOutput(output, input);
  },
};

/**
 * How many serialized bytes a `board` may occupy in the transcript before a
 * mutation result swaps it for a compact summary. Read actions whose purpose
 * IS the board (`get_board`, exports) always keep the full payload.
 */
const KANBAN_BOARD_TRANSCRIPT_BYTE_CAP = 16_384;

/** Actions whose whole point is returning the full board — never trimmed. */
const KANBAN_FULL_BOARD_ACTIONS = new Set<string>([
  'get_board',
  'export_markdown',
  'export_task_graph',
]);

/**
 * Transcript serializer for kanban results. Every mutation returns the full
 * board so programmatic consumers (todo mirror, gates, tests) can chain off it,
 * but replaying that board into the LLM transcript on EVERY add_note /
 * transition_task turns a busy board into thousands of repeated tokens.
 * When the serialized board exceeds the cap and the action is not a
 * board-reading one, the transcript payload carries a compact summary
 * ({column → task count}, totalTasks) plus the affected `task` and `message`.
 * `execute()`'s return shape is unchanged — this only affects the transcript.
 */
function serializeKanbanOutput(output: KanbanToolOutput, input: unknown): string {
  const action =
    input && typeof input === 'object'
      ? (input as { action?: unknown }).action
      : undefined;
  const board = output.board;
  if (board) {
    const keepFull = typeof action === 'string' && KANBAN_FULL_BOARD_ACTIONS.has(action);
    let boardBytes = 0;
    if (!keepFull) {
      try {
        boardBytes = Buffer.byteLength(JSON.stringify(board), 'utf8');
      } catch {
        boardBytes = 0; // unserializable board — leave payload untouched
      }
    }
    if (!keepFull && boardBytes > KANBAN_BOARD_TRANSCRIPT_BYTE_CAP) {
      const columns: Record<string, number> = {};
      for (const column of board.columns) {
        columns[column.title || column.id] = board.tasks.filter(
          (task) => task.columnId === column.id,
        ).length;
      }
      const compact = {
        ...output,
        board: {
          id: board.id,
          title: board.title,
          columns,
          totalTasks: board.tasks.length,
          note: `Full board (${boardBytes} bytes) omitted from the transcript; use get_board to load it.`,
        },
      };
      return JSON.stringify(compact, null, 2);
    }
  }
  return JSON.stringify(output, null, 2);
}
