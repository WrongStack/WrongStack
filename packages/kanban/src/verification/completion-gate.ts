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
import { getBoard } from '../manager/boards.js';
import { validateDefinitionOfDone } from '../manager/lifecycle.js';
import {
  createKanbanEvent,
  emitKanbanEvent,
  findTask,
  nowIso,
  syncTaskColumnForStatus,
} from '../manager/_internal.js';
import { mutateBoard } from '../storage.js';
import type {
  KanbanBoard,
  KanbanCompletionGateEnforcement,
  KanbanEvent,
  KanbanEventContext,
  KanbanLifecycleValidationIssue,
  KanbanTask,
  KanbanVerificationReport,
} from '../types.js';
import { verifyTaskCompletion } from './completion-protocol.js';
import type { VerifierRegistry } from './verifier-registry.js';

export interface CompletionGateOptions {
  /** Custom verifier registry (default: deterministic plugins only). */
  registry?: VerifierRegistry | undefined;
  /** Overrides the board-resolved enforcement for this run. */
  enforcement?: KanbanCompletionGateEnforcement | undefined;
  eventContext?: KanbanEventContext | undefined;
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
 * Run the verifier for a task and evaluate the Definition of Done, without
 * persisting anything. Callers that need persistence use
 * finalizeTaskCompletion(); this function exists for pre-checks (e.g. the
 * transition_task tool action).
 */
export async function enforceCompletionGate(
  projectRoot: string,
  boardId: string,
  taskId: string,
  options: CompletionGateOptions = {},
): Promise<CompletionGateResult> {
  const board = await getBoard(projectRoot, boardId);
  if (!board) throw new Error(`Board not found: ${boardId}`);
  const task = findTask(board, taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  const enforcement = options.enforcement ?? resolveGateEnforcement(board);
  if (enforcement === 'off') {
    return { allowed: true, enforcement, verdict: 'skipped', issues: [] };
  }

  const result = await verifyTaskCompletion(projectRoot, boardId, taskId, {
    ...(options.registry !== undefined ? { registry: options.registry } : {}),
    persist: false,
  });
  const issues = validateDefinitionOfDone(result.task, result.report, {
    // Soft mode lets criterion-less tasks complete quietly; strict demands
    // explicit acceptance criteria, matching the managed Done contract.
    requireCriteria: enforcement === 'strict',
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
  options: CompletionGateOptions = {},
): Promise<FinalizeTaskCompletionResult | null> {
  const gate = await enforceCompletionGate(projectRoot, boardId, taskId, options).catch(
    (error) => {
      if (error instanceof Error && /not found/i.test(error.message)) return null;
      throw error;
    },
  );
  if (!gate) return null;

  const events: KanbanEvent[] = [];
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    if (!task) return null;
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
            notes: result.error
              ? `[${result.status}] ${result.error}`
              : `[${result.status}] verified by ${result.type}`,
          };
        });
      }
    }

    if (gate.allowed) {
      task.status = 'completed';
      task.completedAt = task.assignment?.completedAt ?? task.completedAt ?? now;
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
      task.status = 'review';
      delete task.completedAt;
      events.push(
        createKanbanEvent(board.id, task, 'task.completion.gate_blocked', {
          ...options.eventContext,
          after: { verdict: gate.verdict, issues: gate.issues.map((issue) => issue.message) },
        }),
      );
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
