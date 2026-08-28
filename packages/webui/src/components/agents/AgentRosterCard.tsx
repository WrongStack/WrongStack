/**
 * AgentRosterCard — compact card for an agent in the fleet roster.
 *
 * Shows in a condensed card layout:
 * - Status LED + name + leader crown
 * - Model/provider badge
 * - Iterations + tool calls + cost
 * - Activity sparkline
 * - Context fill bar with percentage
 * - Current/last tool name
 * - Budget warning badge
 *
 * Uses computeAgentStats for all formatted display values.
 */

import { ChevronDown, Crown, Wrench, Zap } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import type { SubagentView } from '@/stores';
import { computeAgentStats } from '@/lib/agent-status';
import { SparklineChart } from '@/components/ui/sparkline';
import { ContextFillBar } from '@/components/ContextBar';
import { AgentDetailSection } from '@/components/agents/AgentDetailSection';

interface AgentRosterCardProps {
  agent: SubagentView;
  isLeader?: boolean | undefined;
  isExpanded?: boolean | undefined;
  isFocused?: boolean | undefined;
  onToggle?: () => void | undefined;
  /** Opens the fleet inspector for this agent. */
  onOpenInspector?: () => void | undefined;
  /** Timestamp for computing live elapsed time (pass useFleetPolling().now). */
  now?: number | undefined;
}

const STATUS_LED: Record<SubagentView['status'], { led: string; pulse: boolean }> = {
  running: { led: 'bg-success', pulse: true },
  completed: { led: 'bg-success', pulse: false },
  failed: { led: 'bg-destructive', pulse: false },
  timeout: { led: 'bg-warning', pulse: false },
  stopped: { led: 'bg-muted-foreground', pulse: false },
};

export function AgentRosterCard({ agent, isLeader, isExpanded, isFocused, onToggle, onOpenInspector, now: externalNow }: AgentRosterCardProps) {
  const { t } = useAppTranslation();
  // Self-ticking clock for live elapsed (only when running and no external now).
  const [localNow, setLocalNow] = useState(Date.now());
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (externalNow !== undefined || agent.status !== 'running') {
      if (tickRef.current) clearInterval(tickRef.current);
      tickRef.current = null;
      return;
    }
    tickRef.current = setInterval(() => setLocalNow(Date.now()), 10_000);
    return () => { if (tickRef.current) clearInterval(tickRef.current); };
  }, [externalNow, agent.status]);

  const now = externalNow ?? localNow;
  const stats = useMemo(() => computeAgentStats(agent, now), [agent, now]);
  const meta = STATUS_LED[agent.status];
  const active = agent.status === 'running';
  const hasTool = agent.currentTool || agent.lastTool;

  return (
    <div className={cn('animate-message', isExpanded && 'rounded-lg ring-1 ring-primary/20')}>
      {/* Card header (clickable toggle) */}
      <button
        type="button"
        id={`agent-card-${agent.id}`}
        data-agent-card
        role="option"
        aria-selected={isExpanded}
        onClick={onToggle}
        className={cn(
          'w-full text-left rounded-lg border px-3 py-2.5 transition-colors space-y-2',
          !isExpanded && 'rounded-b-lg',
          isExpanded && 'rounded-b-none border-b-0',
          // Per-status border tint
          active && 'border-primary/40 bg-primary/[0.03]',
          !active && agent.status === 'completed' && 'border-success/30 bg-success/[0.02]',
          !active && agent.status === 'failed' && 'border-destructive/30 bg-destructive/[0.02]',
          !active && agent.status === 'timeout' && 'border-warning/30 bg-warning/[0.02]',
          !active && agent.status === 'stopped' && 'border-border/60 bg-card/40',
          // Hover + selected states
          'hover:border-primary/40 hover:bg-primary/[0.04]',
          isLeader && 'ring-1 ring-warning/30',
          isFocused && 'ring-2 ring-primary',
        )}
      >
        {/* Row 1: LED + name + leader badge + cost + expand icon */}
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={cn('led shrink-0', meta.led, meta.pulse && 'led-pulse')} aria-hidden="true" />
          <span className="truncate text-[11px] font-semibold" title={agent.name}>
            {agent.name}
          </span>
          {isLeader && (
            <Crown className="h-3 w-3 shrink-0 text-warning" aria-label={t('activity:fleet.leader')} />
          )}
          <span className="flex-1 min-w-0" />
          <span className="tabular-nums font-mono text-[10px] text-muted-foreground shrink-0">
            {stats.cost}
          </span>
          <ChevronDown
            className={cn(
              'h-3 w-3 shrink-0 text-muted-foreground/50 transition-transform duration-200',
              isExpanded && 'rotate-180',
            )}
          />
        </div>

        {/* Row 2: Model badge + iteration/tool counts + elapsed time */}
        <div className="flex items-center gap-1.5 min-w-0">
          {agent.model ? (
            <span className="truncate rounded bg-muted/60 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground max-w-[10rem]">
              {agent.model}
            </span>
          ) : (
            <span className="text-[10px] text-muted-foreground italic">
              {t('activity:agents.pending')}
            </span>
          )}
          <span className="tabular-nums text-[10px] text-muted-foreground">
            {stats.iterationCount}{t('activity:agents.itSuffix')} · {stats.toolCount}{t('activity:agents.tcSuffix')}
          </span>
          <span className="ml-auto tabular-nums text-[10px] text-muted-foreground/70 shrink-0">
            {stats.elapsed}
          </span>
        </div>

      {/* Row 3: Sparkline + context bar */}
      <div className="flex items-center gap-2 min-w-0">
        <SparklineChart bins={agent.sparklineBins} className="text-[9px] font-mono min-w-0" />

        <div className="flex-1 min-w-0">
          <ContextFillBar
            pct={stats.ctxClamped}
            tokens={agent.ctxTokens}
            maxTokens={agent.maxContext}
            showTokens
          />
        </div>

        {/* Budget warning badge */}
        {agent.budgetWarning && (
          <span
            className="inline-flex items-center gap-0.5 rounded bg-warning/10 px-1.5 py-0.5 text-[10px] text-warning shrink-0"
            title={t('activity:fleet.hittingLimitTitle', {
              kind: agent.budgetWarning.kind,
              used: agent.budgetWarning.used,
              limit: agent.budgetWarning.limit,
            })}
          >
            <Zap className="h-2.5 w-2.5" />
            {agent.budgetWarning.kind}
          </span>
        )}
      </div>

      {/* Row 4: Current/last tool */}
      {hasTool && (
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground min-w-0">
          <Wrench className={cn('h-2.5 w-2.5 shrink-0', active && 'animate-pulse text-primary')} />
          <span className="truncate font-mono">{agent.currentTool ?? agent.lastTool}</span>
        </div>
      )}
      </button>

      {/* Expandable detail section */}
      <AgentDetailSection
        agent={agent}
        isExpanded={!!isExpanded}
        onOpenInspector={onOpenInspector}
      />
    </div>
  );
}
