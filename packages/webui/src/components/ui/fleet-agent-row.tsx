/**
 * FleetAgentRow — shared compact agent row used by FleetMonitor, InspectorPanel,
 * and the redesigned AgentsPanel.
 *
 * Displays a fixed-columns grid with: status LED + name, status label,
 * sparkline + budget warning, iterations, tool calls, cost, context bar,
 * extensions badge, and failure reason. All visual behaviour matches the
 * original FleetMonitor implementation.
 */

import { Crown, Zap } from 'lucide-react';
import { SparklineChart } from '@/components/ui/sparkline';
import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/i18n';
import { fmtCost } from '@/components/dashboard-primitives';
import type { SubagentView } from '@/stores';

const FLEET_ROW_STATUS_META: Record<
  SubagentView['status'],
  { led: string; labelKey: string; pulse: boolean; color: string }
> = {
  running: { led: 'bg-success', labelKey: 'statusRunning', pulse: true, color: 'text-success' },
  completed: { led: 'bg-success', labelKey: 'statusDone', pulse: false, color: 'text-success' },
  failed: { led: 'bg-destructive', labelKey: 'statusFailed', pulse: false, color: 'text-destructive' },
  timeout: { led: 'bg-warning', labelKey: 'statusTimeout', pulse: false, color: 'text-warning' },
  stopped: { led: 'bg-muted-foreground', labelKey: 'statusStopped', pulse: false, color: 'text-muted-foreground' },
};

interface FleetAgentRowProps {
  agent: SubagentView;
  isSelected: boolean;
  isLeader: boolean;
  onClick: () => void;
}

export function FleetAgentRow({ agent, isSelected, isLeader, onClick }: FleetAgentRowProps) {
  const { t } = useAppTranslation();
  const meta = FLEET_ROW_STATUS_META[agent.status];
  const active = agent.status === 'running';
  const ctxPct = Math.min(100, Math.max(0, agent.ctxPct));

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'min-w-[650px] w-full text-left grid grid-cols-[140px_60px_1fr_60px_60px_60px_60px_50px_50px] items-center gap-x-2 px-3 py-1.5 rounded-md text-xs transition-colors',
        isSelected ? 'bg-primary/15 ring-1 ring-primary/40' : 'hover:bg-accent/50',
        active && !isSelected && 'bg-muted/30',
      )}
    >
      {/* Name + leader badge */}
      <div className="flex items-center gap-1 min-w-0">
        <span className={cn('led shrink-0', meta.led, meta.pulse && 'led-pulse')} />
        <span className="truncate font-medium">{agent.name}</span>
        {isLeader && (
          <Crown className="h-3 w-3 shrink-0 text-warning" aria-label={t('activity:fleet.leader')} />
        )}
      </div>

      {/* Status */}
      <span className={cn('text-[10px] tabular-nums', active ? 'text-success' : 'text-muted-foreground')}>
        {t(`activity:fleet.${meta.labelKey}`)}
      </span>

      {/* Sparkline */}
      <div className="flex items-center gap-1 min-w-0">
        <SparklineChart bins={agent.sparklineBins} className="font-mono text-[9px]" />
        {agent.budgetWarning && (
          <span
            title={t('activity:fleet.hittingLimitTitle', {
              kind: agent.budgetWarning.kind,
              used: agent.budgetWarning.used,
              limit: agent.budgetWarning.limit,
            })}
          >
            <Zap
              className="h-3 w-3 shrink-0 text-warning"
              aria-label={t('common:status.budgetWarning')}
            />
          </span>
        )}
      </div>

      {/* Iterations */}
      <span className="tabular-nums text-muted-foreground text-[10px]">
        {agent.iteration}it
      </span>

      {/* Tool calls */}
      <span className="tabular-nums text-muted-foreground text-[10px]">
        {agent.toolCalls}tc
      </span>

      {/* Cost */}
      <span className="tabular-nums font-mono text-[10px]">
        {fmtCost(agent.costUsd)}
      </span>

      {/* Context */}
      <div className="flex flex-col gap-0.5 min-w-0">
        <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
          <div
            className={cn(
              'h-full rounded-full transition-all',
              ctxPct >= 85 ? 'bg-destructive' : ctxPct >= 70 ? 'bg-warning' : 'bg-success',
            )}
            style={{ width: `${ctxPct}%` }}
          />
        </div>
        <span className="text-[9px] tabular-nums text-muted-foreground font-mono leading-none">
          {agent.maxContext > 0 ? `${ctxPct}%` : '\u2014'}
        </span>
      </div>

      {/* Extensions */}
      <span className="tabular-nums text-[10px] text-muted-foreground">
        {agent.extensions > 0 ? `\u26A1\u00D7${agent.extensions}` : '\u2014'}
      </span>

      {/* Failure reason */}
      <span className="text-[9px] text-destructive truncate" title={agent.failureReason}>
        {agent.failureReason ?? ''}
      </span>
    </button>
  );
}
