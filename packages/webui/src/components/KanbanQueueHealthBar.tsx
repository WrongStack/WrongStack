import type { KanbanQueueHealth } from '@wrongstack/kanban';

export type KanbanQueueHealthBarProps = {
  queueHealth: KanbanQueueHealth;
  runningCostTotal: number;
};

export function KanbanQueueHealthBar({ queueHealth, runningCostTotal }: KanbanQueueHealthBarProps) {
  return (
    <div className="flex shrink-0 items-center gap-4 border-b px-4 py-2 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">Queue health</span>
      {queueHealth.counts.ready > 0 && (
        <span title="Claimable tasks" className="inline-flex items-center gap-1 text-success">
          {queueHealth.counts.ready} ready
        </span>
      )}
      {queueHealth.counts.running > 0 && (
        <span title="Running assignments" className="inline-flex items-center gap-1 text-warning">
          {queueHealth.counts.running} running
        </span>
      )}
      {queueHealth.counts.review > 0 && (
        <span title="In review" className="inline-flex items-center gap-1 text-primary">
          {queueHealth.counts.review} review
        </span>
      )}
      {queueHealth.counts.blocked > 0 && (
        <span title="Manually blocked" className="inline-flex items-center gap-1 text-destructive">
          {queueHealth.counts.blocked} blocked
        </span>
      )}
      {queueHealth.counts.failed > 0 && (
        <span title="Failed tasks" className="inline-flex items-center gap-1 text-destructive">
          {queueHealth.counts.failed} failed
        </span>
      )}
      {queueHealth.dependencyBlocked.count > 0 && (
        <span
          title="Ready/pending tasks blocked by dependencies"
          className="inline-flex items-center gap-1 rounded bg-warning/10 px-1.5 py-0.5 text-warning"
        >
          {queueHealth.dependencyBlocked.count} blocked by deps
        </span>
      )}
      {queueHealth.staleAssignments.count > 0 && (
        <span
          title="Expired lease assignments"
          className="inline-flex items-center gap-1 rounded bg-destructive/10 px-1.5 py-0.5 text-destructive"
        >
          {queueHealth.staleAssignments.count} stale
        </span>
      )}
      {queueHealth.heartbeatDue.count === 0 &&
        queueHealth.staleAssignments.count === 0 &&
        queueHealth.dependencyBlocked.count === 0 && <span className="text-success">healthy</span>}
      {runningCostTotal > 0 && (
        <span
          title="Sum of costCeilingUsd for running/queued tasks"
          className="inline-flex items-center gap-1 text-info"
        >
          ~${runningCostTotal.toFixed(2)} running cost
        </span>
      )}
    </div>
  );
}
