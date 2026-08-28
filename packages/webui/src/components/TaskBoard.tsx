import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/i18n';
import type React from 'react';
import { TaskCard, type TaskItem } from './TaskCard';

// Re-exported so existing importers (`PhasePanel`, `GoalView`) keep working
// after the card was extracted into its own reusable component.
export type { TaskItem } from './TaskCard';

interface TaskBoardProps {
  phaseName: string;
  phaseStatus: string;
  tasks: TaskItem[];
  /** Change task status */
  onTaskStatusChange?: (taskId: string, status: TaskItem['status']) => void;
  className?: string | undefined;
}

/**
 * TaskBoard — chat-area task list for a single selected phase.
 *
 * Groups the phase's tasks by status into stacked sections. The full kanban
 * (phase columns / status swimlanes, drag-drop, manual assignment) lives in
 * BoardView; this stays the compact in-context list.
 */
export function TaskBoard({
  phaseName,
  phaseStatus,
  tasks,
  onTaskStatusChange,
  className,
}: TaskBoardProps): React.ReactElement {
  const { t } = useAppTranslation();
  const grouped = {
    in_progress: tasks.filter((task) => task.status === 'in_progress'),
    pending: tasks.filter((task) => task.status === 'pending' || task.status === 'blocked'),
    review: tasks.filter((task) => task.status === 'review'),
    failed: tasks.filter((task) => task.status === 'failed'),
    completed: tasks.filter((task) => task.status === 'completed'),
  };

  const statusOrder = ['in_progress', 'pending', 'review', 'failed', 'completed'] as const;
  const groupLabelKey: Record<(typeof statusOrder)[number], string> = {
    in_progress: 'statusInProgress',
    pending: 'statusPending',
    review: 'statusReview',
    failed: 'statusFailed',
    completed: 'statusDone',
  };
  const badgeKey: Record<string, string> = {
    running: 'statusRunning',
    completed: 'statusCompleted',
    failed: 'statusFailed',
    paused: 'statusPaused',
    ready: 'statusReady',
  };
  const completedCount = tasks.filter((task) => task.status === 'completed').length;

  return (
    <div className={cn('flex h-full min-h-0 min-w-0 flex-col bg-background', className)}>
      {/* Header */}
      <div className="p-4 border-b border-border">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-foreground">{phaseName}</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              {t('activity:task.boardCount', { total: tasks.length, done: completedCount })}
            </p>
          </div>
          <div
            className={cn(
              'px-3 py-1 rounded-full text-xs font-medium',
              phaseStatus === 'running'
                ? 'bg-primary/15 text-primary'
                : phaseStatus === 'completed'
                  ? 'bg-success/15 text-success'
                  : phaseStatus === 'failed'
                    ? 'bg-destructive/15 text-destructive'
                    : 'bg-muted text-muted-foreground',
            )}
          >
            {badgeKey[phaseStatus]
              ? t(`activity:phase.${badgeKey[phaseStatus]}`)
              : t('activity:phase.statusPending')}
          </div>
        </div>
      </div>

      {/* Task Groups */}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-4 space-y-6">
        {statusOrder.map((groupKey) => {
          const groupTasks = grouped[groupKey];
          if (groupTasks.length === 0) return null;
          return (
            <div key={groupKey}>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                {t(`activity:task.${groupLabelKey[groupKey]}`)} ({groupTasks.length})
              </h3>
              <div className="space-y-2">
                {groupTasks.map((task) => (
                  <TaskCard key={task.id} task={task} onStatusChange={onTaskStatusChange} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
