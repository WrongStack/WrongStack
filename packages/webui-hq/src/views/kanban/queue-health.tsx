/**
 * Queue health strip. Only the buckets that are non-zero are rendered, so the
 * row reads as "what is true right now" rather than a table of mostly zeroes.
 */
import { Activity, CircleCheck, CirclePause, CirclePlay, Clock3, TriangleAlert } from 'lucide-react';
import type * as React from 'react';
import { Badge, type BadgeTone } from '../../components/ui/badge.js';
import type { HqKanbanBoardView } from '../../domain/kanban-model.js';
import { computeQueueCounts, isQueueHealthy } from '../../domain/kanban-queue-health.js';

export function KanbanQueueHealth({ board }: { board: HqKanbanBoardView }): React.ReactElement {
  const counts = computeQueueCounts(board);

  const buckets: { key: string; count: number; tone: BadgeTone; icon: typeof Activity; title: string }[] =
    [
      { key: 'ready', count: counts.startable, tone: 'info', icon: CirclePlay, title: 'Claimable tasks' },
      { key: 'running', count: counts.running, tone: 'running', icon: Activity, title: 'Running assignments' },
      { key: 'review', count: counts.review, tone: 'warn', icon: Clock3, title: 'In review' },
      { key: 'blocked', count: counts.blocked, tone: 'warn', icon: CirclePause, title: 'Manually blocked' },
      { key: 'failed', count: counts.failed, tone: 'error', icon: TriangleAlert, title: 'Failed tasks' },
    ];

  return (
    <div
      role="status"
      aria-label="Queue health"
      data-testid="queue-health"
      className="flex flex-wrap items-center gap-1.5"
    >
      <span className="text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
        Queue health
      </span>
      {buckets
        .filter((bucket) => bucket.count > 0)
        .map(({ key, count, tone, icon: Icon, title }) => (
          <Badge key={key} tone={tone} title={title} data-bucket={key}>
            <Icon />
            {count} {key}
          </Badge>
        ))}
      {isQueueHealthy(counts) && (
        <Badge tone="active" title="No blocked or failed tasks">
          <CircleCheck />
          healthy
        </Badge>
      )}
    </div>
  );
}
