/**
 * Kanban → completed-work ledger bridge.
 *
 * Links the two evidence systems: when a task's verification report is
 * produced (verify_completion, the completion gate via mark_assignment, or a
 * managed Done transition), the session's completed-work ledger gets an entry
 * pointing back at the report. The kanban package cannot do this itself — it
 * has zero core dependency — so the bridge lives here in tools, which owns
 * both sides.
 *
 * Best-effort by contract: a ledger failure must never turn a successful
 * board mutation into an apparent task failure.
 */

import type { Context } from '@wrongstack/core/agent';
import { recordCompletedWorkEvidence } from '@wrongstack/core/utils';
import type { KanbanVerificationReport } from '@wrongstack/kanban';

/** Stable dedupe key — re-verifying the same task updates the entry in place. */
export function kanbanEvidenceKey(boardId: string, taskId: string): string {
  return `kanban:${boardId}:${taskId}`;
}

/** Parseable deep-link pointer to the persisted report. */
export function kanbanEvidencePointer(boardId: string, taskId: string): string {
  return `kanban://${boardId}/${taskId}#verificationReport`;
}

export function recordKanbanVerificationEvidence(
  ctx: Context,
  report: KanbanVerificationReport,
): void {
  try {
    const passed = report.checks.filter((check) => check.status === 'passed').length;
    const completedAt = Date.parse(report.completedAt);
    recordCompletedWorkEvidence(ctx, {
      key: kanbanEvidenceKey(report.boardId, report.taskId),
      source: 'verification',
      summary: `${report.taskTitle} — verification ${report.verdict} (${passed}/${report.checks.length} checks)`,
      ...(Number.isFinite(completedAt) ? { completedAt } : {}),
      evidence: kanbanEvidencePointer(report.boardId, report.taskId),
    });
  } catch {
    // Evidence is observational; never fail the caller.
  }
}
