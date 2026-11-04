/**
 * Pure verification/atomicity selectors for kanban surfaces.
 * Type-only imports from @wrongstack/kanban keep this browser-safe.
 */

import type { KanbanBoard, KanbanTask, KanbanVerificationCheckResult } from '@wrongstack/kanban';

export type TaskVerificationState =
  | 'unverified'
  | 'running'
  | 'passed'
  | 'failed'
  | 'needs_human'
  | 'incomplete';

/**
 * Derive a task's verification display state. `running` wins while the store's
 * verificationActivity map holds a live entry for the task.
 */
export function verificationStateOf(
  task: KanbanTask,
  activity?: { startedAt: number } | undefined,
): TaskVerificationState {
  if (activity) return 'running';
  const verdict = task.verificationReport?.verdict;
  if (!verdict) return 'unverified';
  return verdict;
}

interface VerificationSummary {
  totalTasks: number;
  /** Only tasks in a terminal-ish state are graded (completed/review/failed). */
  gradedTasks: number;
  passed: number;
  failed: number;
  needsHuman: number;
  incomplete: number;
  unverified: number;
  /** Individual failing checks across the board. */
  failingChecks: Array<{ task: KanbanTask; check: KanbanVerificationCheckResult }>;
  /** Agent/council checks that passed without concrete backing refs. */
  missingEvidence: Array<{ task: KanbanTask; check: KanbanVerificationCheckResult }>;
  /** Childless tasks assessed as needing decomposition. */
  needsDecomposition: KanbanTask[];
  /** Pending decomposition proposals awaiting approval. */
  pendingProposals: KanbanTask[];
}

const GRADED_STATUSES = new Set(['completed', 'review', 'failed']);

export function selectVerificationSummary(board: KanbanBoard): VerificationSummary {
  const summary: VerificationSummary = {
    totalTasks: board.tasks.length,
    gradedTasks: 0,
    passed: 0,
    failed: 0,
    needsHuman: 0,
    incomplete: 0,
    unverified: 0,
    failingChecks: [],
    missingEvidence: [],
    needsDecomposition: [],
    pendingProposals: [],
  };
  for (const task of board.tasks) {
    if (task.status === 'archived') continue;
    const report = task.verificationReport;
    if (GRADED_STATUSES.has(task.status)) {
      summary.gradedTasks += 1;
      if (!report) summary.unverified += 1;
      else if (report.verdict === 'passed') summary.passed += 1;
      else if (report.verdict === 'failed') summary.failed += 1;
      else if (report.verdict === 'needs_human') summary.needsHuman += 1;
      else summary.incomplete += 1;
    }
    if (report) {
      for (const check of report.checks) {
        if (check.status === 'failed' || check.status === 'error') {
          summary.failingChecks.push({ task, check });
        }
        if (
          (check.type === 'agent' || check.type === 'council') &&
          check.status === 'passed' &&
          !check.backingRefs?.length
        ) {
          summary.missingEvidence.push({ task, check });
        }
      }
    }
    if (
      !task.childTaskIds?.length &&
      task.atomicityAssessment?.verdict === 'needs_decomposition' &&
      task.status !== 'completed'
    ) {
      summary.needsDecomposition.push(task);
    }
    if (task.decomposition?.status === 'proposed') {
      summary.pendingProposals.push(task);
    }
  }
  return summary;
}

interface TaskTreeNode {
  task: KanbanTask;
  children: TaskTreeNode[];
  depth: number;
}

/**
 * Build the parent/child forest from `parentTaskId`/`childTaskIds`.
 * Roots are tasks without a (resolvable) parent; cycles are broken by a
 * visited set so a corrupted board can never hang the UI.
 */
export function buildTaskTree(board: KanbanBoard): TaskTreeNode[] {
  const byId = new Map(board.tasks.map((task) => [task.id, task]));
  const visited = new Set<string>();

  const build = (task: KanbanTask, depth: number): TaskTreeNode => {
    visited.add(task.id);
    const childIds = task.childTaskIds ?? [];
    const children: TaskTreeNode[] = [];
    for (const childId of childIds) {
      const child = byId.get(childId);
      if (!child || visited.has(child.id)) continue;
      children.push(build(child, depth + 1));
    }
    return { task, children, depth };
  };

  const roots: TaskTreeNode[] = [];
  for (const task of board.tasks) {
    const parent = task.parentTaskId ? byId.get(task.parentTaskId) : undefined;
    if (parent) continue;
    if (visited.has(task.id)) continue;
    roots.push(build(task, 0));
  }
  // Orphan sweep. A ONE-WAY parent link (the child names a parent whose
  // childTaskIds doesn't name it back) or a parent cycle leaves tasks
  // unreachable from any root: not a root (parent resolves) and never
  // visited as a child. They used to vanish from the tree entirely — a
  // board with 12 tasks rendered 8 — which reads as lost work. Surface
  // them as extra roots; the visited set keeps cycles from hanging.
  for (const task of board.tasks) {
    if (!visited.has(task.id)) roots.push(build(task, 0));
  }
  return roots;
}

/** Flatten a tree into rows for simple list rendering. */
export function flattenTaskTree(nodes: TaskTreeNode[]): TaskTreeNode[] {
  const rows: TaskTreeNode[] = [];
  const walk = (node: TaskTreeNode): void => {
    rows.push(node);
    for (const child of node.children) walk(child);
  };
  for (const node of nodes) walk(node);
  return rows;
}
