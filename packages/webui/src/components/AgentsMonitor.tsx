/**
 * AgentsMonitor — right-side sliding sidebar per-agent monitor.
 *
 * Shows every agent in a card view with:
 * - Activity sparkline
 * - Context fill bar with token count
 * - Budget warning indicators
 * - Failure reasons
 * - Streaming output tail (partialText)
 * - Tool execution log
 *
 * Slides in from the right as a non-intrusive overlay, preserving the
 * main chat interface underneath. Dismisses on Escape / backdrop click.
 *
 * Keyboard: ↑↓ navigate agents, ←→ flip pages per agent, Esc close.
 */

import { Bot, ChevronLeft, ChevronRight, Cpu, Crown, Loader2, Wrench, X, Zap } from 'lucide-react';
import { useAppTranslation } from '@/i18n';
import { ContextBar } from '@/components/ContextBar';
import { AgentTranscript } from '@/components/AgentTranscript';
import { SparklineChart } from '@/components/ui/sparkline';
import { cn } from '@/lib/utils';
import type { SubagentView } from '@/stores';
import { EMPTY_AGENT_TRANSCRIPT, useFleetStore } from '@/stores';
import { Sheet, SheetContent, SheetTitle, SheetDescription } from './ui/sheet';

export interface AgentsMonitorProps {
  onClose: () => void;
}

function fmtCost(v: number): string {
  if (v <= 0) return '$0';
  if (v >= 0.01) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(5)}`.replace(/0+$/, '').replace(/\.$/, '');
}

function _fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return `${min}m ${sec % 60}s`;
}

const STATUS_META: Record<SubagentView['status'], { led: string; pulse: boolean; badge: string }> =
  {
    running: {
      led: 'bg-[hsl(var(--success))]',
      pulse: true,
      badge: 'bg-[hsl(var(--success))]/15 text-[hsl(var(--success))]',
    },
    completed: {
      led: 'bg-[hsl(var(--success))]',
      pulse: false,
      badge: 'bg-muted text-muted-foreground',
    },
    failed: { led: 'bg-destructive', pulse: false, badge: 'bg-destructive/15 text-destructive' },
    timeout: {
      led: 'bg-[hsl(var(--warning))]',
      pulse: false,
      badge: 'bg-amber-500/15 text-amber-500',
    },
    stopped: { led: 'bg-muted-foreground', pulse: false, badge: 'bg-muted text-muted-foreground' },
  };

export function AgentCard({ agent, isLeader }: { agent: SubagentView; isLeader: boolean }) {
  const meta = STATUS_META[agent.status];
  const { t } = useAppTranslation();
  const active = agent.status === 'running';
  const elapsed = Date.now() - agent.startedAt;
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
        isLeader && 'ring-2 ring-amber-500/30',
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
                  className="h-3.5 w-3.5 text-amber-500"
                  aria-label={t('activity:fleet.leader')}
                />
              )}
              {agent.extensions > 0 && (
                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-amber-500/15 text-[10px] text-amber-600 dark:text-amber-400 font-medium">
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
            <span className="text-[9px] bg-amber-500/15 text-amber-600 dark:text-amber-400 px-1.5 py-0.5 rounded">
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
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs">
          <Zap className="h-3.5 w-3.5 text-amber-500 shrink-0" />
          <span className="text-amber-600 dark:text-amber-400">
            {t('activity:fleet.budgetWarning', {
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
          <div className="text-xs font-mono font-semibold tabular-nums">
            {fmtCost(agent.costUsd)}
          </div>
        </div>
        <div className="rounded-lg border bg-muted/30 px-2 py-1.5 text-center">
          <div className="text-[10px] text-muted-foreground">{t('activity:fleet.elapsed')}</div>
          <div className="text-xs font-mono font-semibold tabular-nums">{fmtDuration(elapsed)}</div>
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
            {last8Tools.map((tool, i) => (
              <div key={i} className="flex items-center gap-2 text-[10px] font-mono">
                <span
                  className={cn(
                    'shrink-0',
                    tool.ok ? 'text-[hsl(var(--success))]' : 'text-destructive',
                  )}
                >
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

export function AgentsMonitor({ onClose }: AgentsMonitorProps) {
  const fleetAgents = useFleetStore((s) => s.agents);
  const { t } = useAppTranslation();
  const leaderId = useFleetStore((s) => s.leaderId);

  const [selectedIdx, setSelectedIdx] = useState(0);

  const fleetList = useMemo(() => {
    const arr = Array.from(fleetAgents.values());
    arr.sort((x, y) => {
      if (x.id === leaderId) return -1;
      if (y.id === leaderId) return 1;
      const xa = x.status === 'running' ? 0 : 1;
      const ya = y.status === 'running' ? 0 : 1;
      if (xa !== ya) return xa - ya;
      return x.startedAt - y.startedAt;
    });
    return arr;
  }, [fleetAgents, leaderId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, fleetList.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
        return;
      }
    },
    [fleetList.length, onClose],
  );

  // Escape-on-close is handled by Radix Dialog (Sheet) now. The ArrowUp/
  // ArrowDown/Enter agent navigation is panel-scoped via onKeyDown below.

  const selectedAgent = fleetList[selectedIdx] ?? null;

  return (
    <Sheet
      open
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <SheetContent
        side="right"
        className="w-[600px] max-w-[90vw] sm:max-w-[90vw] flex flex-col p-0 gap-0"
        onKeyDown={handleKeyDown}
        tabIndex={-1}
      >
        <SheetTitle className="sr-only">{t('activity:agentsMonitor.heading')}</SheetTitle>
        <SheetDescription className="sr-only">
          {t('activity:agentsMonitor.heading')}
        </SheetDescription>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b bg-card/80 backdrop-blur shrink-0">
          <div className="flex items-center gap-3">
            <Bot className="h-5 w-5 text-primary" />
            <h2 className="text-sm font-semibold">{t('activity:agentsMonitor.heading')}</h2>
            <span className="text-xs text-muted-foreground">
              {t('activity:agents.totalCount', { count: fleetList.length })}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSelectedIdx((i) => Math.max(i - 1, 0))}
              className="p-1.5 rounded-md hover:bg-muted transition-colors disabled:opacity-30"
              disabled={selectedIdx === 0}
              aria-label={t('activity:agentsMonitor.prevAgent')}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-xs tabular-nums text-muted-foreground font-mono">
              {fleetList.length > 0 ? `${selectedIdx + 1}/${fleetList.length}` : '0/0'}
            </span>
            <button
              type="button"
              onClick={() => setSelectedIdx((i) => Math.min(i + 1, fleetList.length - 1))}
              className="p-1.5 rounded-md hover:bg-muted transition-colors disabled:opacity-30"
              disabled={selectedIdx >= fleetList.length - 1}
              aria-label={t('activity:agentsMonitor.nextAgent')}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-md hover:bg-muted transition-colors ml-2"
              aria-label={t('activity:agentsMonitor.closeAria')}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Main content */}
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4">
          {fleetList.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
              <Bot className="h-12 w-12 mb-3 opacity-20" />
              <p className="text-sm font-medium">{t('activity:inspector.noAgentsActive')}</p>
            </div>
          ) : selectedAgent ? (
            <div className="max-w-2xl mx-auto">
              <AgentCard agent={selectedAgent} isLeader={selectedAgent.id === leaderId} />
            </div>
          ) : null}
        </div>

        {/* Agent selector strip */}
        {fleetList.length > 0 && (
          <div className="border-t bg-card/80 backdrop-blur shrink-0">
            <div className="px-4 py-2 flex items-center gap-2 overflow-x-auto">
              {fleetList.map((agent, i) => (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => setSelectedIdx(i)}
                  className={cn(
                    'shrink-0 flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] transition-colors',
                    i === selectedIdx
                      ? 'bg-primary/15 text-primary ring-1 ring-primary/40'
                      : 'hover:bg-accent text-muted-foreground',
                  )}
                >
                  <span
                    className={cn(
                      'led',
                      STATUS_META[agent.status].led,
                      STATUS_META[agent.status].pulse && 'led-pulse',
                      'shrink-0',
                    )}
                  />
                  <span>{agent.name}</span>
                  {agent.id === leaderId && (
                    <Crown className="h-2.5 w-2.5 text-amber-500 shrink-0" />
                  )}
                </button>
              ))}
            </div>
            <div className="px-4 py-1.5 border-t text-[10px] text-muted-foreground flex items-center gap-4">
              <span>{t('activity:agentsMonitor.hintPage')}</span>
              <span>{t('activity:agentsMonitor.hintNavigate')}</span>
              <span>{t('activity:agentsMonitor.hintEsc')}</span>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
