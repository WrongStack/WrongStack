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
import { Activity, AlertTriangle, CheckCircle2, Clock3, PauseCircle, PlayCircle } from 'lucide-react';
import type React from 'react';
import type { HqKanbanBoardView } from './kanban-model.js';

export function HqKanbanQueueHealth({ board }: { board: HqKanbanBoardView }): React.ReactElement {
  const counts = computeCounts(board);

  const allZero =
    counts.ready === 0 &&
    counts.running === 0 &&
    counts.review === 0 &&
    counts.blocked === 0 &&
    counts.failed === 0;

  return (
    <div className="hq-kanban-queue-health" role="status" aria-label="Queue health">
      <span className="hq-kanban-qh-label">Queue health</span>
      {counts.ready > 0 ? (
        <span className="hq-kanban-qh-pill ready" title="Claimable tasks">
          <PlayCircle size={12} />
          {counts.ready} ready
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
      {allZero ? (
        <span className="hq-kanban-qh-pill healthy" title="No issues detected">
          <CheckCircle2 size={12} />
          healthy
        </span>
      ) : null}
    </div>
  );
}

interface QueueCounts {
  ready: number;
  running: number;
  review: number;
  blocked: number;
  failed: number;
}

function computeCounts(board: HqKanbanBoardView): QueueCounts {
  const counts: QueueCounts = { ready: 0, running: 0, review: 0, blocked: 0, failed: 0 };
  for (const column of board.columns) {
    for (const task of column.tasks) {
      switch (task.status) {
        case 'ready':
          counts.ready++;
          break;
        case 'in_progress':
          counts.running++;
          break;
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
