/**
 * What makes a board's queue worth looking at — one definition, shared by every
 * surface that renders an "attention" or "healthy" verdict.
 *
 * Three surfaces each grew their own arithmetic for this. The WebUI route
 * summed stale + dependencyBlocked + failedRetryable + failed + blocked; the
 * background supervisor summed stale + heartbeatDue + failed + blocked; the
 * WebUI health bar called a board healthy whenever heartbeat, stale and
 * dependency signals were clear — so a board with failed cards showed a green
 * "healthy" badge directly beside its own red failure pill. Same board, three
 * verdicts.
 *
 * Kept as a leaf module with type-only imports, and published on its own
 * `@wrongstack/kanban/queue-anomalies` subpath, because the WebUI renders this
 * in the browser: importing it from the package barrel would drag the IPC
 * client (`node:net`, `node:child_process`) into the browser bundle. The
 * `contract-graph` subpath exists for the same reason.
 */
import type { KanbanQueueHealth } from './types-operations.js';

export interface KanbanQueueAnomalySignal {
  /** Stable identifier; safe to use as a translation key suffix. */
  code:
    | 'stale_assignments'
    | 'heartbeat_due'
    | 'dependency_blocked'
    | 'failed_retryable'
    | 'failed'
    | 'blocked';
  count: number;
}

/**
 * The live anomaly signals on a board, strongest concern first.
 *
 * Returns only signals with a non-zero count, so an empty array means healthy.
 */
export function kanbanQueueAnomalySignals(health: KanbanQueueHealth): KanbanQueueAnomalySignal[] {
  const signals: KanbanQueueAnomalySignal[] = [
    { code: 'stale_assignments', count: health.staleAssignments.count },
    { code: 'failed', count: health.counts.failed },
    { code: 'blocked', count: health.counts.blocked },
    { code: 'failed_retryable', count: health.failedRetryable.count },
    { code: 'dependency_blocked', count: health.dependencyBlocked.count },
    { code: 'heartbeat_due', count: health.heartbeatDue.count },
  ];
  return signals.filter((signal) => signal.count > 0);
}

/**
 * Total weight of the live signals. Drives `attention` vs `healthy`.
 *
 * The counts deliberately overlap — a `failed_retryable` card is also counted
 * in `failed` — because this number ranks attention rather than partitioning
 * tasks. Never present it as a task count; branch on
 * {@link hasKanbanQueueAnomalies} instead of comparing the magnitude.
 */
export function kanbanQueueAnomalyCount(health: KanbanQueueHealth): number {
  return kanbanQueueAnomalySignals(health).reduce((total, signal) => total + signal.count, 0);
}

/** Whether any anomaly signal is live. The predicate display surfaces should use. */
export function hasKanbanQueueAnomalies(health: KanbanQueueHealth): boolean {
  return kanbanQueueAnomalySignals(health).length > 0;
}
