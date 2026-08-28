import type { KanbanQueueHealth } from '@wrongstack/kanban';
// Browser-safe subpath: the package barrel reaches the IPC client (node:net),
// which must never enter the browser bundle. Mirrors KanbanContractGraphView.
import { hasKanbanQueueAnomalies } from '@wrongstack/kanban/queue-anomalies';
import { useAppTranslation } from '@/i18n';

type KanbanQueueHealthBarProps = {
  queueHealth: KanbanQueueHealth;
  runningCostTotal: number;
};

export function KanbanQueueHealthBar({ queueHealth, runningCostTotal }: KanbanQueueHealthBarProps) {
  const { t } = useAppTranslation();
  return (
    <div className="flex shrink-0 items-center gap-4 border-b px-4 py-2 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">{t('activity:kanban.queueHealth')}</span>
      {/* `counts.ready` tallies the stored status field, which nothing writes,
          so this pill never appeared. `startable` is the derived count that
          matches the board's own ready_tasks. */}
      {queueHealth.counts.startable > 0 && (
        <span
          title={t('activity:kanban.claimableTasks')}
          className="inline-flex items-center gap-1 text-success"
        >
          {queueHealth.counts.startable} {t('activity:kanban.statusReady')}
        </span>
      )}
      {queueHealth.counts.running > 0 && (
        <span
          title={t('activity:kanban.runningAssignments')}
          className="inline-flex items-center gap-1 text-warning"
        >
          {queueHealth.counts.running} {t('activity:kanban.statusRunning')}
        </span>
      )}
      {queueHealth.counts.review > 0 && (
        <span
          title={t('activity:kanban.inReview')}
          className="inline-flex items-center gap-1 text-primary"
        >
          {queueHealth.counts.review} {t('activity:kanban.statusReview')}
        </span>
      )}
      {queueHealth.counts.blocked > 0 && (
        <span
          title={t('activity:kanban.manuallyBlocked')}
          className="inline-flex items-center gap-1 text-destructive"
        >
          {queueHealth.counts.blocked} {t('activity:kanban.statusBlocked')}
        </span>
      )}
      {queueHealth.counts.failed > 0 && (
        <span
          title={t('activity:kanban.failedTasks')}
          className="inline-flex items-center gap-1 text-destructive"
        >
          {queueHealth.counts.failed} {t('activity:kanban.statusFailed')}
        </span>
      )}
      {queueHealth.dependencyBlocked.count > 0 && (
        <span
          title={t('activity:kanban.blockedByDeps')}
          className="inline-flex items-center gap-1 rounded bg-warning/10 px-1.5 py-0.5 text-warning"
        >
          {queueHealth.dependencyBlocked.count} {t('activity:kanban.statusBlockedByDeps')}
        </span>
      )}
      {queueHealth.staleAssignments.count > 0 && (
        <span
          title={t('activity:kanban.expiredLeases')}
          className="inline-flex items-center gap-1 rounded bg-destructive/10 px-1.5 py-0.5 text-destructive"
        >
          {queueHealth.staleAssignments.count} {t('activity:kanban.statusStale')}
        </span>
      )}
      {/* "Healthy" used to be computed here from three of the six signals, so a
          board with failed or retryable-failed cards showed a green badge next
          to its own red failure pill. `hasKanbanQueueAnomalies` is the shared
          predicate the routes and the supervisor use. */}
      {!hasKanbanQueueAnomalies(queueHealth) && (
        <span className="text-success">{t('activity:kanban.healthy')}</span>
      )}
      {runningCostTotal > 0 && (
        <span
          title={t('activity:kanban.costCeilingSum')}
          className="inline-flex items-center gap-1 text-info"
        >
          {t('activity:kanban.runningCost', { cost: runningCostTotal.toFixed(2) })}
        </span>
      )}
    </div>
  );
}
