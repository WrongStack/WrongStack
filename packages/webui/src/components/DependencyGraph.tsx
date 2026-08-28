import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/i18n';
import type { BoardTaskItem, BoardTaskStatus, SpecColumn } from '@/stores';
import {
  Ban,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock,
  Loader2,
  Lock,
  RotateCcw,
  XCircle,
} from 'lucide-react';
import type React from 'react';

/** FORGE-style status presentation (Completed/Running/Queued/Blocked/Pending/Failed). */
const STATUS: Record<
  BoardTaskStatus,
  { icon: React.ReactNode; text: string; ring: string }
> = {
  completed: { icon: <CheckCircle2 className="h-3.5 w-3.5" />, text: 'text-success', ring: 'border-success/35' },
  in_progress: { icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />, text: 'text-primary', ring: 'border-primary/45' },
  queued: { icon: <Clock className="h-3.5 w-3.5" />, text: 'text-warning', ring: 'border-warning/35' },
  blocked: { icon: <Lock className="h-3.5 w-3.5" />, text: 'text-destructive', ring: 'border-destructive/30' },
  pending: { icon: <Circle className="h-3.5 w-3.5" />, text: 'text-muted-foreground', ring: 'border-border/70' },
  review: { icon: <RotateCcw className="h-3.5 w-3.5" />, text: 'text-primary', ring: 'border-primary/35' },
  failed: { icon: <XCircle className="h-3.5 w-3.5" />, text: 'text-destructive', ring: 'border-destructive/45' },
  cancelled: { icon: <Ban className="h-3.5 w-3.5" />, text: 'text-muted-foreground', ring: 'border-border/70' },
};

const LEGEND: BoardTaskStatus[] = ['completed', 'in_progress', 'queued', 'blocked', 'pending', 'failed'];

const PRIORITY: Record<BoardTaskItem['priority'], { labelKey: string; cls: string }> = {
  critical: { labelKey: 'activity:depGraph.prioCrit', cls: 'bg-destructive/10 text-destructive' },
  high: { labelKey: 'activity:depGraph.prioHigh', cls: 'bg-destructive/10 text-destructive' },
  medium: { labelKey: 'activity:depGraph.prioMed', cls: 'bg-warning/12 text-warning' },
  low: { labelKey: 'activity:depGraph.prioLow', cls: 'bg-success/12 text-success' },
};

interface DependencyGraphProps {
  columns: SpecColumn[];
  onTaskClick?: ((taskId: string) => void) | undefined;
}

/**
 * DependencyGraph — FORGE-style task board. Tasks are laid into topological
 * phase columns (Start, Phase 1, …); each card shows its short id, priority,
 * title and dependency refs (← t01). A status legend sits above the columns.
 */
export function DependencyGraph({ columns, onTaskClick }: DependencyGraphProps): React.ReactElement {
  const { t } = useAppTranslation();
  if (columns.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
        {t('activity:board.emptySpec')}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border/70 bg-card/75 p-4 shadow-sm">
      <h3 className="mb-3 text-sm font-semibold text-foreground">{t('activity:board.depGraphHeading')}</h3>

      {/* Legend */}
      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        {LEGEND.map((s) => (
          <span key={s} className={cn('inline-flex items-center gap-1.5', STATUS[s].text)}>
            {STATUS[s].icon}
            <span className="text-muted-foreground">{t(`activity:board.status.${s}`)}</span>
          </span>
        ))}
      </div>

      {/* Columns */}
      <div className="flex gap-3 overflow-x-auto pb-2">
        {columns.map((col, ci) => (
          <div key={col.label} className="flex items-start gap-3">
            <div className="w-60 shrink-0">
              <div className="mb-2 border-b border-border/60 pb-1 text-center text-xs font-medium uppercase text-muted-foreground">
                {col.label}
              </div>
              <div className="space-y-2">
                {col.tasks.map((task) => (
                  <TaskNodeCard key={task.id} task={task} onClick={onTaskClick} />
                ))}
              </div>
            </div>
            {ci < columns.length - 1 && (
              <div className="flex h-full items-center pt-8 text-muted-foreground/75">
                <ChevronRight className="h-5 w-5" />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function TaskNodeCard({
  task,
  onClick,
}: {
  task: BoardTaskItem;
  onClick?: ((taskId: string) => void) | undefined;
}): React.ReactElement {
  const s = STATUS[task.displayStatus];
  const prio = PRIORITY[task.priority];
  const { t } = useAppTranslation();
  return (
    <button
      type="button"
      onClick={() => onClick?.(task.id)}
      className={cn(
        'w-full rounded-lg border bg-background/55 p-2.5 text-left shadow-sm transition-colors hover:border-primary/35 hover:bg-accent/35',
        s.ring,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium', s.text)}>
          {s.icon}
          <span className="font-mono text-foreground">{task.shortId}</span>
        </span>
        <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', prio.cls)}>
          {t(prio.labelKey)}
        </span>
      </div>
      <p className="mt-1.5 text-xs text-foreground">{task.title}</p>
      {task.deps.length > 0 && (
        <p className="mt-1 font-mono text-[10px] text-muted-foreground">← {task.deps.join(', ')}</p>
      )}
      {task.agentName && (
        <div
          className={cn(
            'mt-1.5 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px]',
            task.displayStatus === 'in_progress'
              ? 'bg-primary/10 text-primary'
              : 'bg-muted text-muted-foreground',
          )}
          title={task.worktreeBranch ? t('activity:board.worktreePrefix', { branch: task.worktreeBranch }) : undefined}
        >
          {task.displayStatus === 'in_progress' && <Loader2 className="h-3 w-3 animate-spin" />}
          <span>{task.agentName}</span>
        </div>
      )}
    </button>
  );
}
