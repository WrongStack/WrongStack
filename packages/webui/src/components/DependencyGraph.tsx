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
  { icon: React.ReactNode; label: string; text: string; ring: string }
> = {
  completed: { icon: <CheckCircle2 className="h-3.5 w-3.5" />, label: 'Completed', text: 'text-[hsl(var(--success))]', ring: 'border-[hsl(var(--success)/0.35)]' },
  in_progress: { icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />, label: 'Running', text: 'text-primary', ring: 'border-primary/45' },
  queued: { icon: <Clock className="h-3.5 w-3.5" />, label: 'Queued', text: 'text-[hsl(var(--warning))]', ring: 'border-[hsl(var(--warning)/0.35)]' },
  blocked: { icon: <Lock className="h-3.5 w-3.5" />, label: 'Blocked', text: 'text-destructive', ring: 'border-destructive/30' },
  pending: { icon: <Circle className="h-3.5 w-3.5" />, label: 'Pending', text: 'text-muted-foreground', ring: 'border-border/70' },
  review: { icon: <RotateCcw className="h-3.5 w-3.5" />, label: 'Review', text: 'text-primary', ring: 'border-primary/35' },
  failed: { icon: <XCircle className="h-3.5 w-3.5" />, label: 'Failed', text: 'text-destructive', ring: 'border-destructive/45' },
  cancelled: { icon: <Ban className="h-3.5 w-3.5" />, label: 'Cancelled', text: 'text-muted-foreground', ring: 'border-border/70' },
};

const LEGEND: BoardTaskStatus[] = ['completed', 'in_progress', 'queued', 'blocked', 'pending', 'failed'];

const PRIORITY: Record<BoardTaskItem['priority'], { label: string; cls: string }> = {
  critical: { label: 'Crit', cls: 'bg-destructive/10 text-destructive' },
  high: { label: 'High', cls: 'bg-destructive/10 text-destructive' },
  medium: { label: 'Med', cls: 'bg-[hsl(var(--warning)/0.12)] text-[hsl(var(--warning))]' },
  low: { label: 'Low', cls: 'bg-[hsl(var(--success)/0.12)] text-[hsl(var(--success))]' },
};

export interface DependencyGraphProps {
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
              <div className="flex h-full items-center pt-8 text-muted-foreground/60">
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
        <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', prio.cls)}>{prio.label}</span>
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
