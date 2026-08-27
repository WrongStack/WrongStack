/**
 * Shared Kanban Dispatch Service — unified orchestration primitives.
 *
 * This module composes existing manager operations (claimReadyTaskOnBoard,
 * updateTaskAssignment, transitionTask, finalizeTaskCompletion,
 * heartbeatTaskAssignment, releaseTaskClaim) into six high-level operations
 * that both the Director (kanban_queue) and WebUI dispatch call instead of
 * manually composing the low-level pieces.
 *
 * Design:
 * - LLM-free: deterministic board mutations only.
 * - Lease-fenced: every operation checks expectedLeaseId so a stale owner
 *   whose lease was recovered cannot corrupt the successor's state.
 * - Managed lifecycle transitions are automatic: startKanbanDispatch calls
 *   transitionTask(todo → running); completeKanbanDispatch calls
 *   transitionTask(running → review). Callers never call transitionTask.
 * - Completion never auto-advances to Done: verification + reviewer
 *   acceptance is always required.
 */

import { randomUUID } from 'node:crypto';
import type {
  KanbanBoard,
  KanbanBoardKind,
  KanbanLinkType,
  KanbanModelRoutingMode,
  KanbanRetryPolicy,
  KanbanTask,
} from '../types.js';
import type { KanbanLifecycleValidationIssue } from '../types-operations.js';
import type { CompletionGateResult } from '../verification/completion-gate.js';
import { finalizeTaskCompletion } from '../verification/completion-gate.js';
import { createKanbanEvent, emitKanbanEvent } from './_internal.js';
import {
  claimReadyTask,
  heartbeatTaskAssignment,
  releaseTaskClaim,
  updateTaskAssignment,
} from './assignment.js';
import { transitionTask } from './lifecycle.js';

// ── Types ───────────────────────────────────────────────────────────

export interface DispatchLease {
  leaseId: string;
  claimedAt: string;
  heartbeatAt: string;
  leaseExpiresAt: string;
}

export interface DispatchRouting {
  agentId?: string | undefined;
  name?: string | undefined;
  role?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  fallbackProfile?: string | undefined;
  fallbackModels?: string[] | undefined;
  modelRouting?: KanbanModelRoutingMode | undefined;
  skills?: string[] | undefined;
  tools?: string[] | undefined;
  allowedCapabilities?: string[] | undefined;
}

export interface DispatchBudget {
  costCeilingUsd?: number | undefined;
  retryPolicy?: KanbanRetryPolicy | undefined;
  maxAttempts?: number | undefined;
}

export interface ReserveDispatchInput {
  /**
   * Session that owns this dispatch. Every board event the operation emits is
   * attributed to it, so a tab can find (and stop) the work it started.
   */
  sessionId: string;
  boardId?: string | undefined;
  taskId?: string | undefined;
  query?: string | undefined;
  routing?: DispatchRouting | undefined;
  budget?: DispatchBudget | undefined;
  leaseTtlMs?: number | undefined;
  heartbeatIntervalMs?: number | undefined;
  includeBoardKinds?: readonly KanbanBoardKind[] | undefined;
  excludeBoardKinds?: readonly KanbanBoardKind[] | undefined;
}

export interface ReserveDispatchResult {
  board: KanbanBoard;
  task: KanbanTask;
  lease: DispatchLease;
}

export interface StartDispatchInput {
  /**
   * Session that owns this dispatch. Every board event the operation emits is
   * attributed to it, so a tab can find (and stop) the work it started.
   */
  sessionId: string;
  boardId: string;
  taskId: string;
  leaseId: string;
  actor: string;
  subagentId?: string | undefined;
  runTaskId?: string | undefined;
}

/**
 * Structured lifecycle-transition failure payload.
 *
 * `startKanbanDispatch`/`completeKanbanDispatch` advance the managed lifecycle
 * as a best-effort step after the lease-fenced assignment mutation has already
 * committed. When that step fails, the assignment is in the desired state but
 * the lifecycle stage is not — a divergence the caller may want to retry or
 * surface. The structured payload avoids forcing callers to parse error
 * messages: `issues` carries the same `KanbanLifecycleValidationIssue[]` that
 * `transitionTask` produced, so a UI can render the same remediation guidance.
 */
export interface DispatchLifecycleError {
  message: string;
  issues: readonly KanbanLifecycleValidationIssue[];
}

export interface StartDispatchResult {
  board: KanbanBoard;
  task: KanbanTask;
  /**
   * Set when the lease-fenced assignment mutation succeeded but the managed
   * lifecycle transition (todo → running) failed. Absent on success. The task
   * is still running with a valid lease; only the lifecycle projection lags.
   */
  lifecycleTransitionError?: DispatchLifecycleError | undefined;
}

export interface CompleteDispatchInput {
  /**
   * Session that owns this dispatch. Every board event the operation emits is
   * attributed to it, so a tab can find (and stop) the work it started.
   */
  sessionId: string;
  boardId: string;
  taskId: string;
  leaseId: string;
  actor: string;
  result?: string | undefined;
  evidence?: { url: string; title: string; type: KanbanLinkType } | undefined;
}

export interface CompleteDispatchResult {
  board: KanbanBoard;
  task: KanbanTask;
  gate?: CompletionGateResult | undefined;
  /**
   * Set when the lease-fenced completion mutation succeeded but the managed
   * lifecycle transition (running → review) or the legacy completion gate
   * failed. Absent on success.
   */
  lifecycleTransitionError?: DispatchLifecycleError | undefined;
}

export interface FailDispatchInput {
  /**
   * Session that owns this dispatch. Every board event the operation emits is
   * attributed to it, so a tab can find (and stop) the work it started.
   */
  sessionId: string;
  boardId: string;
  taskId: string;
  leaseId: string;
  actor: string;
  error: string;
}

export interface CancelDispatchInput {
  /**
   * Session that owns this dispatch. Every board event the operation emits is
   * attributed to it, so a tab can find (and stop) the work it started.
   */
  sessionId: string;
  boardId: string;
  taskId: string;
  leaseId: string;
  actor: string;
  reason: string;
}

export interface HeartbeatDispatchInput {
  /**
   * Session that owns this dispatch. Every board event the operation emits is
   * attributed to it, so a tab can find (and stop) the work it started.
   */
  sessionId: string;
  boardId: string;
  taskId: string;
  leaseId: string;
  leaseExpiresAt?: string | undefined;
}

// ── Helpers ─────────────────────────────────────────────────────────

import { nowIso } from '@wrongstack/primitives';

function buildLease(ttlMs: number): DispatchLease {
  const now = nowIso();
  return {
    leaseId: randomUUID(),
    claimedAt: now,
    heartbeatAt: now,
    leaseExpiresAt: new Date(Date.now() + ttlMs).toISOString(),
  };
}

/**
 * Convert a thrown lifecycle/gate error into the structured dispatch payload
 * and emit operator-visible diagnostics (stderr + a kanban audit event).
 *
 * `transitionTask` and `finalizeTaskCompletion` failures inside the dispatch
 * flow used to be swallowed silently, leaving the assignment in `running` /
 * `completed` while the lifecycle stage lagged behind — a divergence with no
 * signal to the operator, the caller, or the event log. This helper mirrors
 * the pattern already established by `recoverStaleTaskAssignments`
 * (assignment.ts): best-effort transition inside try/catch, stderr line on
 * failure, plus an audit event so the gap is observable.
 *
 * Always returns the structured payload. The prior behaviour (swallowing
 * every error from the best-effort transition) is preserved at the call sites
 * — the assignment mutation has already committed, so the dispatch must still
 * report success at the lease level. The payload lets the caller surface the
 * lifecycle divergence (and retry via `transition_task` / `repair_managed_`)
 * rather than masking it. The `issues` array is populated whenever the error
 * carries structured lifecycle validation details (a real `KanbanLifecycleError`
 * or an IPC-reconstructed one); otherwise it is empty.
 */
async function recordLifecycleTransitionFailure(
  projectRoot: string,
  boardId: string,
  task: KanbanTask,
  operation: string,
  error: unknown,
  sessionId: string,
): Promise<DispatchLifecycleError | undefined> {
  const message = error instanceof Error ? error.message : String(error);
  // Recover the structured issues when present. A real KanbanLifecycleError
  // carries `issues` directly; an IPC-reconstructed error may carry them on a
  // plain object. We read the field structurally rather than importing
  // decodeLifecycleIssues to avoid pulling lifecycle-error.ts's envelope
  // helpers into the dispatch path.
  let issues: readonly KanbanLifecycleValidationIssue[] = [];
  if (error !== null && typeof error === 'object' && 'issues' in error) {
    const raw = (error as { issues: unknown }).issues;
    if (Array.isArray(raw)) issues = raw as readonly KanbanLifecycleValidationIssue[];
  }
  const payload: DispatchLifecycleError = { message, issues };

  process.stderr.write(`[kanban] ${operation}: lifecycle transition failed: ${message}\n`);
  try {
    await emitKanbanEvent(
      projectRoot,
      createKanbanEvent(boardId, task, 'task.lifecycle_transition_failed', {
        sessionId,
        note: `${operation}: ${message}`,
        ...(issues.length > 0 ? { after: { issues } } : {}),
      }),
    );
  } catch {
    // emitKanbanEvent already logs its own append failures; never let the
    // observability path mask the payload we just built.
  }
  return payload;
}

// ── Operations ──────────────────────────────────────────────────────

/**
 * Phase 1 — Reserve: claim a ready task and seed lease metadata.
 *
 * Calls claimReadyTask with the caller's routing, budget, and board-kind
 * filters. Seeds lease fields on the assignment. Does NOT advance lifecycle.
 *
 * Returns null when no claimable task is found.
 */
export async function reserveKanbanDispatch(
  projectRoot: string,
  input: ReserveDispatchInput,
): Promise<ReserveDispatchResult | null> {
  const effectiveTtl = Math.max(1_000, input.leaseTtlMs ?? 5 * 60 * 1000);
  const lease = buildLease(effectiveTtl);
  const r = input.routing;

  const claimed = await claimReadyTask(
    projectRoot,
    {
      ...(input.boardId !== undefined ? { boardId: input.boardId } : {}),
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(r?.agentId !== undefined ? { agentId: r.agentId } : {}),
      ...(r?.name !== undefined ? { name: r.name } : {}),
      ...(r?.role !== undefined ? { role: r.role } : {}),
      ...(r?.provider !== undefined ? { provider: r.provider } : {}),
      ...(r?.model !== undefined ? { model: r.model } : {}),
      ...(r?.fallbackProfile !== undefined ? { fallbackProfile: r.fallbackProfile } : {}),
      ...(r?.fallbackModels !== undefined ? { fallbackModels: r.fallbackModels } : {}),
      ...(r?.skills !== undefined ? { skills: r.skills } : {}),
      ...(r?.tools !== undefined ? { tools: r.tools } : {}),
      ...(r?.allowedCapabilities !== undefined
        ? { allowedCapabilities: r.allowedCapabilities }
        : {}),
      ...(input.budget?.costCeilingUsd !== undefined
        ? { costCeilingUsd: input.budget.costCeilingUsd }
        : {}),
      ...(input.budget?.retryPolicy !== undefined ? { retryPolicy: input.budget.retryPolicy } : {}),
      ...(input.budget?.maxAttempts !== undefined ? { maxAttempts: input.budget.maxAttempts } : {}),
      leaseId: lease.leaseId,
      claimedAt: lease.claimedAt,
      heartbeatAt: lease.heartbeatAt,
      leaseExpiresAt: lease.leaseExpiresAt,
      status: 'queued',
      ...(input.includeBoardKinds !== undefined
        ? { includeBoardKinds: input.includeBoardKinds }
        : {}),
      ...(input.excludeBoardKinds !== undefined
        ? { excludeBoardKinds: input.excludeBoardKinds }
        : {}),
    },
    { sessionId: input.sessionId },
  );

  if (!claimed) return null;

  return {
    board: claimed.board,
    task: claimed.task,
    lease,
  };
}

/**
 * Phase 2 — Start: transition the task to Running.
 *
 * Fences by leaseId. Calls updateTaskAssignment(running) with subagent/run
 * metadata. On managed boards: transitionTask(todo → running).
 */
export async function startKanbanDispatch(
  projectRoot: string,
  input: StartDispatchInput,
): Promise<StartDispatchResult | null> {
  // Stamp the running assignment, fenced by lease.
  const updated = await updateTaskAssignment(
    projectRoot,
    input.boardId,
    input.taskId,
    {
      status: 'running',
      ...(input.subagentId !== undefined ? { subagentId: input.subagentId } : {}),
      ...(input.runTaskId !== undefined ? { runTaskId: input.runTaskId } : {}),
      // Renew lease from actual dispatch moment.
      heartbeatAt: nowIso(),
    },
    { sessionId: input.sessionId, expectedLeaseId: input.leaseId },
  );

  if (!updated) return null;

  // Managed lifecycle: advance todo → running.
  if (updated.lifecycle?.mode === 'managed') {
    const managedTask = updated.tasks.find((t) => t.id === input.taskId);
    if (managedTask?.lifecycle?.currentStage === 'todo') {
      try {
        const tr = await transitionTask(projectRoot, input.boardId, input.taskId, {
          to: 'running',
          sessionId: input.sessionId,
          actor: input.actor,
          comment: 'Dispatch started.',
        });
        if (tr) {
          return {
            board: tr.board,
            task: tr.task,
          };
        }
      } catch (error) {
        // Best-effort: the lease-fenced assignment mutation above already
        // committed, so the task IS running with a valid lease. Only the
        // lifecycle projection lags. Surface the divergence so the operator,
        // the caller, and the event log can all see it — previously this was
        // swallowed silently, leaving a "running assignment / todo stage"
        // zombie state with zero signal.
        const lifecycleTransitionError = await recordLifecycleTransitionFailure(
          projectRoot,
          input.boardId,
          managedTask,
          'startKanbanDispatch',
          error,
          input.sessionId,
        );
        const task = updated.tasks.find((t) => t.id === input.taskId);
        return task
          ? {
              board: updated,
              task,
              ...(lifecycleTransitionError ? { lifecycleTransitionError } : {}),
            }
          : null;
      }
    }
  }

  const task = updated.tasks.find((t) => t.id === input.taskId);
  return task ? { board: updated, task } : null;
}

/**
 * Phase 3a — Complete: record the worker's result and advance toward Done.
 *
 * Fences by leaseId. Calls updateTaskAssignment(completed) with result.
 * Legacy boards: runs finalizeTaskCompletion (completion gate).
 * Managed boards: transitionTask(running → review).
 * Never auto-advances to Done.
 */
export async function completeKanbanDispatch(
  projectRoot: string,
  input: CompleteDispatchInput,
): Promise<CompleteDispatchResult | null> {
  // Record completion, fenced by lease.
  const updated = await updateTaskAssignment(
    projectRoot,
    input.boardId,
    input.taskId,
    {
      status: 'completed',
      ...(input.result !== undefined ? { lastResult: input.result } : {}),
    },
    { sessionId: input.sessionId, expectedLeaseId: input.leaseId },
  );

  if (!updated) return null;

  const task = updated.tasks.find((t) => t.id === input.taskId);
  if (!task) return null;

  if (updated.lifecycle?.mode === 'managed') {
    // Managed: advance running → review with evidence.
    if (task.lifecycle?.currentStage === 'running') {
      try {
        const tr = await transitionTask(projectRoot, input.boardId, input.taskId, {
          to: 'review',
          sessionId: input.sessionId,
          actor: input.actor,
          comment: input.result?.slice(0, 1000) ?? 'Work completed.',
          ...(input.evidence
            ? {
                attachment: {
                  url: input.evidence.url,
                  title: input.evidence.title,
                  type: input.evidence.type,
                },
              }
            : {
                attachment: {
                  url: `kanban://task/${input.taskId}/result`,
                  title: 'Worker completion result',
                  type: 'file' as const,
                },
              }),
        });
        if (tr) {
          return { board: tr.board, task: tr.task };
        }
      } catch (error) {
        // Best-effort: the assignment is completed and the lease is fenced.
        // Only the running → review transition failed. Surface it so the
        // reviewer queue (and the operator) sees the card is stuck in running
        // rather than silently leaving it there.
        const lifecycleTransitionError = await recordLifecycleTransitionFailure(
          projectRoot,
          input.boardId,
          task,
          'completeKanbanDispatch',
          error,
          input.sessionId,
        );
        return {
          board: updated,
          task,
          ...(lifecycleTransitionError ? { lifecycleTransitionError } : {}),
        };
      }
    }
    return { board: updated, task };
  }

  // Legacy: run the completion gate.
  try {
    const finalized = await finalizeTaskCompletion(projectRoot, input.boardId, input.taskId, {
      eventContext: { sessionId: input.sessionId, expectedLeaseId: input.leaseId },
    });
    if (finalized) {
      return { board: finalized.board, task: finalized.task, gate: finalized.gate };
    }
  } catch (error) {
    // Gate failure leaves the task in review (strict) or completed (soft).
    // Surface the failure rather than swallowing it: the caller asked for a
    // completion and got something less, and the structured issues tell the
    // operator exactly which criterion blocked Done.
    const lifecycleTransitionError = await recordLifecycleTransitionFailure(
      projectRoot,
      input.boardId,
      task,
      'completeKanbanDispatch',
      error,
      input.sessionId,
    );
    return {
      board: updated,
      task,
      ...(lifecycleTransitionError ? { lifecycleTransitionError } : {}),
    };
  }

  return { board: updated, task };
}

/**
 * Phase 3b — Fail: record a terminal failure.
 *
 * Fences by leaseId. Calls updateTaskAssignment(failed) with error.
 * Legacy boards: task status → failed.
 * Managed boards: assignment status → failed; lifecycle stays in running.
 */
export async function failKanbanDispatch(
  projectRoot: string,
  input: FailDispatchInput,
): Promise<KanbanBoard | null> {
  return updateTaskAssignment(
    projectRoot,
    input.boardId,
    input.taskId,
    {
      status: 'failed',
      error: input.error,
    },
    { sessionId: input.sessionId, expectedLeaseId: input.leaseId },
  );
}

/**
 * Cancel: release the claim back to the queue.
 *
 * Fences by leaseId. Calls releaseTaskClaim.
 * Legacy boards: status → ready/blocked.
 * Managed boards: assignment cleared; lifecycle stays.
 */
export async function cancelKanbanDispatch(
  projectRoot: string,
  input: CancelDispatchInput,
): Promise<KanbanBoard | null> {
  // Verify lease ownership before releasing.
  const current = await updateTaskAssignment(
    projectRoot,
    input.boardId,
    input.taskId,
    { status: 'cancelled', error: input.reason },
    { sessionId: input.sessionId, expectedLeaseId: input.leaseId },
  );

  if (!current) return null;

  // Fence the release too: the ownership check above and this release are
  // TWO separate board mutations, and between them the task can be
  // recovered and reclaimed by a new agent — an unfenced release then
  // deleted the NEW owner's claim (the exact zombie-release hole the
  // expectedLeaseId token exists for).
  return releaseTaskClaim(
    projectRoot,
    input.boardId,
    input.taskId,
    { reason: input.reason, expectedLeaseId: input.leaseId },
    { sessionId: input.sessionId, expectedLeaseId: input.leaseId },
  );
}

/**
 * Heartbeat: renew the lease.
 *
 * Fences by leaseId. Calls heartbeatTaskAssignment.
 * Optionally extends leaseExpiresAt.
 */
export async function heartbeatKanbanDispatch(
  projectRoot: string,
  input: HeartbeatDispatchInput,
): Promise<KanbanBoard | null> {
  return heartbeatTaskAssignment(
    projectRoot,
    input.boardId,
    input.taskId,
    {
      expectedLeaseId: input.leaseId,
      ...(input.leaseExpiresAt !== undefined ? { leaseExpiresAt: input.leaseExpiresAt } : {}),
    },
    { sessionId: input.sessionId, expectedLeaseId: input.leaseId },
  );
}
