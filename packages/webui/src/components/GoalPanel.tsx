import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/i18n';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock,
  Target,
  TrendingDown,
  TrendingUp,
  Minus,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import type { GoalState } from '@/lib/goal';
import { getWSClient } from '@/lib/ws-client';

// ── Helpers ────────────────────────────────────────────────────────────────

const TREND_ICON: Record<string, ReactNode> = {
  up: <TrendingUp className="h-3.5 w-3.5 text-success" />,
  down: <TrendingDown className="h-3.5 w-3.5 text-destructive" />,
  stable: <Minus className="h-3.5 w-3.5 text-warning" />,
};

const STATE_CONFIG: Record<GoalState['goalState'], { color: string; bg: string; labelKey: string }> = {
  active: {
    color: 'text-success',
    bg: 'bg-success/10',
    labelKey: 'statusActive',
  },
  paused: {
    color: 'text-warning',
    bg: 'bg-warning/10',
    labelKey: 'statusPaused',
  },
  completed: {
    color: 'text-info',
    bg: 'bg-info/10',
    labelKey: 'statusDone',
  },
  failed: {
    color: 'text-destructive',
    bg: 'bg-destructive/10',
    labelKey: 'statusFailed',
  },
  abandoned: {
    color: 'text-muted-foreground',
    bg: 'bg-muted',
    labelKey: 'statusAbandoned',
  },
};

// ── Component ──────────────────────────────────────────────────────────────

export interface GoalPanelProps {
  goal: GoalState | null;
  className?: string | undefined;
}

export function GoalPanel({ goal, className }: GoalPanelProps): React.ReactElement | null {
  const { t } = useAppTranslation();
  const [collapsed, setCollapsed] = useState(false);

  // Request goal data on mount and poll every 10s so the panel stays
  // in sync with the disk (goal.json is written by the agent / CLI).
  useEffect(() => {
    const ws = getWSClient();
    ws?.send?.({ type: 'goal.get' });
    const timer = setInterval(() => {
      ws?.send?.({ type: 'goal.get' });
    }, 10_000);
    return () => clearInterval(timer);
  }, []);

  // Auto-collapse when goal state changes (e.g. completed → null).
  // Must come BEFORE any early returns — hook count must be stable.
  useEffect(() => {
    if (!goal || goal.goalState === 'completed' || goal.goalState === 'failed' || goal.goalState === 'abandoned') {
      setCollapsed(true);
    }
  }, [goal]);

  // Hide the panel when there's no goal, or when the goal is terminal
  // (completed / failed) — it's served its purpose and shouldn't linger.
  if (!goal) return null;
  if (goal.goalState === 'completed' || goal.goalState === 'failed' || goal.goalState === 'abandoned') return null;

  const stateCfg = STATE_CONFIG[goal.goalState];
  const completedDeliverables =
    goal.deliverables?.filter((d) => d.status === 'done').length ?? 0;
  const totalDeliverables = goal.deliverables?.length ?? 0;
  const recentJournal = goal.journal?.slice(-5).reverse() ?? [];
  const trendIcon = goal.progressTrend ? TREND_ICON[goal.progressTrend] : null;

  return (
    <div className={cn('rounded-lg border border-border bg-card/60 backdrop-blur-sm', className)}>
      {/* Header */}
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-accent/40 rounded-t-lg transition-colors"
      >
        <Target className="h-4 w-4 text-primary" />
        <span className="text-xs font-semibold text-foreground flex-1 min-w-0 truncate">
          {t('activity:goal.heading')}
        </span>
        <span
          className={cn(
            'inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium shrink-0',
            stateCfg.bg,
            stateCfg.color,
          )}
        >
          {t(`activity:goal.${stateCfg.labelKey}`)}
        </span>
        {collapsed ? (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        )}
      </button>

      {!collapsed && (
        <div className="px-3 pb-3 space-y-3 border-t pt-2">
          {/* Goal text */}
          <div>
            <p className="text-xs text-foreground leading-relaxed whitespace-pre-wrap break-words">
              {goal.goal}
            </p>
            {goal.refinedGoal && goal.refinedGoal !== goal.goal && (
              <div className="mt-1.5 p-2 rounded bg-accent/40 border border-border/50">
                <p className="text-[10px] text-muted-foreground mb-0.5 uppercase tracking-wider font-medium">
                  {t('activity:goal.refined')}
                </p>
                <p className="text-xs leading-relaxed whitespace-pre-wrap break-words">
                  {goal.refinedGoal}
                </p>
              </div>
            )}
          </div>

          {/* Progress bar */}
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[10px]">
              <span className="text-muted-foreground uppercase tracking-wider font-medium">
                {t('activity:goal.progress')}
              </span>
              <span className="flex items-center gap-1 tabular-nums">
                {trendIcon}
                <span className="font-medium text-foreground">{goal.progress}%</span>
              </span>
            </div>
            <div className="h-1.5 bg-muted rounded-full overflow-hidden">
              <div
                className={cn(
                  'h-full transition-all duration-700 rounded-full',
                  goal.progress >= 80
                    ? 'bg-success'
                    : goal.progress >= 50
                      ? 'bg-warning'
                      : 'bg-primary',
                )}
                style={{ width: `${goal.progress > 0 ? Math.max(2, goal.progress) : 0}%` }}
              />
            </div>
            {goal.progressNote && (
              <p className="text-[10px] text-muted-foreground italic">{goal.progressNote}</p>
            )}
          </div>

          {/* Iteration count */}
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <Clock className="h-3 w-3" />
            <span className="tabular-nums font-medium">{goal.iterations}</span>
            <span>{t('activity:goal.iterations')}</span>
            {goal.lastStatus && <span className="text-border">·</span>}
            {goal.lastStatus && <span className="truncate">{goal.lastStatus}</span>}
          </div>

          {/* Deliverables */}
          {totalDeliverables > 0 && (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[10px] text-muted-foreground uppercase tracking-wider font-medium">
                <span>{t('activity:goal.deliverables')}</span>
                <span className="tabular-nums">
                  {completedDeliverables}/{totalDeliverables}
                </span>
              </div>
              <ul className="space-y-0.5">
                {goal.deliverables?.map((d) => (
                  <li key={d.id} className="flex items-start gap-1.5 text-[11px]">
                    {d.status === 'done' ? (
                      <CheckCircle2 className="h-3 w-3 text-success mt-0.5 shrink-0" />
                    ) : (
                      <Circle className="h-3 w-3 text-muted-foreground/50 mt-0.5 shrink-0" />
                    )}
                    <span
                      className={cn(
                        'leading-snug',
                        d.status === 'done'
                          ? 'text-muted-foreground line-through'
                          : 'text-foreground',
                      )}
                    >
                      {d.text}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Recent journal */}
          {recentJournal.length > 0 && (
            <div className="space-y-1">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">
                {t('activity:goal.recentActivity')}
              </p>
              <div className="space-y-1">
                {recentJournal.map((entry, i) => (
                  <div
                    key={`${entry.iteration}-${i}`}
                    className="flex items-start gap-1.5 text-[10px] text-muted-foreground"
                  >
                    <span className="font-mono tabular-nums shrink-0 text-foreground/60">
                      #{entry.iteration}
                    </span>
                    <span className="truncate">
                      {entry.task || entry.status || entry.progressNote || '…'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
