import { getWSClient } from '@/lib/ws-client';
import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/i18n';
import { CheckCircle2, Circle, Clock, Pause, XCircle, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

interface TaskItem {
  id: string;
  title: string;
  description?: string | undefined;
  type: 'feature' | 'bugfix' | 'refactor' | 'docs' | 'test' | 'chore';
  priority: 'critical' | 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'blocked' | 'failed' | 'review' | 'completed';
  dependsOn?: string[] | undefined;
  assignee?: string | undefined;
  estimateHours?: number | undefined;
  tags?: string[] | undefined;
}

const STATUS_CONFIG: Record<TaskItem['status'], { icon: React.ReactNode; labelKey: string; color: string }> = {
  pending: { icon: <Circle className="w-3.5 h-3.5" />, labelKey: 'statusPending', color: 'text-muted-foreground/50' },
  in_progress: { icon: <Clock className="w-3.5 h-3.5 animate-spin" />, labelKey: 'statusInProgress', color: 'text-warning' },
  blocked: { icon: <Pause className="w-3.5 h-3.5" />, labelKey: 'statusBlocked', color: 'text-warning' },
  failed: { icon: <XCircle className="w-3.5 h-3.5" />, labelKey: 'statusFailed', color: 'text-destructive' },
  review: { icon: <RotateCcw className="w-3.5 h-3.5" />, labelKey: 'statusReview', color: 'text-info' },
  completed: { icon: <CheckCircle2 className="w-3.5 h-3.5" />, labelKey: 'statusDone', color: 'text-success' },
};

const PRIORITY_COLOR: Record<TaskItem['priority'], string> = {
  critical: 'text-destructive',
  high: 'text-warning',
  medium: 'text-warning/85',
  low: 'text-muted-foreground',
};

const TYPE_ICON: Record<TaskItem['type'], string> = {
  feature: '⚡',
  bugfix: '🐛',
  refactor: '♻️',
  docs: '📝',
  test: '🧪',
  chore: '🔧',
};

/**
 * Live task list panel. Connects via WebSocket, requests the current
 * task snapshot, and stays in sync via `tasks.updated` events.
 *
 * **Interactive**: Each task shows quick-action buttons:
 * - **Start** (pending/blocked/failed/review → in_progress)
 * - **Complete** (in_progress → completed)
 * - **Fail** (any non-completed → failed)
 *
 * Groups: In Progress → Blocked → Review → Pending → Failed → Completed.
 * Each collapsible. Auto-hides empty sections.
 */
export function TasksPanel(): React.ReactElement | null {
  const { t } = useAppTranslation();
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const ws = getWSClient();
  const offRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    ws.getTasks();
    offRef.current = ws.on('tasks.updated', (msg: unknown) => {
      const payload = (msg as { payload?: { tasks?: TaskItem[] } })?.payload;
      if (payload?.tasks) setTasks(payload.tasks);
    });
    return () => { offRef.current?.(); };
  }, [ws]);

  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const handleStatusChange = useCallback(
    (taskId: string, status: TaskItem['status']) => {
      ws.updateTaskStatus(taskId, status);
    },
    [ws],
  );

  const statusOrder: TaskItem['status'][] = ['in_progress', 'blocked', 'review', 'pending', 'failed', 'completed'];
  const grouped = new Map<TaskItem['status'], TaskItem[]>();
  for (const t of tasks) {
    const list = grouped.get(t.status) ?? [];
    list.push(t);
    grouped.set(t.status, list);
  }

  const completed = grouped.get('completed')?.length ?? 0;
  if (tasks.length === 0) return null;

  return (
    <div className="rounded-lg border border-border bg-card/50 backdrop-blur-sm overflow-hidden">
      <div className="px-3 py-1.5 flex items-center gap-2 border-b border-border/50">
        <h2 className="text-[11px] font-semibold text-foreground uppercase tracking-wider">{t('activity:work.tasks')}</h2>
        <span className="tabular text-[10px] text-muted-foreground ml-auto">
          {completed}/{tasks.length}
        </span>
      </div>

      {statusOrder.map((status) => {
        const group = grouped.get(status);
        if (!group || group.length === 0) return null;
        const cfg = STATUS_CONFIG[status];
        const isCollapsed = collapsed.has(status);

        return (
          <div key={status} className="border-b border-border/30 last:border-b-0">
            <button
              type="button"
              onClick={() => toggle(status)}
              className="w-full px-3 py-1 flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            >
              <span className="tabular">{isCollapsed ? '▶' : '▼'} {group.length} {t(`activity:task.${cfg.labelKey}`)}</span>
            </button>
            {!isCollapsed && group.map((task) => (
              <div
                key={task.id}
                className={cn(
                  'px-3 py-1.5 flex items-start gap-2 text-[13px] group',
                  task.status === 'in_progress' ? 'bg-warning/8' : '',
                )}
              >
                <span className={cn('mt-0.5 shrink-0', cfg.color)}>{cfg.icon}</span>
                <span className="leading-snug flex-1 min-w-0">
                  <span className={cn(task.status === 'completed' ? 'text-muted-foreground line-through' : 'text-foreground/80')}>
                    {TYPE_ICON[task.type]} {task.title}
                  </span>
                  {task.priority !== 'medium' && (
                    <span className={cn('ml-1 text-[10px]', PRIORITY_COLOR[task.priority])}>
                      {task.priority}
                    </span>
                  )}
                  {task.assignee && (
                    <span className="ml-1 text-[10px] text-muted-foreground">@{task.assignee}</span>
                  )}
                  {task.estimateHours && (
                    <span className="ml-1 text-[10px] text-muted-foreground">{task.estimateHours}h</span>
                  )}
                </span>

                {/* Quick Actions */}
                <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                  {task.status !== 'in_progress' && task.status !== 'completed' && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); handleStatusChange(task.id, 'in_progress'); }}
                      className="px-1.5 py-0.5 text-[9px] rounded bg-primary/15 text-primary hover:bg-primary/25 transition-colors"
                      title={t('activity:task.startTitle')}
                    >
                      {t('common:action.start')}
                    </button>
                  )}
                  {task.status === 'in_progress' && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); handleStatusChange(task.id, 'completed'); }}
                      className="px-1.5 py-0.5 text-[9px] rounded bg-[hsl(var(--success)/0.15)] text-[hsl(var(--success))] hover:bg-[hsl(var(--success)/0.25)] transition-colors"
                      title={t('activity:task.completeTitle')}
                    >
                      {t('activity:task.statusDone')}
                    </button>
                  )}
                  {task.status !== 'completed' && task.status !== 'failed' && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); handleStatusChange(task.id, 'failed'); }}
                      className="px-1.5 py-0.5 text-[9px] rounded bg-destructive/15 text-destructive hover:bg-destructive/25 transition-colors"
                      title={t('activity:task.failTitle')}
                    >
                      {t('activity:task.fail')}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
