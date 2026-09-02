/**
 * Queue health from an HQ board snapshot.
 *
 * HQ receives an `HqKanbanSnapshotPayload`, never a live `KanbanQueueHealth`,
 * so this cannot call the canonical `getKanbanQueueHealth`. It is a documented
 * APPROXIMATION of `isTaskReadyForWork`, bounded by what `HqKanbanTaskView`
 * carries: no lease metadata, no atomicity assessment, no `mergedIntoTaskId`,
 * so those three exclusions cannot be applied here. A disagreement with the
 * project WebUI's bar is expected, not a bug.
 */
import type { HqKanbanBoardView } from './kanban-model.js';

export interface KanbanQueueCounts {
  /**
   * Named for what it measures. This field was called `ready` while computing
   * startability — which is how the same `ready` / `startable` confusion
   * reached a fourth implementation.
   */
  startable: number;
  running: number;
  review: number;
  blocked: number;
  failed: number;
}

export function computeQueueCounts(board: HqKanbanBoardView): KanbanQueueCounts {
  const counts: KanbanQueueCounts = {
    startable: 0,
    running: 0,
    review: 0,
    blocked: 0,
    failed: 0,
  };

  // Completed cards are what satisfy a dependency; collect them once instead
  // of rescanning the board per task.
  const completed = new Set<string>();
  for (const column of board.columns) {
    for (const task of column.tasks) {
      if (task.status === 'completed') completed.add(task.id);
    }
  }

  for (const column of board.columns) {
    for (const task of column.tasks) {
      // A card with a live assignment is being worked, whatever its stored
      // status says. The canonical producer gives the assignment priority over
      // the status field; ignoring it under-reports every managed card, whose
      // status tracks its lifecycle stage rather than its claim.
      const claimedByAgent =
        task.assignmentStatus === 'running' || task.assignmentStatus === 'queued';

      if (task.status === 'in_progress' || task.assignmentStatus === 'running') {
        counts.running += 1;
      }
      if (
        !claimedByAgent &&
        (task.status === 'pending' || task.status === 'ready') &&
        task.dependsOn.every((id) => completed.has(id))
      ) {
        counts.startable += 1;
      }
      if (task.status === 'review') counts.review += 1;
      if (task.status === 'blocked') counts.blocked += 1;
      if (task.status === 'failed') counts.failed += 1;
    }
  }

  return counts;
}

/**
 * Only failure signals decide "healthy". Startable, running and review are
 * ordinary states — counting them meant a board with work in flight could
 * never show the healthy pill.
 */
export function isQueueHealthy(counts: KanbanQueueCounts): boolean {
  return counts.blocked === 0 && counts.failed === 0;
}
