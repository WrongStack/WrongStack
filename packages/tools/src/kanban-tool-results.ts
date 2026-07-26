import type {
  KanbanBoard,
  KanbanCompletionGateEnforcement,
  KanbanTask,
} from '@wrongstack/kanban';
import type { KanbanToolOutput } from './kanban-tool-types.js';

/** One-line guidance appended when a freshly created task should be split. */
export function atomicityNudge(task: KanbanTask): string {
  if (task.atomicityAssessment?.verdict !== 'needs_decomposition') return '';
  const reasons = task.atomicityAssessment.criteria
    .filter((entry) => entry.score < 1)
    .map((entry) => entry.reason)
    .join(' | ');
  return ` Atomicity: needs_decomposition (score ${task.atomicityAssessment.score}) — call propose_decomposition with 2+ subtasks before dispatch. Reasons: ${reasons}`;
}

/**
 * Host-level completion-gate fallback. The kanban package stays env-free;
 * only hosting surfaces (tools, webui-server) read WRONGSTACK_KANBAN_GATE,
 * and only when the board carries no explicit completionGate policy.
 */
export function readEnvGateEnforcement(): KanbanCompletionGateEnforcement | undefined {
  const raw = process.env['WRONGSTACK_KANBAN_GATE']?.trim().toLowerCase();
  return raw === 'strict' || raw === 'soft' || raw === 'off' ? raw : undefined;
}

export function fail(message: string): KanbanToolOutput {
  return { ok: false, message };
}

export function okBoard(board: KanbanBoard, message = 'Board loaded.'): KanbanToolOutput {
  return { ok: true, message, board };
}

export function okTask(board: KanbanBoard, task: KanbanTask, message: string): KanbanToolOutput {
  return { ok: true, message, board, task };
}
