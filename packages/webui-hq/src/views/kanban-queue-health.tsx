/**
 * HQ Kanban queue health bar — lightweight variant.
 *
 * Computes queue health from the task statuses available in the HQ
 * board snapshot. Shows ready, running, review, blocked, failed counts
 * as colored pills. Mirrors the project WebUI's KanbanQueueHealthBar
 * but uses only the data available in HqKanbanBoardView.
 *
 * See docs/plans/hq-evolution-2026-08.md §5.1 "queue-health.tsx".
 */
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  PauseCircle,
  PlayCircle,
} from 'lucide-react';
import type React from 'react';
import type { HqKanbanBoardView } from './kanban-model.js';

export function HqKanbanQueueHealth({ board }: { board: HqKanbanBoardView }): React.ReactElement {
  const counts = computeCounts(board);

  // Only failure signals decide "healthy" — startable, running and review are
  // ordinary states, not problems. Counting them here meant a board with work
  // in flight could never show the healthy pill.
  const healthy = counts.blocked === 0 && counts.failed === 0;

  return (
    <div className="hq-kanban-queue-health" role="status" aria-label="Queue health">
      <span className="hq-kanban-qh-label">Queue health</span>
      {counts.startable > 0 ? (
        <span className="hq-kanban-qh-pill ready" title="Claimable tasks">
          <PlayCircle size={12} />
          {counts.startable} ready
        </span>
      ) : null}
      {counts.running > 0 ? (
        <span className="hq-kanban-qh-pill running" title="Running assignments">
          <Activity size={12} />
          {counts.running} running
        </span>
      ) : null}
      {counts.review > 0 ? (
        <span className="hq-kanban-qh-pill review" title="In review">
          <Clock3 size={12} />
          {counts.review} review
        </span>
      ) : null}
      {counts.blocked > 0 ? (
        <span className="hq-kanban-qh-pill blocked" title="Manually blocked">
          <PauseCircle size={12} />
          {counts.blocked} blocked
        </span>
      ) : null}
      {counts.failed > 0 ? (
        <span className="hq-kanban-qh-pill failed" title="Failed tasks">
          <AlertTriangle size={12} />
          {counts.failed} failed
        </span>
      ) : null}
      {healthy ? (
        <span className="hq-kanban-qh-pill healthy" title="No issues detected">
          <CheckCircle2 size={12} />
          healthy
        </span>
      ) : null}
    </div>
  );
}

interface QueueCounts {
  /**
   * Named for what it measures. The field was called `ready` while computing
   * startability, which is how the canonical `counts.ready` / `counts.startable`
   * confusion reached a fourth implementation.
   */
  startable: number;
  running: number;
  review: number;
  blocked: number;
  failed: number;
}

/**
 * HQ receives an `HqKanbanSnapshotPayload`, never a live `KanbanQueueHealth`,
 * so this cannot call the canonical `getKanbanQueueHealth`. It is a documented
 * APPROXIMATION of `isTaskReadyForWork`, limited by what `HqKanbanTaskView`
 * carries: there is no lease metadata, no atomicity assessment and no
 * `mergedIntoTaskId` here, so those three exclusions cannot be applied.
 * Treat a disagreement with the project WebUI's bar as expected, not as a bug.
 */
function computeCounts(board: HqKanbanBoardView): QueueCounts {
  const counts: QueueCounts = { startable: 0, running: 0, review: 0, blocked: 0, failed: 0 };
  // Completed cards are what satisfy a dependency, so collect them once
  // rather than rescanning the board per task.
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
      // the status field; this bucket ignored it and under-reported every
      // managed card, whose status stays with its lifecycle stage.
      const claimedByAgent =
        task.assignmentStatus === 'running' || task.assignmentStatus === 'queued';
      if (task.status === 'in_progress' || task.assignmentStatus === 'running') {
        counts.running++;
      }
      if (
        !claimedByAgent &&
        (task.status === 'pending' || task.status === 'ready') &&
        task.dependsOn.every((id) => completed.has(id))
      ) {
        counts.startable++;
      }
      switch (task.status) {
        case 'review':
          counts.review++;
          break;
        case 'blocked':
          counts.blocked++;
          break;
        case 'failed':
          counts.failed++;
          break;
      }
    }
  }
  return counts;
}
