import { randomUUID } from 'node:crypto';
import { mutateBoard, readKanbanEvents, summarizeBoard } from '../storage.js';
import type {
  AssignKanbanTaskInput,
  ClaimKanbanTaskInput,
  HeartbeatKanbanTaskAssignmentInput,
  KanbanAgentAssignment,
  KanbanAgentRunStatus,
  KanbanBoard,
  KanbanEvent,
  KanbanOrchestrationSnapshot,
  KanbanQueueHealth,
  KanbanSearchInput,
  KanbanSearchResult,
  KanbanTask,
  ReconcileKanbanBoardResult,
  RecoverStaleKanbanAssignmentsInput,
  RecoverStaleKanbanAssignmentsResult,
  ReleaseKanbanTaskClaimInput,
} from '../types.js';
import {
  assignmentEventType,
  buildAssignment,
  claimReadyTaskOnBoard,
  collectBoardsForHealth,
  createKanbanEvent,
  emitKanbanEvent,
  findTask,
  isAssignmentHeartbeatDue,
  isTaskReadyForWork,
  later,
  matchesKanbanSearch,
  msUntilExpiry,
  nowIso,
  selectRecoveryMode,
  syncTaskColumnForStatus,
} from './_internal.js';
import { getBoard, listBoards } from './boards.js';
import { areDependenciesMet } from './dependencies.js';

/**
 * Deterministically repair task/assignment/column drift.
 *
 * Worker completion is not trusted as the final board transition: unfinished
 * checks land in review, failed checks fail the card, and only a fully verified
 * task reaches completed. This is intentionally LLM-free so a quiet supervisor
 * can run frequently without cost or provider ambiguity.
 */
export async function reconcileKanbanBoard(
  projectRoot: string,
  boardId: string,
): Promise<ReconcileKanbanBoardResult | null> {
  const reconciled: KanbanTask[] = [];
  const events: KanbanEvent[] = [];
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    for (const task of board.tasks) {
      const assignment = task.assignment;
      const beforeStatus = task.status;
      const beforeColumnId = task.columnId;
      let desiredStatus = task.status;
      if (assignment?.status === 'running') desiredStatus = 'in_progress';
      else if (assignment?.status === 'failed') desiredStatus = 'failed';
      else if (assignment?.status === 'cancelled') desiredStatus = 'blocked';
      else if (assignment?.status === 'completed') {
        const checks = task.successCriteria ?? [];
        if (checks.some((check) => check.status === 'failed')) desiredStatus = 'failed';
        else if (checks.some((check) => check.status === 'pending')) desiredStatus = 'review';
        else desiredStatus = 'completed';
      } else if (
        assignment !== undefined &&
        (assignment.status === 'queued' || assignment.status === 'assigned') &&
        (task.status === 'completed' || task.status === 'failed')
      ) {
        desiredStatus = areDependenciesMet(board, task.id) ? 'ready' : 'blocked';
      }

      task.status = desiredStatus;
      applyReconciledCompletion(task);
      syncTaskColumnForStatus(board, task, beforeColumnId);
      if (task.status === beforeStatus && task.columnId === beforeColumnId) continue;
      const now = nowIso();
      task.updatedAt = now;
      board.updatedAt = now;
      reconciled.push({
        ...task,
        assignment: task.assignment ? { ...task.assignment } : undefined,
      });
      events.push(
        createKanbanEvent(board.id, task, 'task.reconciled', {
          before: { status: beforeStatus, columnId: beforeColumnId },
          after: { status: task.status, columnId: task.columnId },
          note: 'Kanban supervisor repaired task/assignment drift.',
        }),
      );
    }
    return reconciled.length ? reconciled : null;
  });
  if (updated?.result) {
    for (const event of events) await emitKanbanEvent(projectRoot, event);
  }
  return updated?.result ? { board: updated.board, tasks: updated.result } : null;
}

function applyReconciledCompletion(task: KanbanTask): void {
  if (task.status === 'completed') {
    task.completedAt = task.assignment?.completedAt ?? task.completedAt ?? nowIso();
  } else {
    delete task.completedAt;
  }
}

export async function assignTask(
  projectRoot: string,
  boardId: string,
  taskId: string,
  input: AssignKanbanTaskInput,
): Promise<KanbanBoard | null> {
  let event: KanbanEvent | undefined;
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    if (!task) return null;
    const before = task.assignment ? { ...task.assignment } : undefined;
    const assignment = buildAssignment(input);
    task.assignment = assignment;
    task.assignedAgent = assignment.agentId ?? assignment.role ?? assignment.name;
    task.assignee = input.assignee ?? assignment.name ?? assignment.agentId;
    // Sprint 3: mirror policy fields from assignment to durable task level.
    if (input.retryPolicy !== undefined) task.retryPolicy = input.retryPolicy;
    if (input.costCeilingUsd !== undefined) task.costCeilingUsd = input.costCeilingUsd;
    task.updatedAt = nowIso();
    board.updatedAt = task.updatedAt;
    // `assign` is distinct from `claim` — record the routing decision (provider/
    // model/role) so it leaves an audit trail like claim/release do.
    event = createKanbanEvent(board.id, task, 'task.assigned', {
      ...(before ? { before } : {}),
      after: { ...assignment },
    });
    return task;
  });
  if (updated?.result && event) await emitKanbanEvent(projectRoot, event);
  return updated?.result ? updated.board : null;
}

export async function updateTaskAssignment(
  projectRoot: string,
  boardId: string,
  taskId: string,
  patch: Partial<KanbanAgentAssignment> & { status?: KanbanAgentRunStatus | undefined },
): Promise<KanbanBoard | null> {
  let event: KanbanEvent | undefined;
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    if (!task) return null;
    const previousColumnId = task.columnId;
    const beforeAssignment = task.assignment ? { ...task.assignment } : undefined;
    const nextAssignment: KanbanAgentAssignment = {
      ...(task.assignment ?? { status: 'assigned' as const }),
    };
    for (const [key, value] of Object.entries(patch) as Array<
      [keyof KanbanAgentAssignment, KanbanAgentAssignment[keyof KanbanAgentAssignment]]
    >) {
      if (value !== undefined) {
        (nextAssignment as unknown as Record<string, unknown>)[key] = value;
      }
    }
    task.assignment = nextAssignment;
    if (task.assignment.agentId) task.assignedAgent = task.assignment.agentId;
    if (task.assignment.status === 'completed') {
      task.assignment.completedAt = task.assignment.completedAt ?? nowIso();
      task.status = 'completed';
      task.completedAt = task.assignment.completedAt;
      if (patch.error === undefined) delete task.assignment.error;
    } else if (task.assignment.status === 'running') {
      // A dispatch that goes straight to `running` (mark_assignment, not via
      // claim) must still stamp when work started — otherwise the run panel and
      // queue-health `lastDispatchedAt` have no start time.
      task.assignment.dispatchedAt = task.assignment.dispatchedAt ?? nowIso();
      delete task.assignment.completedAt;
      if (patch.error === undefined) delete task.assignment.error;
      task.status = 'in_progress';
      delete task.completedAt;
    } else if (task.assignment.status === 'failed') {
      delete task.assignment.completedAt;
      task.status = 'failed';
      delete task.completedAt;
    } else if (task.assignment.status === 'cancelled') {
      delete task.assignment.completedAt;
      if (patch.error === undefined) delete task.assignment.error;
      task.status = 'blocked';
      delete task.completedAt;
    } else if (task.assignment.status === 'queued' || task.assignment.status === 'assigned') {
      delete task.assignment.completedAt;
      if (patch.error === undefined) delete task.assignment.error;
      if (task.status === 'completed' || task.status === 'failed') {
        task.status = task.assignment.status === 'queued' ? 'ready' : 'pending';
      }
      delete task.completedAt;
    }
    syncTaskColumnForStatus(board, task, previousColumnId);
    task.updatedAt = nowIso();
    board.updatedAt = task.updatedAt;
    event = createKanbanEvent(board.id, task, assignmentEventType(task.assignment.status), {
      before: beforeAssignment,
      after: { ...task.assignment },
      note: patch.error ?? patch.lastResult,
    });
    return task;
  });
  if (updated && event) await emitKanbanEvent(projectRoot, event);
  return updated?.result ? updated.board : null;
}

export async function heartbeatTaskAssignment(
  projectRoot: string,
  boardId: string,
  taskId: string,
  input: HeartbeatKanbanTaskAssignmentInput = {},
): Promise<KanbanBoard | null> {
  let event: KanbanEvent | undefined;
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    if (!task?.assignment) return null;
    const beforeAssignment = { ...task.assignment };
    const now = nowIso();
    task.assignment.heartbeatAt = input.heartbeatAt ?? now;
    if (input.leaseExpiresAt !== undefined) {
      task.assignment.leaseExpiresAt = input.leaseExpiresAt;
    }
    task.updatedAt = now;
    board.updatedAt = now;
    event = createKanbanEvent(board.id, task, 'task.assignment.heartbeat', {
      before: beforeAssignment,
      after: { ...task.assignment },
    });
    return task;
  });
  if (updated && event) await emitKanbanEvent(projectRoot, event);
  return updated?.result ? updated.board : null;
}

export async function recoverStaleTaskAssignments(
  projectRoot: string,
  boardId: string,
  input: RecoverStaleKanbanAssignmentsInput = {},
): Promise<RecoverStaleKanbanAssignmentsResult | null> {
  const recoveredTasks: KanbanTask[] = [];
  const events: KanbanEvent[] = [];
  const requestedMode = input.mode ?? 'retry';
  const checkedAt = input.now ?? nowIso();
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    for (const task of board.tasks) {
      const assignment = task.assignment;
      if (!assignment || (assignment.status !== 'queued' && assignment.status !== 'running')) {
        continue;
      }
      if (!assignment.leaseExpiresAt || assignment.leaseExpiresAt > checkedAt) continue;
      const previousColumnId = task.columnId;
      const beforeAssignment = { ...assignment };
      const isHeartbeatDueNow = isAssignmentHeartbeatDue(assignment, checkedAt);
      const mode = selectRecoveryMode({
        requested: requestedMode,
        task,
        isHeartbeatDue: isHeartbeatDueNow,
        policy: input.policy,
      });
      const reason = input.reason ?? `Stale assignment recovered at ${checkedAt}`;
      const now = nowIso();
      task.notes = [
        ...(task.notes ?? []),
        {
          id: randomUUID(),
          author: 'system',
          content: `Stale assignment recovered (${mode}): ${reason}`,
          createdAt: now,
        },
      ];

      if (mode === 'fail') {
        assignment.status = 'failed';
        assignment.error = reason;
        delete assignment.completedAt;
        task.status = 'failed';
        delete task.completedAt;
      } else if (mode === 'release') {
        delete task.assignment;
        if (input.clearAssignee !== false) {
          delete task.assignedAgent;
          delete task.assignee;
        }
        task.status = areDependenciesMet(board, task.id) ? 'ready' : 'blocked';
        delete task.completedAt;
      } else {
        const nextAttempt = (assignment.attempt ?? 0) + 1;
        if (assignment.maxAttempts !== undefined && nextAttempt > assignment.maxAttempts) {
          assignment.status = 'failed';
          assignment.error = `${reason}; max attempts exceeded (${assignment.maxAttempts})`;
          delete assignment.completedAt;
          task.status = 'failed';
          delete task.completedAt;
        } else {
          task.assignment = {
            ...assignment,
            status: 'assigned',
            attempt: nextAttempt,
          };
          delete task.assignment.subagentId;
          delete task.assignment.runTaskId;
          delete task.assignment.completedAt;
          delete task.assignment.lastResult;
          delete task.assignment.error;
          delete task.assignment.leaseId;
          delete task.assignment.heartbeatAt;
          delete task.assignment.leaseExpiresAt;
          if (input.clearAssignee !== false) {
            delete task.assignedAgent;
            delete task.assignee;
          }
          task.status = areDependenciesMet(board, task.id) ? 'ready' : 'blocked';
          delete task.completedAt;
        }
      }

      syncTaskColumnForStatus(board, task, previousColumnId);
      task.updatedAt = now;
      board.updatedAt = now;
      recoveredTasks.push({
        ...task,
        assignment: task.assignment ? { ...task.assignment } : undefined,
      });
      events.push(
        createKanbanEvent(board.id, task, 'task.stale_recovered', {
          before: beforeAssignment,
          after: task.assignment ? { ...task.assignment } : undefined,
          note: reason,
        }),
      );
    }
    return recoveredTasks.length ? recoveredTasks : null;
  });
  if (updated) {
    for (const staleEvent of events) await emitKanbanEvent(projectRoot, staleEvent);
  }
  return updated?.result ? { board: updated.board, tasks: updated.result } : null;
}

export async function claimReadyTask(
  projectRoot: string,
  input: ClaimKanbanTaskInput = {},
): Promise<{ board: KanbanBoard; task: KanbanTask } | null> {
  if (input.boardId) return claimReadyTaskOnBoard(projectRoot, input.boardId, input);
  for (const board of await listBoards(projectRoot)) {
    const claimed = await claimReadyTaskOnBoard(projectRoot, board.id, input);
    if (claimed) return claimed;
  }
  return null;
}

export async function releaseTaskClaim(
  projectRoot: string,
  boardId: string,
  taskId: string,
  input: ReleaseKanbanTaskClaimInput = {},
): Promise<KanbanBoard | null> {
  let event: KanbanEvent | undefined;
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    if (!task) return null;
    const previousColumnId = task.columnId;
    const beforeAssignment = task.assignment ? { ...task.assignment } : undefined;
    delete task.assignment;
    if (input.clearAssignee !== false) {
      delete task.assignedAgent;
      delete task.assignee;
    }
    task.status = input.status ?? (areDependenciesMet(board, task.id) ? 'ready' : 'blocked');
    delete task.completedAt;
    const now = nowIso();
    if (input.reason) {
      task.notes = [
        ...(task.notes ?? []),
        {
          id: randomUUID(),
          author: 'system',
          content: `Claim released: ${input.reason}`,
          createdAt: now,
        },
      ];
    }
    syncTaskColumnForStatus(board, task, previousColumnId);
    task.updatedAt = now;
    board.updatedAt = now;
    event = createKanbanEvent(board.id, task, 'task.released', {
      before: beforeAssignment,
      after: undefined,
      note: input.reason,
    });
    return task;
  });
  if (updated && event) await emitKanbanEvent(projectRoot, event);
  return updated?.result ? updated.board : null;
}

export async function getKanbanOrchestrationSnapshot(
  projectRoot: string,
  input: KanbanSearchInput = {},
): Promise<KanbanOrchestrationSnapshot> {
  const boards = input.boardId
    ? [await getBoard(projectRoot, input.boardId)].filter((board): board is KanbanBoard =>
        Boolean(board),
      )
    : await Promise.all(
        (await listBoards(projectRoot)).map((board) => getBoard(projectRoot, board.id)),
      ).then((items) => items.filter((board): board is KanbanBoard => Boolean(board)));
  const snapshot: KanbanOrchestrationSnapshot = {
    generatedAt: nowIso(),
    boards: boards.map((board) => summarizeBoard(board)),
    ready: [],
    queued: [],
    running: [],
    blocked: [],
    review: [],
    failed: [],
    completed: [],
  };
  for (const board of boards) {
    const summary = summarizeBoard(board);
    for (const task of board.tasks) {
      if (!matchesKanbanSearch(board, task, input)) continue;
      const result = { board: summary, task };
      if (isTaskReadyForWork(board, task)) snapshot.ready.push(result);
      if (task.assignment?.status === 'queued' || task.assignment?.status === 'assigned') {
        snapshot.queued.push(result);
      }
      if (task.assignment?.status === 'running' || task.status === 'in_progress') {
        snapshot.running.push(result);
      }
      if (task.status === 'blocked' || !areDependenciesMet(board, task.id)) {
        snapshot.blocked.push(result);
      }
      if (task.status === 'review') snapshot.review.push(result);
      if (task.status === 'failed' || task.assignment?.status === 'failed')
        snapshot.failed.push(result);
      if (task.status === 'completed') snapshot.completed.push(result);
    }
  }
  return snapshot;
}

/**
 * Operational health summary. See `KanbanQueueHealth` for the full contract.
 *
 * Implementation notes:
 *   * Per-status counts are computed against the current state of every
 *     queried board (the same source `getKanbanOrchestrationSnapshot`
 *     consumes).
 *   * `dependencyBlocked` deduplicates `counts.ready` — a task ready but
 *     blocked by dependencies only appears in the blocked bucket.
 *   * `staleAssignments` and `heartbeatDue` use `now ?? real-wall-clock`;
 *     callers (notably the recovery loop) should pass an explicit
 *     timestamp so time is deterministic.
 *   * `lastDispatchedAt` / `lastStaleRecoveredAt` come from the append-only
 *     event log so dashboards do not need to rescan tasks.
 */
export async function getKanbanQueueHealth(
  projectRoot: string,
  input: { boardId?: string; now?: string; heartbeatIntervalMs?: number } = {},
): Promise<KanbanQueueHealth> {
  const heartbeatIntervalMs = input.heartbeatIntervalMs ?? 60_000;
  const now = input.now ?? nowIso();
  const boards = await collectBoardsForHealth(projectRoot, input.boardId);
  const boardIds = boards.map((board) => board.id);

  const counts = {
    ready: 0,
    queued: 0,
    running: 0,
    review: 0,
    failed: 0,
    completed: 0,
    pending: 0,
    archived: 0,
    blocked: 0,
  };
  const dependencyBlocked: KanbanSearchResult[] = [];
  const staleAssignments: KanbanSearchResult[] = [];
  const failedRetryable: KanbanSearchResult[] = [];
  const heartbeatDue: KanbanSearchResult[] = [];

  for (const board of boards) {
    const summary = summarizeBoard(board);
    for (const task of board.tasks) {
      const assignment = task.assignment;
      const dependencyUnmet = !areDependenciesMet(board, task.id);
      const isRunning =
        task.status === 'in_progress' ||
        (assignment !== undefined && assignment.status === 'running');
      const isQueued =
        assignment !== undefined &&
        (assignment.status === 'queued' || assignment.status === 'assigned');
      if (task.status === 'ready' && !isRunning) {
        counts.ready += 1;
      } else {
        counts[task.status as keyof typeof counts] += 1;
      }
      if (isRunning) counts.running += 1;
      if (isQueued) counts.queued += 1;
      const readyButBlocked = task.status === 'ready' && dependencyUnmet;
      const pendingButBlocked = task.status === 'pending' && dependencyUnmet;
      if (readyButBlocked || pendingButBlocked) {
        dependencyBlocked.push({ board: summary, task });
      }
      const expiredLease =
        assignment !== undefined &&
        (assignment.status === 'queued' || assignment.status === 'running') &&
        assignment.leaseExpiresAt !== undefined &&
        assignment.leaseExpiresAt <= now;
      if (expiredLease) {
        staleAssignments.push({ board: summary, task });
      }
      if (
        assignment &&
        assignment.status === 'running' &&
        assignment.leaseExpiresAt !== undefined &&
        msUntilExpiry(assignment.leaseExpiresAt, now) <= heartbeatIntervalMs
      ) {
        heartbeatDue.push({ board: summary, task });
      }
      if (
        task.status === 'failed' &&
        assignment &&
        assignment.maxAttempts !== undefined &&
        (assignment.attempt ?? 0) < assignment.maxAttempts
      ) {
        failedRetryable.push({ board: summary, task });
      }
    }
  }

  let lastDispatchedAt: string | undefined;
  let lastStaleRecoveredAt: string | undefined;
  for (const boardId of boardIds) {
    const events = await readKanbanEvents(projectRoot, boardId);
    for (const event of events) {
      if (event.type === 'task.assignment.running') {
        lastDispatchedAt = later(lastDispatchedAt, event.ts);
      } else if (event.type === 'task.stale_recovered') {
        lastStaleRecoveredAt = later(lastStaleRecoveredAt, event.ts);
      }
    }
  }

  return {
    generatedAt: now,
    boardIds,
    counts,
    dependencyBlocked: { count: dependencyBlocked.length, tasks: dependencyBlocked },
    staleAssignments: { count: staleAssignments.length, tasks: staleAssignments },
    failedRetryable: { count: failedRetryable.length, tasks: failedRetryable },
    heartbeatDue: { count: heartbeatDue.length, tasks: heartbeatDue },
    ...(lastDispatchedAt !== undefined ? { lastDispatchedAt } : {}),
    ...(lastStaleRecoveredAt !== undefined ? { lastStaleRecoveredAt } : {}),
  };
}
