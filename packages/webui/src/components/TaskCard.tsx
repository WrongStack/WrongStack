import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/i18n';
import { CheckCircle2, Circle, Clock, Pause, RotateCcw, UserCog, XCircle } from 'lucide-react';
import type React from 'react';
import { useState } from 'react';

export interface TaskItem {
  id: string;
  title: string;
  description: string;
  status: 'pending' | 'in_progress' | 'blocked' | 'failed' | 'review' | 'completed';
  priority: 'critical' | 'high' | 'medium' | 'low';
  type: 'feature' | 'bugfix' | 'refactor' | 'docs' | 'test' | 'chore';
  estimateHours?: number | undefined;
  actualHours?: number | undefined;
  assignee?: string | undefined;
  tags: string[];
  startedAt?: number | undefined;
  completedAt?: number | undefined;
}

// Token-driven so every state reads correctly in both light and dark.
const TASK_STATUS_CONFIG: Record<TaskItem['status'], { icon: React.ReactNode; color: string }> = {
  pending: { icon: <Circle className="w-4 h-4" />, color: 'text-muted-foreground' },
  in_progress: { icon: <Clock className="w-4 h-4 animate-spin" />, color: 'text-primary' },
  blocked: { icon: <Pause className="w-4 h-4" />, color: 'text-warning' },
  failed: { icon: <XCircle className="w-4 h-4" />, color: 'text-destructive' },
  review: { icon: <RotateCcw className="w-4 h-4" />, color: 'text-info' },
  completed: { icon: <CheckCircle2 className="w-4 h-4" />, color: 'text-success' },
};

const PRIORITY_BADGE: Record<TaskItem['priority'], string> = {
  critical: 'bg-destructive/15 text-destructive',
  high: 'bg-warning/15 text-warning',
  medium: 'bg-info/15 text-info',
  low: 'bg-muted text-muted-foreground',
};

const TYPE_BADGE: Record<TaskItem['type'], string> = {
  feature: 'bg-success/15 text-success',
  bugfix: 'bg-destructive/15 text-destructive',
  refactor: 'bg-primary/15 text-primary',
  docs: 'bg-info/15 text-info',
  test: 'bg-primary/15 text-primary',
  chore: 'bg-muted text-muted-foreground',
};

function formatTime(ms?: number): string {
  if (!ms) return '';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}

interface TaskCardProps {
  task: TaskItem;
  /** Change task status (Start / Complete / Fail quick actions). */
  onStatusChange?: ((taskId: string, status: TaskItem['status']) => void) | undefined;
  /** Requeue a failed/completed task so it (re)runs. */
  onRetry?: ((taskId: string) => void) | undefined;
  /** Agent names available for manual assignment (enables the assign control). */
  agents?: string[] | undefined;
  /** Assign this task to a specific agent (empty string clears the assignment). */
  onAssign?: ((taskId: string, agentName: string) => void) | undefined;
  /** Render without quick-action buttons (e.g. inside a tight column). */
  compact?: boolean | undefined;
  className?: string | undefined;
}

/**
 * TaskCard — a single board card. Presentation + inline actions only; drag
 * behaviour is layered on by the surrounding column (see BoardView), so this
 * component stays reusable between the chat-area TaskBoard and the kanban.
 */
export function TaskCard({
  task,
  onStatusChange,
  onRetry,
  agents,
  onAssign,
  compact,
  className,
}: TaskCardProps): React.ReactElement {
  const { t } = useAppTranslation();
  const status = TASK_STATUS_CONFIG[task.status];
  const [assigning, setAssigning] = useState(false);
  const running = task.status === 'in_progress';

  return (
    <div
      className={cn(
        'w-full text-left rounded-lg border p-3 transition-all hover:shadow-sm',
        running
          ? 'border-primary/40 bg-primary/5'
          : task.status === 'completed'
            ? 'border-success/35 bg-success/6'
            : task.status === 'failed'
              ? 'border-destructive/40 bg-destructive/5'
              : 'border-border bg-card',
        className,
      )}
    >
      {/* Header */}
      <div className="flex items-start gap-2">
        <span
          className={cn('mt-0.5', status.color)}
          role="img"
          aria-label={running ? t('common:status.inProgress') : undefined}
        >
          {status.icon}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium">{task.title}</span>
            <span
              className={cn(
                'px-1.5 py-0.5 rounded text-[10px] font-medium',
                PRIORITY_BADGE[task.priority],
              )}
            >
              {task.priority}
            </span>
            <span
              className={cn('px-1.5 py-0.5 rounded text-[10px] font-medium', TYPE_BADGE[task.type])}
            >
              {task.type}
            </span>
          </div>
          {task.description && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{task.description}</p>
          )}
        </div>
      </div>

      {/* Live worker — who is on this task right now. */}
      {task.assignee && (
        <div
          className={cn(
            'mt-2 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium',
            running ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground',
          )}
        >
          {running && (
            <Clock className="w-3 h-3 animate-spin" aria-label={t('common:status.working')} />
          )}
          <span>{task.assignee}</span>
        </div>
      )}

      {/* Meta */}
      <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
        {task.estimateHours ? <span>~{task.estimateHours}h</span> : null}
        {task.actualHours ? <span>• {task.actualHours}h</span> : null}
        {task.startedAt ? <span>• {formatTime(Date.now() - task.startedAt)}</span> : null}
      </div>

      {/* Tags */}
      {task.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {task.tags.map((tag) => (
            <span
              key={tag}
              className="px-1.5 py-0.5 rounded text-[10px] bg-muted text-muted-foreground"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Actions */}
      {!compact && (
        <div className="flex flex-wrap items-center gap-1 mt-2">
          {onStatusChange && task.status !== 'in_progress' && task.status !== 'completed' && (
            <button
              type="button"
              onClick={() => onStatusChange(task.id, 'in_progress')}
              className="px-2 py-0.5 text-[10px] rounded bg-primary/15 text-primary hover:bg-primary/25 transition-colors"
            >
              {t('activity:task.start')}
            </button>
          )}
          {onStatusChange && task.status === 'in_progress' && (
            <button
              type="button"
              onClick={() => onStatusChange(task.id, 'completed')}
              className="px-2 py-0.5 text-[10px] rounded bg-success/15 text-success hover:bg-success/25 transition-colors"
            >
              {t('activity:task.complete')}
            </button>
          )}
          {onRetry && (task.status === 'failed' || task.status === 'completed') && (
            <button
              type="button"
              onClick={() => onRetry(task.id)}
              className="px-2 py-0.5 text-[10px] rounded bg-muted text-muted-foreground hover:bg-muted/70 transition-colors inline-flex items-center gap-1"
            >
              <RotateCcw className="w-3 h-3" /> {t('activity:task.retry')}
            </button>
          )}
          {onAssign &&
            agents &&
            agents.length > 0 &&
            (assigning ? (
              <select
                defaultValue={task.assignee ?? ''}
                onChange={(e) => {
                  onAssign(task.id, e.target.value);
                  setAssigning(false);
                }}
                onBlur={() => setAssigning(false)}
                className="px-1 py-0.5 text-[10px] rounded border border-border bg-card"
              >
                <option value="">{t('activity:task.unassigned')}</option>
                {agents.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            ) : (
              <button
                type="button"
                onClick={() => setAssigning(true)}
                className="px-2 py-0.5 text-[10px] rounded bg-muted text-muted-foreground hover:bg-muted/70 transition-colors inline-flex items-center gap-1"
                title={t('activity:task.assignTitle')}
              >
                <UserCog className="w-3 h-3" /> {t('activity:task.assign')}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
