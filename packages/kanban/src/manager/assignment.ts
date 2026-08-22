import { randomUUID } from 'node:crypto';
import { evaluateContractGraph, evaluateContractGraphReadiness } from '../contract-graph.js';
import { mutateBoard, summarizeBoard } from '../storage.js';
import type {
  KanbanAgentAssignment,
  KanbanAgentRunStatus,
  KanbanBoard,
  KanbanBoardKind,
  KanbanEvent,
  KanbanEventContext,
  KanbanRecoveryMode,
  KanbanTask,
} from '../types.js';
import type {
  AssignKanbanTaskInput,
  ClaimKanbanTaskInput,
  HeartbeatKanbanTaskAssignmentInput,
  KanbanOrchestrationSnapshot,
  KanbanQueueHealth,
  KanbanSearchInput,
  KanbanSearchResult,
  ReconcileKanbanBoardResult,
  RecoverStaleKanbanAssignmentsInput,
  RecoverStaleKanbanAssignmentsResult,
  ReleaseKanbanTaskClaimInput,
} from '../types-operations.js';
import { resolveGateEnforcement } from '../verification/completion-gate.js';
import {
  assignmentEventType,
  buildAssignment,
  claimReadyTaskOnBoard,
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
import { collectBoardsForHealth } from './board-health.js';
import { dependencyIncompleteMessage, getDependencyReadinessIssues } from './task-readiness.js';

/**
 * Staleness window for queued/running assignments that carry NO lease stamp
 * ('running_no_lease'). A live agent heartbeats well inside this; ten
 * minutes of total silence with no lease to expire means the owner is gone.
 * Deliberately generous — recovery of a live claim is worse than a late
 * recovery of a dead one.
 */
const STAMPLESS_ASSIGNMENT_STALE_MS = 10 * 60 * 1000;

import { resolveKindFilter } from './board-kind-filter.js';
import { getBoard, listBoards } from './boards.js';
import { areDependenciesMet } from './dependencies.js';
import { KanbanLifecycleError, StaleWriteError, transitionTask } from './lifecycle.js';
import { classifyTaskForQueue } from './task-classifier.js';

let lastGlobalClaimBoardId: string | undefined;

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
    // Managed cards are advanced only through transitionTask. Assignment
    // telemetry must never manufacture Review or Done on their behalf.
    if (board.lifecycle?.mode === 'managed') return null;
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
        else if (
          resolveGateEnforcement(board) === 'strict' &&
          task.status !== 'completed' &&
          task.verificationReport?.verdict !== 'passed'
        ) {
          // Strict boards: reconcile promotes at most to review; only
          // finalizeTaskCompletion (or an already-passed report) completes.
          // Soft boards keep the historical check-flag behavior so the
          // deterministic supervisor never blocks.
          desiredStatus = 'review';
        } else desiredStatus = 'completed';
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
  eventContext: KanbanEventContext = {},
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
      ...eventContext,
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
  eventContext: KanbanEventContext = {},
): Promise<KanbanBoard | null> {
  let event: KanbanEvent | undefined;
  let gatePending = false;
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    if (!task) return null;
    // Fencing: if expectedLeaseId is set, only apply the patch when we still
    // own the lease. Checked inside the board mutation lock so a recovered-
    // and-reassigned task whose leaseId changed cannot be overwritten by a
    // stale owner's terminal write between the check and the mutation.
    if (
      eventContext.expectedLeaseId !== undefined &&
      task.assignment?.leaseId !== eventContext.expectedLeaseId
    ) {
      return null;
    }
    const nextStatus = patch.status ?? task.assignment?.status;
    if (nextStatus === 'running') {
      const dependencyIssues = getDependencyReadinessIssues(board, task);
      if (dependencyIssues.length > 0) {
        // One definition, shared with the lifecycle gate: which wording a
        // caller saw used to depend on whether it arrived via transition_task
        // or mark_assignment, and only one of the copies named the escape.
        const message = dependencyIncompleteMessage(dependencyIssues);
        throw new KanbanLifecycleError(message, [
          { code: 'dependency-incomplete', field: 'dependsOn', message },
        ]);
      }
    }
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
    if (board.lifecycle?.mode === 'managed') {
      if (task.assignment.status === 'completed') {
        // On managed boards, the lifecycle stage governs task completion, not
        // the assignment status. Workers persist their result here (lastResult,
        // completedAt) but the lifecycle is advanced separately via
        // transitionTask Running → Review → Done. This is the documented
        // two-step pattern: mark_assignment to record the result, then
        // transitionTask to advance the card.
        task.assignment.completedAt = task.assignment.completedAt ?? nowIso();
      } else if (task.assignment.status === 'running') {
        task.assignment.dispatchedAt = task.assignment.dispatchedAt ?? nowIso();
        delete task.assignment.completedAt;
      } else if (task.assignment.status === 'failed') {
        delete task.assignment.completedAt;
        if (patch.error === undefined) delete task.assignment.error;
      } else if (task.assignment.status === 'cancelled') {
        delete task.assignment.completedAt;
        if (patch.error === undefined) delete task.assignment.error;
      } else if (task.assignment.status === 'queued' || task.assignment.status === 'assigned') {
        delete task.assignment.completedAt;
        if (patch.error === undefined) delete task.assignment.error;
      }
      // Keep the card's managed column/status/lifecycle intact. The worker must
      // persist its result, then explicitly transition Running -> Review.
      task.updatedAt = nowIso();
      board.updatedAt = task.updatedAt;
      event = createKanbanEvent(board.id, task, assignmentEventType(task.assignment.status), {
        ...eventContext,
        before: beforeAssignment,
        after: { ...task.assignment },
        note: patch.error ?? patch.lastResult,
      });
      if (task.assignment.status === 'running') board.lastDispatchedAt = nowIso();
      return task;
    }
    if (task.assignment.status === 'completed') {
      task.assignment.completedAt = task.assignment.completedAt ?? nowIso();
      if (patch.error === undefined) delete task.assignment.error;
      if (resolveGateEnforcement(board) !== 'off') {
        // Universal completion gate: a worker's "completed" is a claim, not a
        // final state. Park in review; finalizeTaskCompletion() (async — the
        // verifier cannot run inside this synchronous mutation) verifies and
        // applies the final status. Callers: tools mark_assignment, WebUI
        // dispatch onDone, and the supervisor sweep for third-party writers.
        task.status = 'review';
        delete task.completedAt;
        gatePending = true;
      } else {
        task.status = 'completed';
        task.completedAt = task.assignment.completedAt;
      }
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
      // 'review' included: a gate-parked completion being re-queued must
      // return to the work queue, not linger in review.
      if (task.status === 'completed' || task.status === 'failed' || task.status === 'review') {
        task.status = task.assignment.status === 'queued' ? 'ready' : 'pending';
      }
      delete task.completedAt;
    }
    syncTaskColumnForStatus(board, task, previousColumnId);
    task.updatedAt = nowIso();
    board.updatedAt = task.updatedAt;
    event = createKanbanEvent(board.id, task, assignmentEventType(task.assignment.status), {
      ...eventContext,
      before: beforeAssignment,
      after: { ...task.assignment },
      note: patch.error ?? patch.lastResult,
    });
    if (task.assignment.status === 'running') board.lastDispatchedAt = nowIso();
    return task;
  });
  if (updated && event) await emitKanbanEvent(projectRoot, event);
  if (updated?.result && gatePending) {
    await emitKanbanEvent(
      projectRoot,
      createKanbanEvent(updated.board.id, updated.result, 'task.completion.gate_pending', {
        ...eventContext,
        after: { assignmentStatus: 'completed' },
      }),
    );
  }
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
    // Fencing: if expectedLeaseId is set, only renew when we still own the
    // lease. This check runs inside the board mutation lock so it's atomic —
    // a recovered-and-reassigned task whose leaseId changed cannot be renewed
    // by a stale owner between the check and the write.
    if (input.expectedLeaseId !== undefined && task.assignment.leaseId !== input.expectedLeaseId) {
      return null;
    }
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
  /**
   * Managed cards whose lifecycle stage must be walked back after the board
   * mutation commits. The recovery below clears the assignment but leaves the
   * stage alone (the stage is authoritative on a managed board and a raw
   * status→column sync would corrupt it). That left the card in Running with
   * no assignment — which `classifyTaskForQueue` reads as `running_no_lease`,
   * i.e. NOT claimable. The card was recovered into a state nothing could pick
   * up again without a human running repair_managed_projection.
   *
   * `transitionTask` is itself a `mutateBoard` call and cannot be nested inside
   * this closure, so the ids are collected here and walked back afterwards —
   * the same sequential shape `completeKanbanDispatch` uses in dispatch.ts.
   *
   * Related: on a managed board the release/retry branches below clear
   * `assignedAgent` but keep `assignee`. `assignee` is a REQUIRED card detail
   * there — `validateRequiredCardDetails` demands it before Todo → Running —
   * so deleting it walked the card back into a Todo it could never leave.
   * (What survives is whatever last claimed the card: `assignTask` overwrites
   * `assignee` with the worker's name when the caller does not pass one. That
   * conflation of owner and worker predates this code; the point here is only
   * that a required field must not be emptied by recovery.) On a legacy board
   * `assignee` is purely the worker record, so there it is still cleared.
   */
  const managedNeedingRequeue: Array<{ taskId: string; mode: KanbanRecoveryMode }> = [];
  const requestedMode = input.mode ?? 'retry';
  const checkedAt = input.now ?? nowIso();
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const isManaged = board.lifecycle?.mode === 'managed';
    for (const task of board.tasks) {
      const assignment = task.assignment;
      if (!assignment || (assignment.status !== 'queued' && assignment.status !== 'running')) {
        continue;
      }
      // Two staleness signals:
      //  - a stamped lease that has expired, or
      //  - NO lease stamp at all and prolonged silence. The old
      //    `!leaseExpiresAt → continue` skipped stampless assignments
      //    forever — a claim written without a lease (the state the
      //    classifier names 'running_no_lease', which the retry path below
      //    itself produces by deleting the stamp) could never be recovered:
      //    the agent dies, the task stays locked for good.
      const leaseExpired =
        assignment.leaseExpiresAt !== undefined && assignment.leaseExpiresAt <= checkedAt;
      const lastSignalAt = assignment.heartbeatAt ?? assignment.claimedAt;
      const stamplessAndSilent =
        assignment.leaseExpiresAt === undefined &&
        (lastSignalAt === undefined ||
          new Date(checkedAt).getTime() - new Date(lastSignalAt).getTime() >=
            STAMPLESS_ASSIGNMENT_STALE_MS);
      if (!leaseExpired && !stamplessAndSilent) continue;
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
        // Managed boards: preserve lifecycle stage. Only the assignment
        // status changes — the card's lifecycle column is authoritative and
        // must not be overridden by a raw status→column sync. A reviewer
        // or repair_managed_projection can correct the stage if needed.
        if (!isManaged) task.status = 'failed';
        delete task.completedAt;
      } else if (mode === 'release') {
        delete task.assignment;
        if (input.clearAssignee !== false) {
          delete task.assignedAgent;
          if (!isManaged) delete task.assignee;
        }
        // Managed boards: keep the card in its current lifecycle stage
        // (e.g. 'running'). The lifecycle transition todo→running is
        // irreversible on managed boards — releasing a claim does not move
        // the card backward. Use repair_managed_projection or manual
        // transition to correct the stage if rollback is desired.
        if (!isManaged) {
          task.status = areDependenciesMet(board, task.id) ? 'ready' : 'blocked';
        }
        delete task.completedAt;
      } else {
        const nextAttempt = (assignment.attempt ?? 0) + 1;
        if (assignment.maxAttempts !== undefined && nextAttempt > assignment.maxAttempts) {
          assignment.status = 'failed';
          assignment.error = `${reason}; max attempts exceeded (${assignment.maxAttempts})`;
          delete assignment.completedAt;
          if (!isManaged) task.status = 'failed';
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
          // The dead agent no longer owns this task. Keeping its agentId
          // made the retried record look OWNED, and an owned 'assigned'
          // assignment blocks claiming (isTaskReadyForWork) — the retry
          // would strand. Dropping the identity turns it into the same
          // ownerless configuration template assignTask-without-agentId
          // produces: routing/skills survive, the next claimer fills in
          // its own identity.
          delete task.assignment.agentId;
          if (input.clearAssignee !== false) {
            delete task.assignedAgent;
            if (!isManaged) delete task.assignee;
          }
          // Managed boards: retry keeps the card in its current lifecycle
          // stage. The task is re-queued for dispatch but does not move
          // backward in the lifecycle.
          if (!isManaged) {
            task.status = areDependenciesMet(board, task.id) ? 'ready' : 'blocked';
          }
          delete task.completedAt;
        }
      }

      // Only sync column for non-managed boards. Managed boards have
      // lifecycle-authoritative columns that must not be overridden by
      // status-based projection.
      if (!isManaged) {
        syncTaskColumnForStatus(board, task, previousColumnId);
      }
      task.updatedAt = now;
      board.updatedAt = now;
      board.lastStaleRecoveredAt = now;
      // Only a card sitting in Running needs walking back, and only when the
      // work is actually going to be attempted again. Read that from the state
      // the branches above just produced, not from the requested mode: `retry`
      // with an exhausted budget lands in exactly the same terminal `failed`
      // state as `fail`, and keying on the mode walked those cards back to Todo
      // — straight into the next claimer, which fails them again. A loop.
      //
      // Claimable-again means: the assignment was released (gone), or it was
      // re-queued for another attempt ('assigned'). Anything else stays in
      // Running for a human.
      const requeueable = task.assignment === undefined || task.assignment.status === 'assigned';
      if (isManaged && requeueable && task.lifecycle?.currentStage === 'running') {
        managedNeedingRequeue.push({ taskId: task.id, mode });
      }
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
  if (!updated?.result) return null;

  // Walk recovered managed cards back to Todo so the queue can serve them
  // again. Running → Todo is a legal single step backwards, and backward
  // transitions skip the card-detail guard, so this cannot fail on a card that
  // was already good enough to be dispatched. Best-effort: the recovery itself
  // has already committed, and a failed walk-back leaves exactly the state that
  // existed before this fix — recoverable with repair_managed_projection.
  let board = updated.board;
  for (const { taskId, mode } of managedNeedingRequeue) {
    try {
      const walked = await transitionTask(projectRoot, boardId, taskId, {
        to: 'todo',
        actor: 'kanban-supervisor',
        comment: `Stale assignment recovered (${mode}); card returned to the work queue.`,
      });
      if (walked) board = walked.board;
    } catch (error) {
      process.stderr.write(
        `[kanban] recoverStaleTaskAssignments: could not return task ${taskId} to Todo: ` +
          `${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
  return { board, tasks: updated.result };
}

export async function claimReadyTask(
  projectRoot: string,
  input: ClaimKanbanTaskInput & {
    includeBoardKinds?: readonly KanbanBoardKind[];
    excludeBoardKinds?: readonly KanbanBoardKind[];
  } = {},
): Promise<{ board: KanbanBoard; task: KanbanTask } | null> {
  if (input.boardId) return claimReadyTaskOnBoard(projectRoot, input.boardId, input);
  const kindResolved = resolveKindFilter({
    ...(input.includeBoardKinds !== undefined
      ? { includeBoardKinds: input.includeBoardKinds }
      : {}),
    ...(input.excludeBoardKinds !== undefined
      ? { excludeBoardKinds: input.excludeBoardKinds }
      : {}),
  });
  const boards = await listBoards(projectRoot);
  // Deterministic ordering: most-recently-active boards first, then rotate the
  // start point after the last successful global claim. A claim updates the
  // winning board's `updatedAt`; without rotation, the newest board can keep
  // sorting first and starve ready tasks on older boards.
  // Session mirrors and archived boards are excluded by default.
  const ordered = boards
    .filter((summary) => {
      const kind = summary.kind ?? 'project';
      if (kindResolved.include) return kindResolved.include.has(kind);
      return !kindResolved.exclude.has(kind);
    })
    .sort((a, b) => {
      const aTime = Date.parse(a.updatedAt ?? a.createdAt ?? 0);
      const bTime = Date.parse(b.updatedAt ?? b.createdAt ?? 0);
      if (aTime !== bTime) return bTime - aTime;
      return a.id.localeCompare(b.id);
    });
  const lastClaimIndex = ordered.findIndex((board) => board.id === lastGlobalClaimBoardId);
  const rotated =
    lastClaimIndex >= 0
      ? [...ordered.slice(lastClaimIndex + 1), ...ordered.slice(0, lastClaimIndex + 1)]
      : ordered;
  for (const board of rotated) {
    try {
      const claimed = await claimReadyTaskOnBoard(projectRoot, board.id, input);
      if (claimed) {
        lastGlobalClaimBoardId = claimed.board.id;
        return claimed;
      }
    } catch (error) {
      // A stale-write error on this board means another agent claimed the
      // ready task before us. Continue to the next board instead of failing
      // the whole claim — another board may have ready tasks.
      if (error instanceof StaleWriteError) {
        continue;
      }
      throw error;
    }
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
    // Fencing, mirroring updateTaskAssignment/heartbeat: a zombie agent
    // whose task was recovered and reassigned must not delete the LIVE
    // owner's claim. Checked inside the board mutation lock; callers that
    // omit the token (operator-driven manual release) stay unconditional.
    if (input.expectedLeaseId !== undefined && task.assignment?.leaseId !== input.expectedLeaseId) {
      return null;
    }
    const isManaged = board.lifecycle?.mode === 'managed';
    const previousColumnId = task.columnId;
    const beforeAssignment = task.assignment ? { ...task.assignment } : undefined;
    delete task.assignment;
    if (input.clearAssignee !== false) {
      delete task.assignedAgent;
      delete task.assignee;
    }
    // Managed boards: preserve lifecycle stage. The card stays in its
    // current column (e.g. 'running'). Lifecycle columns are authoritative —
    // releasing a claim does not move a managed card backward. Use
    // repair_managed_projection or manual transition to correct the stage.
    if (!isManaged) {
      task.status = input.status ?? (areDependenciesMet(board, task.id) ? 'ready' : 'blocked');
    }
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
    // Only sync column for non-managed boards.
    if (!isManaged) {
      syncTaskColumnForStatus(board, task, previousColumnId);
    }
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
  input: KanbanSearchInput & {
    includeBoardKinds?: readonly KanbanBoardKind[];
    excludeBoardKinds?: readonly KanbanBoardKind[];
  } = {},
): Promise<KanbanOrchestrationSnapshot> {
  const kindResolved = resolveKindFilter({
    ...(input.includeBoardKinds !== undefined
      ? { includeBoardKinds: input.includeBoardKinds }
      : {}),
    ...(input.excludeBoardKinds !== undefined
      ? { excludeBoardKinds: input.excludeBoardKinds }
      : {}),
  });
  const boards = input.boardId
    ? [await getBoard(projectRoot, input.boardId)].filter((board): board is KanbanBoard =>
        Boolean(board),
      )
    : await Promise.all(
        (await listBoards(projectRoot))
          .filter((summary) => {
            const kind = summary.kind ?? 'project';
            if (kindResolved.include) return kindResolved.include.has(kind);
            return !kindResolved.exclude.has(kind);
          })
          .map((board) => getBoard(projectRoot, board.id)),
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
      const readiness =
        board.kind === 'session_mirror'
          ? undefined
          : evaluateContractGraphReadiness(board, task.id);
      const completion =
        board.kind === 'session_mirror' ? undefined : evaluateContractGraph(board, task.id);
      const result: KanbanSearchResult = {
        board: summary,
        task,
        ...(readiness && completion
          ? {
              contractStatus: {
                enforcement: completion.enforcement,
                startReady: readiness.ready,
                setupGaps: readiness.issues.length,
                completionOpen: completion.issues.length,
                closed: readiness.ready && completion.issues.length === 0,
              },
            }
          : {}),
      };
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
 *   * `counts.ready` tallies the stored `status` field; `counts.startable` is
 *     the derived "can be started now" count that agrees with
 *     `listReadyTasks`. Display surfaces want `startable`.
 *   * `staleAssignments` and `heartbeatDue` use `now ?? real-wall-clock`;
 *     callers (notably the recovery loop) should pass an explicit
 *     timestamp so time is deterministic.
 *   * `lastDispatchedAt` / `lastStaleRecoveredAt` come from the append-only
 *     event log so dashboards do not need to rescan tasks.
 */
export async function getKanbanQueueHealth(
  projectRoot: string,
  input: {
    boardId?: string;
    now?: string;
    heartbeatIntervalMs?: number;
    includeBoardKinds?: readonly KanbanBoardKind[];
    excludeBoardKinds?: readonly KanbanBoardKind[];
    /**
     * `classifications.diagnostics` carries one entry per non-clean task, which
     * is the only channel telling an agent *why* a card is unclaimable — so it
     * stays on by default. Pass `false` from surfaces that render counts and
     * never read the reasons (the WebUI polls health every five seconds); the
     * diagnostics array is the bulk of the payload.
     */
    includeClassifications?: boolean;
  } = {},
): Promise<KanbanQueueHealth> {
  const heartbeatIntervalMs = input.heartbeatIntervalMs ?? 60_000;
  const now = input.now ?? nowIso();
  const boards = await collectBoardsForHealth(projectRoot, input.boardId, {
    ...(input.includeBoardKinds !== undefined
      ? { includeBoardKinds: input.includeBoardKinds }
      : {}),
    ...(input.excludeBoardKinds !== undefined
      ? { excludeBoardKinds: input.excludeBoardKinds }
      : {}),
  });
  const boardIds = boards.map((board) => board.id);

  const counts = {
    ready: 0,
    startable: 0,
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
  const classificationCounts = {
    claimable: 0,
    stage_blocked: 0,
    detail_incomplete: 0,
    dependency_blocked: 0,
    queued: 0,
    queued_expired: 0,
    running_live: 0,
    running_expired: 0,
    running_no_lease: 0,
    review: 0,
    failed_retryable: 0,
    failed_terminal: 0,
    completed: 0,
    archived: 0,
    not_dispatchable: 0,
  };
  const classificationDiagnostics: NonNullable<
    KanbanQueueHealth['classifications']
  >['diagnostics'] = [];

  for (const board of boards) {
    const summary = summarizeBoard(board);
    for (const task of board.tasks) {
      const assignment = task.assignment;
      const result = { board: summary, task };
      const classification = classifyTaskForQueue(board, task, { now, heartbeatIntervalMs });
      classificationCounts[classification.bucket] += 1;
      if (input.includeClassifications !== false && classification.reasons.length > 0) {
        classificationDiagnostics.push({
          boardId: board.id,
          taskId: task.id,
          bucket: classification.bucket,
          reasons: [...classification.reasons],
          ...(classification.managedStage !== undefined
            ? { managedStage: classification.managedStage }
            : {}),
        });
      }
      const dependencyUnmet = !areDependenciesMet(board, task.id);
      const isRunning =
        task.status === 'in_progress' ||
        (assignment !== undefined && assignment.status === 'running');
      const isQueued =
        assignment !== undefined &&
        (assignment.status === 'queued' || assignment.status === 'assigned');
      // Each task is counted exactly once. The semantic priority for the
      // canonical bucket is: running > queued/assigned > raw task status.
      // Previously running/queued were additive extras on top of the raw
      // status count, which inflated totals (a running-assignment task with
      // ready status showed in both ready and running).
      if (isRunning) {
        counts.running += 1;
      } else if (isQueued) {
        counts.queued += 1;
      } else {
        counts[task.status as keyof typeof counts] += 1;
      }
      // Derived readiness, computed with the same predicate `listReadyTasks`
      // uses, so the two surfaces cannot disagree about the same board.
      if (isTaskReadyForWork(board, task)) counts.startable += 1;
      const readyButBlocked = task.status === 'ready' && dependencyUnmet;
      const pendingButBlocked = task.status === 'pending' && dependencyUnmet;
      if (readyButBlocked || pendingButBlocked) {
        dependencyBlocked.push(result);
      }
      const expiredLease =
        assignment !== undefined &&
        (assignment.status === 'queued' || assignment.status === 'running') &&
        assignment.leaseExpiresAt !== undefined &&
        assignment.leaseExpiresAt <= now;
      if (expiredLease) {
        staleAssignments.push(result);
      }
      if (
        assignment &&
        assignment.status === 'running' &&
        assignment.leaseExpiresAt !== undefined &&
        msUntilExpiry(assignment.leaseExpiresAt, now) <= heartbeatIntervalMs
      ) {
        heartbeatDue.push(result);
      }
      if (
        task.status === 'failed' &&
        assignment &&
        assignment.maxAttempts !== undefined &&
        (assignment.attempt ?? 0) < assignment.maxAttempts
      ) {
        failedRetryable.push(result);
      }
    }
  }

  // Read cached timestamps from the persisted board record instead of scanning
  // the full event log. These are set atomically by updateTaskAssignment
  // (for lastDispatchedAt) and recoverStaleTaskAssignments (for lastStaleRecoveredAt).
  let lastDispatchedAt: string | undefined;
  let lastStaleRecoveredAt: string | undefined;
  for (const board of boards) {
    if (board.lastDispatchedAt !== undefined) {
      lastDispatchedAt = later(lastDispatchedAt, board.lastDispatchedAt);
    }
    if (board.lastStaleRecoveredAt !== undefined) {
      lastStaleRecoveredAt = later(lastStaleRecoveredAt, board.lastStaleRecoveredAt);
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
    ...(input.includeClassifications === false
      ? {}
      : {
          classifications: {
            counts: classificationCounts,
            diagnostics: classificationDiagnostics,
          },
        }),
    ...(lastDispatchedAt !== undefined ? { lastDispatchedAt } : {}),
    ...(lastStaleRecoveredAt !== undefined ? { lastStaleRecoveredAt } : {}),
  };
}
