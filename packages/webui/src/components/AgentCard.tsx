/**
 * AgentCard — shared live-agent detail card used by the inspector drawer.
 *
 * Shows one agent with:
 * - Activity sparkline
 * - Context fill bar with token count
 * - Budget warning indicators
 * - Failure reasons
 * - Streaming output tail (partialText)
 * - Tool execution log
 *
 * The old full-screen `AgentsMonitor` overlay was removed; the fleet list,
 * per-agent navigation and the Sheet shell now live in the global
 * InspectorPanel, which reuses this card for the "Agents" tab.
 */

import { Crown, Cpu, Loader2, Wrench, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { ContextBar } from '@/components/ContextBar';
import { AgentTranscript } from '@/components/AgentTranscript';
import { SparklineChart } from '@/components/ui/sparkline';
import { computeAgentStats } from '@/lib/agent-status';
import { cn } from '@/lib/utils';
import type { SubagentView } from '@/stores';
import { EMPTY_AGENT_TRANSCRIPT, useFleetStore } from '@/stores';

const STATUS_META: Record<SubagentView['status'], { led: string; pulse: boolean; badge: string }> =
  {
    running: {
      led: 'bg-success',
      pulse: true,
      badge: 'bg-success/15 text-success',
    },
    completed: {
      led: 'bg-success',
      pulse: false,
      badge: 'bg-muted text-muted-foreground',
    },
    failed: { led: 'bg-destructive', pulse: false, badge: 'bg-destructive/15 text-destructive' },
    timeout: {
      led: 'bg-warning',
      pulse: false,
      badge: 'bg-warning/15 text-warning',
    },
    stopped: { led: 'bg-muted-foreground', pulse: false, badge: 'bg-muted text-muted-foreground' },
  };

export function AgentCard({ agent, isLeader }: { agent: SubagentView; isLeader: boolean }) {
  const meta = STATUS_META[agent.status];
  const { t } = useAppTranslation();
  const active = agent.status === 'running';
  // Self-ticking clock so elapsed ticks live while running (mirrors
  // AgentRosterCard); terminal agents freeze at their completedAt.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (agent.status !== 'running') return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [agent.status]);
  const stats = computeAgentStats(agent, now);
  const transcript = useFleetStore(
    (s) => s.agentTranscripts.get(agent.id) ?? EMPTY_AGENT_TRANSCRIPT,
  );

  const toolLogSlice = agent.toolLog.slice(0, 8);
  const last8Tools = [...toolLogSlice].reverse();

  return (
    <div
      className={cn(
        'rounded-xl border p-4 space-y-3',
        active ? 'border-primary/20 bg-primary/[0.02]' : 'border-border bg-card',
        isLeader && 'ring-2 ring-warning/30',
      )}
    >
      {/* Card header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <span className={cn('led', meta.led, meta.pulse && 'led-pulse', 'mt-0.5')} />
          <div>
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-semibold">{agent.name}</span>
              {isLeader && (
                <Crown
                  className="h-3.5 w-3.5 text-warning"
                  aria-label={t('activity:fleet.leader')}
                />
              )}
              {agent.extensions > 0 && (
                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-warning/15 text-[10px] text-warning font-medium">
                  <Zap className="h-2.5 w-2.5" />×{agent.extensions}
                </span>
              )}
            </div>
            <span
              className={cn(
                'inline-block mt-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium',
                meta.badge,
              )}
            >
              {t(`activity:fleet.status.${agent.status}`)}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
          {isLeader && (
            <span className="text-[9px] bg-warning/15 text-warning px-1.5 py-0.5 rounded">
              {t('activity:agentsMonitor.leaderBadge')}
            </span>
          )}
        </div>
      </div>

      {/* Task description */}
      {agent.description && (
        <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">
          {agent.description}
        </p>
      )}

      {/* Budget warning */}
      {agent.budgetWarning && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-warning/10 border border-warning/25 text-xs">
          <Zap className="h-3.5 w-3.5 text-warning shrink-0" />
          <span className="text-warning">
            {t('activity:fleet.hittingLimitTitle', {
              kind: agent.budgetWarning.kind,
              used: agent.budgetWarning.used,
              limit: agent.budgetWarning.limit,
            })}
          </span>
        </div>
      )}

      {/* Failure reason */}
      {agent.failureReason && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-destructive/10 border border-destructive/20 text-xs">
          <span className="text-destructive font-medium">✗ {agent.failureReason}</span>
        </div>
      )}

      {/* Stats grid */}
      <div className="grid grid-cols-4 gap-2">
        <div className="rounded-lg border bg-muted/30 px-2 py-1.5 text-center">
          <div className="text-[10px] text-muted-foreground">
            {t('activity:agentsMonitor.iters')}
          </div>
          <div className="text-xs font-mono font-semibold tabular-nums">{agent.iteration}</div>
        </div>
        <div className="rounded-lg border bg-muted/30 px-2 py-1.5 text-center">
          <div className="text-[10px] text-muted-foreground">
            {t('activity:agentsMonitor.tools')}
          </div>
          <div className="text-xs font-mono font-semibold tabular-nums">{agent.toolCalls}</div>
        </div>
        <div className="rounded-lg border bg-muted/30 px-2 py-1.5 text-center">
          <div className="text-[10px] text-muted-foreground">{t('activity:fleet.cost')}</div>
          <div className="text-xs font-mono font-semibold tabular-nums">{stats.cost}</div>
        </div>
        <div className="rounded-lg border bg-muted/30 px-2 py-1.5 text-center">
          <div className="text-[10px] text-muted-foreground">{t('activity:fleet.elapsed')}</div>
          <div className="text-xs font-mono font-semibold tabular-nums">{stats.elapsed}</div>
        </div>
      </div>

      {/* Sparkline + context */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground">
            {t('activity:agentsMonitor.activityBins')}
          </span>
          <SparklineChart bins={agent.sparklineBins} className="font-mono text-[9px]" />
        </div>
        <ContextBar pct={agent.ctxPct} tokens={agent.ctxTokens} maxTokens={agent.maxContext} />
      </div>

      {/* Model / provider */}
      {(agent.provider || agent.model) && (
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <Cpu className="h-3 w-3" />
          <span className="font-mono">
            {agent.provider ?? '?'}/{agent.model ?? '?'}
          </span>
        </div>
      )}

      {/* Current / last tool */}
      {(agent.currentTool || agent.lastTool) && (
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <Wrench className={cn('h-3 w-3', active && 'animate-pulse text-primary')} />
          <span className="font-mono">{agent.currentTool ?? agent.lastTool}</span>
          {active && <Loader2 className="h-3 w-3 animate-spin" />}
        </div>
      )}

      <AgentTranscript
        entries={transcript}
        agentName={agent.name}
        compact
        maxHeightClassName="max-h-80"
      />

      {/* Streaming tail */}
      {agent.partialText && active && (
        <div className="rounded-lg border bg-muted/30 p-2">
          <div className="text-[9px] text-muted-foreground uppercase tracking-wider mb-1">
            {t('activity:agentsMonitor.streamingOutput')}
          </div>
          <pre className="text-[10px] font-mono text-foreground/80 whitespace-pre-wrap line-clamp-3 leading-relaxed">
            {agent.partialText}
          </pre>
        </div>
      )}

      {/* Tool log */}
      {last8Tools.length > 0 && (
        <div className="space-y-1">
          <div className="text-[9px] text-muted-foreground uppercase tracking-wider">
            {t('activity:agentsMonitor.recentTools')}
          </div>
          <div className="space-y-0.5">
            {last8Tools.map((tool) => (
              <div
                key={`${tool.name}-${tool.at}`}
                className="flex items-center gap-2 text-[10px] font-mono"
              >
                <span className={cn('shrink-0', tool.ok ? 'text-success' : 'text-destructive')}>
                  {tool.ok ? '✓' : '✗'}
                </span>
                <span className="text-muted-foreground truncate">{tool.name}</span>
                <span className="ml-auto tabular-nums text-muted-foreground shrink-0">
                  {tool.durationMs >= 1000
                    ? `${(tool.durationMs / 1000).toFixed(1)}s`
                    : `${tool.durationMs}ms`}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Final text (when completed) */}
      {agent.finalText && !active && (
        <div className="rounded-lg border bg-muted/30 p-2">
          <div className="text-[9px] text-muted-foreground uppercase tracking-wider mb-1">
            {t('activity:agentsMonitor.finalOutput')}
          </div>
          <pre className="text-[10px] font-mono text-foreground/80 whitespace-pre-wrap line-clamp-4 leading-relaxed">
            {agent.finalText}
          </pre>
        </div>
      )}
    </div>
  );
}
