/**
 * Universal completion gate.
 *
 * Every completion path funnels through this module so "done" always means
 * the same thing:
 *   - managed boards: transitionTask already gates via validateDoneEvidence
 *     (which shares validateDefinitionOfDone with this gate);
 *   - legacy boards: updateTaskAssignment parks completed assignments in
 *     'review' and the async callers (tools mark_assignment, WebUI dispatch
 *     onDone, the supervisor sweep) call finalizeTaskCompletion();
 *   - SDD runs: verified by the run engine itself; mirror boards are created
 *     with enforcement 'off'.
 *
 * verifyTaskCompletion() is async (runs commands/tests) and must never run
 * inside a mutateBoard closure — this module verifies first, then persists
 * report + criteria + final status in a single board mutation.
 */
// Import from defining leaf modules, not the `../manager.js` barrel, which
// re-exports this file — importing the barrel would form a module cycle
// (manager.ts ↔ verification/completion-gate.ts) that check:architecture flags.

import {
  createKanbanEvent,
  emitKanbanEvent,
  findTask,
  nowIso,
  syncTaskColumnForStatus,
} from '../manager/_internal.js';
import { getBoard } from '../manager/boards.js';
import { validateDefinitionOfDone } from '../manager/lifecycle.js';
import { mutateBoard } from '../storage.js';
import type {
  KanbanBoard,
  KanbanCompletionGateEnforcement,
  KanbanEvent,
  KanbanEventContext,
  KanbanTask,
  KanbanVerificationReport,
} from '../types.js';
import type { KanbanLifecycleValidationIssue } from '../types-operations.js';
import { applyGateRefusal, clearGateRefusals } from './completion-park.js';
import { verifyTaskCompletion } from './completion-protocol.js';
import type { VerifierRegistry } from './verifier-registry.js';

export interface CompletionGateOptions {
  /** Custom verifier registry (default: deterministic plugins only). */
  registry?: VerifierRegistry | undefined;
  /** Overrides the board-resolved enforcement for this run. */
  enforcement?: KanbanCompletionGateEnforcement | undefined;
  /** Session that owns this completion — stamped on every gate event. */
  eventContext: KanbanEventContext;
}

export interface CompletionGateResult {
  /** Whether completion may proceed under the effective enforcement. */
  allowed: boolean;
  enforcement: KanbanCompletionGateEnforcement;
  verdict: KanbanVerificationReport['verdict'] | 'skipped';
  report?: KanbanVerificationReport | undefined;
  issues: KanbanLifecycleValidationIssue[];
}

/**
 * Effective gate enforcement for a board.
 * Managed boards are always gated (their transitionTask contract requires
 * verified Done), so 'off' is not honored there. Legacy boards default to
 * 'soft': verification runs and reports persist, but nothing blocks.
 */
export function resolveGateEnforcement(board: KanbanBoard): KanbanCompletionGateEnforcement {
  const configured = board.completionGate?.enforcement;
  if (board.lifecycle?.mode === 'managed') {
    return configured === 'soft' ? 'soft' : 'strict';
  }
  return configured ?? 'soft';
}

/**
 * Whether a passing verification may move a managed card into Done by itself.
 *
 * Defaults to true so boards written before the policy existed keep the
 * behavior they already had. This is an ACCEPTANCE switch, not a gate switch:
 * turning it off holds a verified card in Review, and turning it on never lets
 * an unverified card through — `validateDefinitionOfDone` still runs either way.
 */
export function resolveAutoAccept(board: KanbanBoard): boolean {
  return board.lifecycle?.autoAccept !== false;
}

/**
 * Run the verifier for a task and evaluate the Definition of Done, without
 * persisting anything. Callers that need persistence use
 * finalizeTaskCompletion(); this function exists for pre-checks (e.g. the
 * transition_task tool action).
 */
export async function enforceCompletionGate(
  projectRoot: string,
  boardId: string,
  taskId: string,
  options: CompletionGateOptions,
): Promise<CompletionGateResult> {
  const board = await getBoard(projectRoot, boardId);
  if (!board) throw new Error(`Board not found: ${boardId}`);
  const task = findTask(board, taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  const requestedEnforcement = options.enforcement ?? resolveGateEnforcement(board);
  // Managed lifecycle completion is always gated. A caller-level override may
  // relax strict verification to soft, but it must not skip the gate entirely.
  const enforcement =
    board.lifecycle?.mode === 'managed' && requestedEnforcement === 'off'
      ? 'strict'
      : requestedEnforcement;
  if (enforcement === 'off') {
    return { allowed: true, enforcement, verdict: 'skipped', issues: [] };
  }

  const result = await verifyTaskCompletion(projectRoot, boardId, task.id, {
    ...(options.registry !== undefined ? { registry: options.registry } : {}),
    persist: false,
  });
  const issues = validateDefinitionOfDone(result.task, result.report, {
    // Soft mode lets criterion-less tasks complete quietly; strict demands
    // explicit acceptance criteria, matching the managed Done contract.
    requireCriteria: enforcement === 'strict',
    board,
  });
  const allowed = result.report.verdict === 'passed' && issues.length === 0;
  return { allowed, enforcement, verdict: result.report.verdict, report: result.report, issues };
}

/**
 * Idempotently attach an externally produced verification report to a task
 * (e.g. the kanban run mirror translating an SDD run's completion-gate
 * outcome). Skips the write when an equivalent report (same verdict and
 * completion timestamp) is already present. Never changes task status —
 * mirrored boards own their status via sync.
 */
export async function attachVerificationReport(
  projectRoot: string,
  boardId: string,
  taskId: string,
  report: KanbanVerificationReport,
): Promise<KanbanBoard | null> {
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    if (!task) return null;
    if (
      task.verificationReport?.verdict === report.verdict &&
      task.verificationReport.completedAt === report.completedAt
    ) {
      return false;
    }
    task.verificationReport = { ...report, taskId: task.id, boardId: board.id };
    task.updatedAt = nowIso();
    board.updatedAt = task.updatedAt;
    return true;
  });
  return updated?.result ? updated.board : null;
}

export interface FinalizeTaskCompletionResult {
  board: KanbanBoard;
  task: KanbanTask;
  gate: CompletionGateResult;
}

/**
 * Finalize a task whose worker reported completion: run the gate, persist the
 * verification report + refreshed criteria, and apply the final status in one
 * atomic board mutation.
 *
 * Outcomes:
 *   - gate allowed        -> status 'completed' (+completedAt), event `task.verified`
 *   - strict and blocked  -> status 'review', event `task.completion.gate_blocked`
 *   - soft and failing    -> status 'completed', event `task.completion.gate_soft_failed`
 *   - enforcement 'off'   -> status 'completed', verifier not run
 */
export async function finalizeTaskCompletion(
  projectRoot: string,
  boardId: string,
  taskId: string,
  options: CompletionGateOptions,
): Promise<FinalizeTaskCompletionResult | null> {
  const gate = await enforceCompletionGate(projectRoot, boardId, taskId, options).catch((error) => {
    if (error instanceof Error && /not found/i.test(error.message)) return null;
    throw error;
  });
  if (!gate) return null;

  const events: KanbanEvent[] = [];
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    if (!task) return null;
    // Managed cards advance only through transitionTask. Completion callers may
    // persist assignment results, but cannot project lifecycle stages here.
    if (board.lifecycle?.mode === 'managed') return null;
    const previousColumnId = task.columnId;
    const now = nowIso();

    if (gate.report) {
      task.verificationReport = gate.report;
      // Refresh criterion statuses from the verification run so the card and
      // the report can never disagree.
      if (task.successCriteria) {
        task.successCriteria = task.successCriteria.map((existing) => {
          const result = gate.report!.checks.find((check) => check.checkId === existing.id);
          if (!result) return existing;
          // A skipped result means "not verifiable here" (e.g. a pending
          // manual check) — keep the human-owned status instead of clobbering.
          if (result.status === 'skipped') return existing;
          return {
            ...existing,
            // 'skipped' returned above; 'error' maps to failed.
            status: result.status === 'passed' ? ('passed' as const) : ('failed' as const),
            checkedBy: result.type === 'agent' ? 'agent' : 'system',
            checkedAt: gate.report!.completedAt,
            // `notes` stays untouched — it is the criterion's INPUT (the
            // command, pattern, path or JSON config the plugin executes), not
            // a place for the outcome. Overwriting it made a failed criterion
            // unrepeatable: the re-run read the narrative as its input. Same
            // rule as completion-protocol.ts; the outcome lives in
            // `verificationReport.checks[]`, which was just persisted above.
          };
        });
      }
    }

    if (gate.allowed) {
      task.status = 'completed';
      task.completedAt = task.assignment?.completedAt ?? task.completedAt ?? now;
      // A card that passed starts its refusal budget over: an earlier park was
      // earned against evidence this run just replaced.
      clearGateRefusals(task);
      events.push(
        createKanbanEvent(board.id, task, 'task.verified', {
          ...options.eventContext,
          after: {
            verdict: gate.verdict,
            checksPassed: gate.report?.checks.filter((c) => c.status === 'passed').length ?? 0,
            checksTotal: gate.report?.checks.length ?? 0,
          },
        }),
      );
    } else if (gate.enforcement === 'strict') {
      const issueMessages = gate.issues.map((issue) => issue.message);
      const refusal = applyGateRefusal(board, task, {
        reason: issueMessages[0] ?? `Verification verdict: ${gate.verdict}`,
        issues: issueMessages,
      });
      // Parking owns the card's status (see completion-park.ts); only a card
      // still inside its budget goes back to review for another attempt.
      if (!refusal.parked) {
        task.status = 'review';
        delete task.completedAt;
      }
      events.push(
        createKanbanEvent(board.id, task, 'task.completion.gate_blocked', {
          ...options.eventContext,
          after: { verdict: gate.verdict, issues: issueMessages, attempts: refusal.attempts },
        }),
      );
      if (refusal.parked) {
        events.push(
          createKanbanEvent(board.id, task, 'task.completion.parked', {
            ...options.eventContext,
            after: {
              attempts: refusal.attempts,
              reason: refusal.park?.reason,
              issues: refusal.park?.issues ?? [],
            },
          }),
        );
      }
    } else {
      // Soft enforcement: complete anyway, but leave a durable warning trail.
      task.status = 'completed';
      task.completedAt = task.assignment?.completedAt ?? task.completedAt ?? now;
      events.push(
        createKanbanEvent(board.id, task, 'task.completion.gate_soft_failed', {
          ...options.eventContext,
          after: { verdict: gate.verdict, issues: gate.issues.map((issue) => issue.message) },
        }),
      );
    }

    syncTaskColumnForStatus(board, task, previousColumnId);
    task.updatedAt = now;
    board.updatedAt = now;
    return task;
  });

  if (updated?.result) {
    for (const event of events) await emitKanbanEvent(projectRoot, event);
  }
  return updated?.result ? { board: updated.board, task: updated.result, gate } : null;
}
