import { randomUUID } from 'node:crypto';
import { assertManagementWrite } from '../management-fence.js';
import { mutateBoard, readBoard } from '../storage.js';
import type {
  KanbanAgentAssignment,
  KanbanAgentRunStatus,
  KanbanBoard,
  KanbanBoardKind,
  KanbanEvent,
  KanbanEventContext,
  KanbanTask,
} from '../types.js';
import type {
  AssignKanbanTaskInput,
  ClaimKanbanTaskInput,
  HeartbeatKanbanTaskAssignmentInput,
  ReconcileKanbanBoardResult,
  ReleaseKanbanTaskClaimInput,
} from '../types-operations.js';
import { resolveGateEnforcement } from '../verification/completion-gate.js';
import { verificationStateFingerprint } from '../verification/task-inputs.js';
import { VerificationContext } from '../verification/verification-context.js';
import {
  applyCompletedAtForStatus,
  assignmentEventType,
  buildAssignment,
  claimReadyTaskOnBoard,
  createKanbanEvent,
  emitKanbanEvent,
  findTask,
  nowIso,
  syncTaskColumnForStatus,
} from './_internal.js';
import { resolveKindFilter } from './board-kind-filter.js';
import { listBoards } from './boards.js';
import { areDependenciesMet } from './dependencies.js';
import { KanbanLifecycleError, StaleWriteError, validateDefinitionOfDone } from './lifecycle.js';
import { dependencyIncompleteMessage, getDependencyReadinessIssues } from './task-readiness.js';

let lastGlobalClaimBoardId: string | undefined;

async function captureAssignmentBaseline(
  projectRoot: string,
  boardId: string,
  taskId: string,
  status: KanbanAgentRunStatus | undefined,
  leaseId: string | undefined,
  replace: boolean,
) {
  if (status !== 'running') return undefined;
  const board = await readBoard(projectRoot, boardId);
  const task = board ? findTask(board, taskId) : undefined;
  if (
    !board ||
    !task ||
    (!task.expectedFileChanges?.length &&
      !task.successCriteria?.some((check) => check.type === 'git_diff'))
  )
    return undefined;
  if (
    !replace &&
    task.assignment?.status === 'running' &&
    (leaseId === undefined || leaseId === task.assignment.leaseId)
  )
    return undefined;
  const fingerprint = verificationStateFingerprint(board, task);
  const baseline = await new VerificationContext({ projectRoot, board, task }).captureSnapshot();
  return { fingerprint, baseline };
}

function assertBaselineInputs(
  board: KanbanBoard,
  taskId: string,
  capture: { fingerprint: string } | undefined,
): void {
  if (!capture) return;
  const task = findTask(board, taskId);
  if (!task || verificationStateFingerprint(board, task) !== capture.fingerprint) {
    throw new StaleWriteError(
      'Stale write detected: the task contract or ownership changed while capturing the pre-work verification baseline. Retry starting the task.',
    );
  }
}

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
  eventContext: KanbanEventContext,
): Promise<ReconcileKanbanBoardResult | null> {
  const reconciled: KanbanTask[] = [];
  const events: KanbanEvent[] = [];
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    // Managed cards are advanced only through transitionTask. Assignment
    // telemetry must never manufacture Review or Done on their behalf.
    if (board.lifecycle?.mode === 'managed') return null;
    for (const task of board.tasks) {
      if (task.status === 'archived' || task.mergedIntoTaskId) continue;
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
          (task.verificationReport?.verdict !== 'passed' ||
            validateDefinitionOfDone(task, task.verificationReport, { board }).length > 0)
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
          ...eventContext,
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
  eventContext: KanbanEventContext,
): Promise<KanbanBoard | null> {
  const capture = await captureAssignmentBaseline(
    projectRoot,
    boardId,
    taskId,
    input.status,
    input.leaseId,
    true,
  );
  let event: KanbanEvent | undefined;
  const updated = await mutateBoard(projectRoot, boardId, async (board) => {
    assertBaselineInputs(board, taskId, capture);
    const task = findTask(board, taskId);
    if (!task) return null;
    await assertManagementWrite(projectRoot, board, [task], eventContext);
    if (task.status === 'archived' || task.mergedIntoTaskId) {
      throw new Error(`Cannot assign inactive task ${task.id}.`);
    }
    const before = task.assignment ? { ...task.assignment } : undefined;
    if (
      input.protectActiveAssignment === true &&
      (before?.status === 'queued' || before?.status === 'running')
    ) {
      throw new Error(
        `Task ${taskId} has an active ${before.status} assignment; release or stop it before reassignment.`,
      );
    }
    const assignment = buildAssignment(input);
    if (capture?.baseline.treeHash) assignment.verificationBaseline = capture.baseline;
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
  eventContext: KanbanEventContext,
): Promise<KanbanBoard | null> {
  const capture = await captureAssignmentBaseline(
    projectRoot,
    boardId,
    taskId,
    patch.status,
    patch.leaseId,
    false,
  );
  let event: KanbanEvent | undefined;
  let gatePending = false;
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    assertBaselineInputs(board, taskId, capture);
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
    if (capture) {
      // A new attempt must never inherit the previous attempt's baseline.
      delete task.assignment.verificationBaseline;
      if (capture.baseline.treeHash) task.assignment.verificationBaseline = capture.baseline;
    }
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
  eventContext: KanbanEventContext,
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
      ...eventContext,
      before: beforeAssignment,
      after: { ...task.assignment },
    });
    return task;
  });
  if (updated && event) await emitKanbanEvent(projectRoot, event);
  return updated?.result ? updated.board : null;
}

export async function claimReadyTask(
  projectRoot: string,
  input: ClaimKanbanTaskInput & {
    includeBoardKinds?: readonly KanbanBoardKind[];
    excludeBoardKinds?: readonly KanbanBoardKind[];
  } = {},
  eventContext: KanbanEventContext,
): Promise<{ board: KanbanBoard; task: KanbanTask } | null> {
  if (input.boardId) {
    return claimReadyTaskOnBoard(projectRoot, input.boardId, input, eventContext);
  }
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
      const claimed = await claimReadyTaskOnBoard(projectRoot, board.id, input, eventContext);
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
  eventContext: KanbanEventContext,
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
      if (!isManaged) delete task.assignee;
    }
    // Managed boards: preserve lifecycle stage. The card stays in its
    // current column (e.g. 'running'). Lifecycle columns are authoritative —
    // releasing a claim does not move a managed card backward. Use
    // repair_managed_projection or manual transition to correct the stage.
    if (!isManaged && task.status !== 'archived' && task.status !== 'completed') {
      task.status = input.status ?? (areDependenciesMet(board, task.id) ? 'ready' : 'blocked');
      // Do NOT inline `task.status === 'completed'` here. That comparison is
      // what 5031a6246 removed: the declared `input.status` union
      // ('pending'|'ready'|'blocked') makes TypeScript narrow `task.status`
      // away from 'completed' and fail declaration emit with TS2367. But the
      // union is a COMPILE-time claim only — `releaseTaskClaim` is an
      // IPC-allow-listed domain operation (project-server.ts#domainCall decodes
      // wire args and spreads them into the handler unvalidated), and the WebUI
      // release route asserts `payload.status as 'pending'|'ready'|'blocked'`
      // without checking it. An out-of-union status reaches this line at
      // runtime. Delegating to applyCompletedAtForStatus — the helper that
      // DEFINES this invariant — keeps the repair without reintroducing the
      // narrowing, because the status is read through a parameter rather than
      // compared against a narrowed local.
      applyCompletedAtForStatus(task, nowIso());
    }
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
    // Only sync column for non-managed, non-archived boards.
    if (!isManaged && task.status !== 'archived') {
      syncTaskColumnForStatus(board, task, previousColumnId);
    }
    task.updatedAt = now;
    board.updatedAt = now;
    event = createKanbanEvent(board.id, task, 'task.released', {
      ...eventContext,
      before: beforeAssignment,
      after: undefined,
      note: input.reason,
    });
    return task;
  });
  if (updated && event) await emitKanbanEvent(projectRoot, event);
  return updated?.result ? updated.board : null;
}

export {
  isAssignmentStale,
  recoverStaleTaskAssignments,
  STAMPLESS_ASSIGNMENT_STALE_MS,
} from './assignment-recovery.js';
export { getKanbanOrchestrationSnapshot, getKanbanQueueHealth } from './queue-health.js';
