import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/i18n';
import { CheckCircle2, Circle, Clock, Pause, Play, SkipForward, XCircle } from 'lucide-react';
import type React from 'react';
import { useScrollPosition } from '@/hooks/useScrollPosition';
import type { TaskItem } from './TaskBoard';

export interface PhaseItem {
  id: string;
  name: string;
  description: string;
  status: 'pending' | 'ready' | 'running' | 'paused' | 'completed' | 'failed' | 'skipped';
  priority: 'critical' | 'high' | 'medium' | 'low';
  estimateHours: number;
  actualDurationMs?: number | undefined;
  startedAt?: number | undefined;
  completedAt?: number | undefined;
  progressPercent: number;
  taskCount: number;
  completedTasks: number;
  assignedAgents: string[];
  isActive: boolean;
  /** Full task list for this phase — present when served by the board-aware state. */
  tasks?: TaskItem[] | undefined;
}

export interface PhasePanelProps {
  phases: PhaseItem[];
  /** Active phase ID */
  activePhaseId?: string | undefined;
  /** Called when a phase is clicked */
  onPhaseClick?: ((phaseId: string) => void) | undefined;
  /** Overall progress (0-100) */
  overallPercent: number;
  /** Whether autonomous mode is active */
  autonomous: boolean;
  /** Pause / Resume toggle */
  onToggleAutonomous?: (() => void) | undefined;
  className?: string | undefined;
}

const STATUS_CONFIG: Record<
  PhaseItem['status'],
  { icon: React.ReactNode; color: string; bg: string }
> = {
  pending: { icon: <Circle className="w-4 h-4" />, color: 'text-muted-foreground', bg: 'bg-muted' },
  ready: { icon: <Play className="w-4 h-4" />, color: 'text-primary', bg: 'bg-primary/10' },
  running: {
    icon: <Clock className="w-4 h-4 animate-spin" />,
    color: 'text-warning',
    bg: 'bg-warning/10',
  },
  paused: { icon: <Pause className="w-4 h-4" />, color: 'text-warning', bg: 'bg-warning/10' },
  completed: {
    icon: <CheckCircle2 className="w-4 h-4" />,
    color: 'text-success',
    bg: 'bg-success/10',
  },
  failed: {
    icon: <XCircle className="w-4 h-4" />,
    color: 'text-destructive',
    bg: 'bg-destructive/10',
  },
  skipped: {
    icon: <SkipForward className="w-4 h-4" />,
    color: 'text-muted-foreground',
    bg: 'bg-muted',
  },
};

const PRIORITY_DOT: Record<PhaseItem['priority'], string> = {
  critical: 'bg-destructive',
  high: 'bg-destructive',
  medium: 'bg-warning',
  low: 'bg-success',
};

function formatDuration(ms?: number): string {
  if (!ms) return '';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}

/**
 * PhasePanel — Left-side phase list panel.
 *
 * Each phase is shown as a card. The active phase is highlighted.
 * A global progress bar and autonomous mode toggle sit at the top.
 */
export function PhasePanel({
  phases,
  activePhaseId,
  onPhaseClick,
  overallPercent,
  autonomous,
  onToggleAutonomous,
  className,
}: PhasePanelProps): React.ReactElement {
  const { t } = useAppTranslation();
  return (
    <div
      className={cn(
        'flex h-full min-h-0 min-w-0 flex-col border-r border-border/70 bg-[hsl(var(--surface-2)/0.35)]',
        className,
      )}
    >
      {/* Header */}
      <div className="border-b border-border/70 bg-card/70 p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-foreground">{t('activity:phase.heading')}</h2>
          <button
            type="button"
            onClick={onToggleAutonomous}
            className={cn(
              'rounded-md border px-2 py-1 text-xs transition-colors',
              autonomous
                ? 'border-success/25 bg-success/10 text-success'
                : 'border-border/70 bg-muted/60 text-muted-foreground',
            )}
            title={
              autonomous
                ? t('activity:phase.autonomousOnTitle')
                : t('activity:phase.autonomousOffTitle')
            }
          >
            {autonomous ? t('activity:phase.autonomousOn') : t('activity:phase.autonomousOff')}
          </button>
        </div>

        {/* Overall Progress */}
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{t('activity:phase.overallProgress')}</span>
            <span>{overallPercent}%</span>
          </div>
          <div className="h-2 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full rounded-full bg-success transition-all duration-500"
              style={{ width: `${overallPercent}%` }}
            />
          </div>
        </div>
      </div>

      {/* Phase List */}
      <div
        ref={useScrollPosition('phases')}
        className="min-h-0 min-w-0 flex-1 space-y-2 overflow-y-auto overscroll-contain p-3"
      >
        {phases.map((phase) => {
          const status = STATUS_CONFIG[phase.status];
          const isActive = phase.id === activePhaseId;

          return (
            <button
              type="button"
              key={phase.id}
              onClick={() => onPhaseClick?.(phase.id)}
              className={cn(
                'w-full rounded-lg border p-3 text-left shadow-sm transition-all hover:shadow-md',
                isActive
                  ? 'border-warning/35 bg-warning/8 ring-1 ring-warning/20'
                  : 'border-border/70 bg-card/75 hover:bg-accent/50',
              )}
            >
              {/* Phase Header */}
              <div className="flex items-start gap-2">
                <span
                  className={cn('mt-0.5', status.color)}
                  role="img"
                  aria-label={phase.status === 'running' ? t('common:status.running') : undefined}
                >
                  {status.icon}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <div className={cn('w-1.5 h-1.5 rounded-full', PRIORITY_DOT[phase.priority])} />
                    <span className="text-sm font-medium truncate">{phase.name}</span>
                  </div>
                  <p className="text-xs text-muted-foreground truncate mt-0.5">
                    {phase.description}
                  </p>
                </div>
              </div>

              {/* Progress */}
              <div className="mt-2 space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">
                    {t('activity:phase.tasksSuffix', {
                      done: phase.completedTasks,
                      total: phase.taskCount,
                    })}
                  </span>
                  <span className="text-muted-foreground">{phase.progressPercent}%</span>
                </div>
                <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className={cn(
                      'h-full transition-all duration-500 rounded-full',
                      phase.status === 'completed'
                        ? 'bg-success'
                        : phase.status === 'failed'
                          ? 'bg-destructive'
                          : 'bg-warning',
                    )}
                    style={{ width: `${phase.progressPercent}%` }}
                  />
                </div>
              </div>

              {/* Meta */}
              <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
                <span>~{phase.estimateHours}h</span>
                {phase.actualDurationMs && <span>· {formatDuration(phase.actualDurationMs)}</span>}
                {phase.assignedAgents.length > 0 && (
                  <span>
                    · {t('activity:phase.agentsSuffix', { count: phase.assignedAgents.length })}
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
