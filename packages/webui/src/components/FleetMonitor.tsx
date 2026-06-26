/**
 * FleetMonitor — right-side sliding sidebar fleet dashboard.
 *
 * Slides in from the right as a non-intrusive overlay panel, preserving
 * the main chat interface underneath. Dismisses on Escape / backdrop click.
 *
 * Displays:
 * - Fleet header with concurrency gauge and fleet-wide stats
 * - Fleet-wide token aggregation + cost totals
 * - Per-agent detailed view with sparklines, budget warnings, failure reasons
 * - Event timeline (last 20 events)
 * - Keyboard navigation hints
 */

import {
  Activity,
  ArrowRight,
  Bot,
  ChevronRight,
  Clock,
  Cpu,
  Crown,
  Database,
  DollarSign,
  FolderOpen,
  Loader2,
  Timer,
  Users,
  Wrench,
  XCircle,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ConcurrencyGauge, EventTimeline } from '@/components/ui';
import { SparklineChart } from '@/components/ui/sparkline';
import { cn } from '@/lib/utils';
import { compareAgentsByActivity, tallyAgents } from '@/lib/agent-status';
import type { SubagentView } from '@/stores';
import { useFleetStore } from '@/stores';

export interface FleetMonitorProps {
  onClose: () => void;
  /** Optional: open agent detail for a specific agent */
  onSelectAgent?: (agent: SubagentView) => void;
}

import { fmtCost, fmtTok, fmtElapsed } from './dashboard-primitives.js';

const STATUS_META: Record<SubagentView['status'], { led: string; label: string; pulse: boolean; color: string }> = {
  running: { led: 'bg-emerald-500', label: 'running', pulse: true, color: 'text-emerald-500' },
  completed: { led: 'bg-emerald-500', label: 'done', pulse: false, color: 'text-emerald-500' },
  failed: { led: 'bg-destructive', label: 'failed', pulse: false, color: 'text-destructive' },
  timeout: { led: 'bg-amber-500', label: 'timeout', pulse: false, color: 'text-amber-500' },
  stopped: { led: 'bg-muted-foreground', label: 'stopped', pulse: false, color: 'text-muted-foreground' },
};

// ── Agent Detail Panel ─────────────────────────────────────────────────

function FleetAgentDetailPanel({
  agent,
  now,
}: {
  agent: SubagentView;
  now: number;
}): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const [showFullToolLog, setShowFullToolLog] = useState(false);
  const meta = STATUS_META[agent.status];
  const active = agent.status === 'running';
  const ctxPct = Math.min(100, Math.max(0, agent.ctxPct));

  const handleCopy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  }, []);

  // Calculate tool stats
  const totalToolDuration = agent.toolLog.reduce((sum, t) => sum + t.durationMs, 0);
  const avgToolDuration = agent.toolLog.length > 0 ? Math.round(totalToolDuration / agent.toolLog.length) : 0;
  const uniqueTools = useMemo(() => {
    const tools = new Set<string>();
    for (const t of agent.toolLog) tools.add(t.name);
    return tools.size;
  }, [agent.toolLog]);

  // Get output text
  const outputText = agent.partialText || agent.finalText || undefined;
  const isStream = !agent.finalText && !!agent.partialText;

  return (
    <div className="h-full flex flex-col">
      {/* Fixed header */}
      <div className="shrink-0 border-b bg-card p-4 space-y-3">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-primary/10">
              <Bot className="h-5 w-5 text-primary" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-base font-semibold">{agent.name}</span>
                <span className={cn(
                  'px-2 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider',
                  agent.status === 'running'
                    ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                    : agent.status === 'failed' || agent.status === 'timeout'
                      ? 'bg-destructive/15 text-destructive'
                      : 'bg-muted text-muted-foreground'
                )}>
                  {meta.label}
                </span>
              </div>
              <span className="text-[10px] text-muted-foreground font-mono">
                session: {agent.sessionId?.slice(0, 12)}…
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            {active && (
              <span className="flex items-center gap-1.5">
                <Timer className="h-3.5 w-3.5" />
                <span className="tabular-nums font-mono">{fmtElapsed(Math.max(0, now - agent.startedAt))}</span>
              </span>
            )}
            <span className={cn('led', meta.led, active && 'led-pulse')} />
          </div>
        </div>

        {/* Activity sparkline */}
        <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-muted/30">
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Activity</span>
          <SparklineChart bins={agent.sparklineBins} className="font-mono text-[9px]" />
          {agent.budgetWarning && (
            <span className="ml-auto flex items-center gap-1 text-[10px] text-amber-500">
              <Zap className="h-3 w-3" />
              budget warning
            </span>
          )}
        </div>

        {/* Task description */}
        {agent.description && (
          <div className="px-3 py-2 rounded-lg bg-muted/20 border border-border/50">
            <span className="text-[9px] text-muted-foreground uppercase tracking-wider">Current Task</span>
            <p className="text-xs mt-1 text-foreground/80">{agent.description}</p>
          </div>
        )}
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Stats grid */}
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg border bg-card p-3">
            <div className="flex items-center gap-2 text-[9px] text-muted-foreground uppercase tracking-wider mb-2">
              <Cpu className="h-3 w-3" /> Provider / Model
            </div>
            <div className="text-sm font-mono font-medium">
              {agent.provider ?? '?'}/{agent.model ?? '?'}
            </div>
          </div>
          <div className="rounded-lg border bg-card p-3">
            <div className="flex items-center gap-2 text-[9px] text-muted-foreground uppercase tracking-wider mb-2">
              <Activity className="h-3 w-3" /> Performance
            </div>
            <div className="space-y-1">
              <div className="flex justify-between text-[11px]">
                <span className="text-muted-foreground">Iterations</span>
                <span className="font-mono font-medium">{agent.iteration}</span>
              </div>
              <div className="flex justify-between text-[11px]">
                <span className="text-muted-foreground">Tool Calls</span>
                <span className="font-mono font-medium">{agent.toolCalls}</span>
              </div>
              <div className="flex justify-between text-[11px]">
                <span className="text-muted-foreground">Unique Tools</span>
                <span className="font-mono font-medium">{uniqueTools}</span>
              </div>
            </div>
          </div>
          <div className="rounded-lg border bg-card p-3">
            <div className="flex items-center gap-2 text-[9px] text-muted-foreground uppercase tracking-wider mb-2">
              <DollarSign className="h-3 w-3" /> Cost
            </div>
            <div className="text-lg font-mono font-bold text-emerald-500">
              {fmtCost(agent.costUsd)}
            </div>
            <div className="text-[10px] text-muted-foreground mt-1">
              avg {avgToolDuration}ms per tool
            </div>
          </div>
          <div className="rounded-lg border bg-card p-3">
            <div className="flex items-center gap-2 text-[9px] text-muted-foreground uppercase tracking-wider mb-2">
              <Database className="h-3 w-3" /> Context
            </div>
            <div className="space-y-2">
              <div className="flex justify-between text-[11px]">
                <span className="text-muted-foreground">Tokens</span>
                <span className="font-mono font-medium">{fmtTok(agent.ctxTokens)}</span>
              </div>
              <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className={cn(
                    'h-full rounded-full transition-all',
                    ctxPct >= 85
                      ? 'bg-destructive'
                      : ctxPct >= 70
                        ? 'bg-amber-500'
                        : 'bg-emerald-500',
                  )}
                  style={{ width: `${ctxPct}%` }}
                />
              </div>
              <span className="text-[10px] text-muted-foreground tabular-nums font-mono">
                {ctxPct}% used
              </span>
            </div>
          </div>
        </div>

        {/* Current tool */}
        {agent.currentTool && (
          <div className={cn(
            'rounded-lg border px-4 py-3 flex items-center gap-3',
            active ? 'border-primary/30 bg-primary/[0.04]' : 'border-border bg-muted/30'
          )}>
            <Wrench className={cn('h-4 w-4', active ? 'text-primary animate-pulse' : 'text-muted-foreground')} />
            <span className="text-sm font-mono font-medium">{agent.currentTool}</span>
            {active ? (
              <span className="ml-auto flex items-center gap-1.5 text-[10px] text-primary">
                <Loader2 className="h-3 w-3 animate-spin" /> running…
              </span>
            ) : (
              <span className="ml-auto text-[10px] text-muted-foreground">completed</span>
            )}
          </div>
        )}

        {/* Streaming/Final output */}
        {outputText ? (
          <div className="rounded-lg border bg-card">
            <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/30">
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                {isStream ? (
                  <>
                    <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                    Live Output
                  </>
                ) : (
                  <>
                    <FolderOpen className="h-3 w-3" />
                    Final Output
                  </>
                )}
              </span>
              <button
                type="button"
                onClick={() => handleCopy(outputText)}
                className="flex items-center gap-1 px-2 py-1 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                {copied ? '✓ Copied' : 'Copy'}
              </button>
            </div>
            <pre className="p-4 text-xs whitespace-pre-wrap font-mono text-foreground/80 leading-relaxed max-h-64 overflow-y-auto">
              {outputText}
            </pre>
          </div>
        ) : active ? (
          <div className="rounded-lg border border-dashed border-border p-6 text-center">
            <Loader2 className="h-6 w-6 mx-auto mb-2 text-muted-foreground/50 animate-spin" />
            <span className="text-xs text-muted-foreground">Waiting for output…</span>
          </div>
        ) : null}

        {/* Budget warning */}
        {agent.budgetWarning && (
          <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
            <Zap className="h-5 w-5 text-amber-500 shrink-0" />
            <div>
              <span className="text-sm font-medium text-amber-600 dark:text-amber-400">
                ⚡ Budget Warning
              </span>
              <p className="text-[11px] text-amber-600/80 dark:text-amber-400/80 mt-0.5">
                Hitting {agent.budgetWarning.kind} limit ({agent.budgetWarning.used}/{agent.budgetWarning.limit})
              </p>
            </div>
          </div>
        )}

        {/* Extensions */}
        {agent.extensions > 0 && (
          <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
            <Zap className="h-5 w-5 text-amber-500 shrink-0" />
            <div>
              <span className="text-sm font-medium">
                {agent.extensions} Budget Extension{agent.extensions === 1 ? '' : 's'}
              </span>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Agent extended its budget {agent.extensions} time{agent.extensions === 1 ? '' : 's'} due to long-running tasks
              </p>
            </div>
          </div>
        )}

        {/* Error */}
        {agent.error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
            <div className="flex items-center gap-2 mb-2">
              <XCircle className="h-4 w-4 text-destructive" />
              <span className="text-[10px] font-semibold text-destructive uppercase tracking-wider">Error</span>
            </div>
            <p className="text-sm text-destructive/90">{agent.error.message}</p>
          </div>
        )}

        {/* Failure reason */}
        {agent.failureReason && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
            <div className="flex items-center gap-2 mb-2">
              <XCircle className="h-4 w-4 text-destructive" />
              <span className="text-[10px] font-semibold text-destructive uppercase tracking-wider">Failure Reason</span>
            </div>
            <p className="text-sm text-destructive/90">{agent.failureReason}</p>
          </div>
        )}

        {/* Tool Log */}
        {agent.toolLog.length > 0 && (
          <div className="rounded-lg border bg-card">
            <button
              type="button"
              onClick={() => setShowFullToolLog(!showFullToolLog)}
              className="w-full flex items-center justify-between px-4 py-2 border-b bg-muted/30 hover:bg-muted/50 transition-colors"
            >
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                <Wrench className="h-3 w-3" />
                Tool Log ({agent.toolLog.length} calls)
              </span>
              <ChevronRight className={cn('h-4 w-4 text-muted-foreground transition-transform', showFullToolLog && 'rotate-90')} />
            </button>
            <div className={cn('overflow-hidden transition-all', showFullToolLog ? 'max-h-[500px]' : 'max-h-48')}>
              <div className="p-2 space-y-0.5">
                {agent.toolLog.map((tl, i) => (
                  <div
                    key={`${tl.name}-${tl.at}-${i}`}
                    className={cn(
                      'flex items-center gap-3 rounded px-3 py-2 text-[11px]',
                      tl.ok ? 'bg-muted/30 hover:bg-muted/50' : 'bg-destructive/5 border border-destructive/20',
                    )}
                  >
                    <span className={cn('led shrink-0', tl.ok ? 'bg-emerald-500' : 'bg-destructive')} />
                    <span className={cn('font-mono font-medium w-20 shrink-0', tl.ok ? 'text-foreground' : 'text-destructive')}>
                      {tl.name}
                    </span>
                    <span className="text-muted-foreground tabular-nums text-[10px]">
                      {tl.durationMs >= 1000 ? `${(tl.durationMs / 1000).toFixed(2)}s` : `${tl.durationMs}ms`}
                    </span>
                    {!tl.ok && (
                      <span className="ml-auto text-[10px] text-destructive font-medium">Failed</span>
                    )}
                    <span className="ml-auto text-[9px] text-muted-foreground tabular-nums">
                      {new Date(tl.at).toLocaleTimeString()}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Agent Row ─────────────────────────────────────────────────────────

export function FleetAgentRow({
  agent,
  isSelected,
  isLeader,
  onClick,
}: {
  agent: SubagentView;
  isSelected: boolean;
  isLeader: boolean;
  onClick: () => void;
}) {
  const meta = STATUS_META[agent.status];
  const active = agent.status === 'running';
  const ctxPct = Math.min(100, Math.max(0, agent.ctxPct));

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full text-left grid grid-cols-[140px_60px_1fr_60px_60px_60px_60px_50px_50px] items-center gap-x-2 px-3 py-1.5 rounded-md text-xs transition-colors',
        isSelected ? 'bg-primary/15 ring-1 ring-primary/40' : 'hover:bg-accent/50',
        active && !isSelected && 'bg-muted/30',
      )}
    >
      {/* Name + leader badge */}
      <div className="flex items-center gap-1 min-w-0">
        <span className={cn('led shrink-0', meta.led, meta.pulse && 'led-pulse')} />
        <span className="truncate font-medium">{agent.name}</span>
        {isLeader && (
          <Crown className="h-3 w-3 shrink-0 text-amber-500" aria-label="leader" />
        )}
      </div>

      {/* Status */}
      <span className={cn('text-[10px] tabular-nums', active ? 'text-emerald-500' : 'text-muted-foreground')}>
        {meta.label}
      </span>

      {/* Sparkline */}
      <div className="flex items-center gap-1 min-w-0">
        <SparklineChart bins={agent.sparklineBins} className="font-mono text-[9px]" />
        {agent.budgetWarning && (
          <span title={`⚡ hitting ${agent.budgetWarning.kind} limit (${agent.budgetWarning.used}/${agent.budgetWarning.limit})`}>
            <Zap className="h-3 w-3 shrink-0 text-amber-500" aria-label="budget warning" />
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
              ctxPct >= 85
                ? 'bg-destructive'
                : ctxPct >= 70
                  ? 'bg-amber-500'
                  : 'bg-emerald-500',
            )}
            style={{ width: `${ctxPct}%` }}
          />
        </div>
        <span className="text-[9px] tabular-nums text-muted-foreground font-mono leading-none">
          {agent.maxContext > 0 ? `${ctxPct}%` : '—'}
        </span>
      </div>

      {/* Extensions */}
      <span className="tabular-nums text-[10px] text-muted-foreground">
        {agent.extensions > 0 ? `⚡×${agent.extensions}` : '—'}
      </span>

      {/* Failure reason */}
      <span className="text-[9px] text-destructive truncate" title={agent.failureReason}>
        {agent.failureReason ?? ''}
      </span>
    </button>
  );
}

// ── Main Fleet Monitor / Page ─────────────────────────────────────────

export function FleetMonitor({
  onClose,
  onSelectAgent,
}: FleetMonitorProps) {
  const fleetAgents = useFleetStore((s) => s.agents);
  const leaderId = useFleetStore((s) => s.leaderId);
  const fleetTokensIn = useFleetStore((s) => s.fleetTokensIn);
  const fleetTokensOut = useFleetStore((s) => s.fleetTokensOut);
  const fleetConcurrency = useFleetStore((s) => s.fleetConcurrency);
  const fleetConcurrencyMax = useFleetStore((s) => s.fleetConcurrencyMax);
  const eventTimeline = useFleetStore((s) => s.eventTimeline);
  const fleetAgentTimeline = useFleetStore((s) => s.agentTimeline);

  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState(Date.now());

  // Live clock
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const fleetList = useMemo(() => {
    const arr = Array.from(fleetAgents.values());
    arr.sort((x, y) => {
      // Leader first
      if (x.id === leaderId) return -1;
      if (y.id === leaderId) return 1;
      return compareAgentsByActivity(x, y);
    });
    return arr;
  }, [fleetAgents, leaderId]);

  const totalCost = useMemo(
    () => Array.from(fleetAgents.values()).reduce((sum, a) => sum + a.costUsd, 0),
    [fleetAgents],
  );

  const runningCount = tallyAgents(fleetList).running;
  const selectedAgent = selectedIdx !== null ? fleetList[selectedIdx] : null;

  const handleAgentClick = useCallback(
    (i: number) => setSelectedIdx((prev) => (prev === i ? null : i)),
    [],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (selectedIdx !== null) {
          setSelectedIdx(null);
        } else if (onClose) {
          onClose();
        }
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx((i) => Math.min((i ?? -1) + 1, fleetList.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx((i) => Math.max((i ?? 0) - 1, 0));
        return;
      }
      if (e.key === 'Enter' && fleetList[selectedIdx ?? 0]) {
        onSelectAgent?.(fleetList[selectedIdx ?? 0]);
      }
    },
    [fleetList, selectedIdx, onClose, onSelectAgent],
  );

  useEffect(() => {
    const handleGlobal = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleGlobal);
    return () => window.removeEventListener('keydown', handleGlobal);
  }, [onClose]);

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/10 backdrop-blur-[1px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className="fixed right-0 top-0 h-full z-50 w-[720px] max-w-[95vw] flex flex-col bg-background border-l shadow-2xl animate-slide-in-right"
        onKeyDown={handleKeyDown}
        tabIndex={-1}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b bg-card/80 backdrop-blur shrink-0">
          <div className="flex items-center gap-3">
            <Bot className="h-5 w-5 text-primary" />
            <h2 className="text-sm font-semibold flex items-center gap-2">
              FLEET MONITOR
              {runningCount > 0 && (
                <span className="flex items-center gap-1 text-[11px] text-emerald-500 font-normal">
                  <span className="led led-pulse bg-emerald-500" />
                  {runningCount} running
                </span>
              )}
            </h2>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>
                {fleetList.length} total agents
              </span>
              <ConcurrencyGauge
                current={fleetConcurrency}
                max={fleetConcurrencyMax}
                showLabel
              />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground tabular-nums font-mono">
              ↓{fmtTok(fleetTokensIn)} ↑{fmtTok(fleetTokensOut)} · {fmtCost(totalCost)}
            </span>
            <span className="text-xs text-muted-foreground tabular-nums font-mono">
              {leaderId
                ? `👑 ${fleetAgents.get(leaderId)?.name ?? leaderId}`
                : 'no leader'}
            </span>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-md hover:bg-muted transition-colors"
              aria-label="Close fleet monitor"
            >
              <XCircle className="h-4 w-4" />
            </button>
          </div>
        </div>

      {/* Main content: two-column layout when agent selected */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Agent table */}
        <div className={cn(
          'flex flex-col border-r transition-all duration-200',
          selectedAgent ? 'w-[500px] shrink-0' : 'w-full'
        )}>
          {/* Column headers */}
          <div className="border-b bg-card/80 px-3 py-2">
            <div className="grid grid-cols-[140px_60px_1fr_60px_60px_60px_60px_50px_50px] gap-x-2 text-[9px] uppercase tracking-wider text-muted-foreground font-medium">
              <span>Name</span>
              <span>Status</span>
              <span>Activity</span>
              <span>Iters</span>
              <span>Tools</span>
              <span>Cost</span>
              <span>CTX</span>
              <span>Ext</span>
              <span>Reason</span>
            </div>
          </div>

          {/* Agent list */}
          <div className="flex-1 overflow-y-auto">
            {fleetList.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                <Users className="h-12 w-12 mb-3 opacity-20" />
                <p className="text-sm font-medium">No agents active</p>
                <p className="text-xs mt-1">Agents appear here when the fleet is active.</p>
              </div>
            ) : (
              <div className="p-2 space-y-0.5">
                {fleetList.map((agent, i) => (
                  <FleetAgentRow
                    key={agent.id}
                    agent={agent}
                    isSelected={i === selectedIdx}
                    isLeader={agent.id === leaderId}
                    onClick={() => handleAgentClick(i)}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Footer: event timeline */}
          <div className="border-t bg-card/80 shrink-0">
            <div className="px-4 py-2 border-b">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium flex items-center gap-2">
                <Clock className="h-3 w-3" />
                Agent Timeline
              </span>
            </div>
            <div className="px-4 py-2 max-h-32 overflow-y-auto">
              <EventTimeline events={eventTimeline} max={10} />
            </div>
            <div className="border-t border-dashed" />
            <div className="px-4 py-2 max-h-40 overflow-y-auto">
              {fleetAgentTimeline.length === 0 ? (
                <p className="text-[10px] text-muted-foreground italic">No agent conversation events yet.</p>
              ) : (
                <div className="space-y-1">
                  {fleetAgentTimeline.slice(0, 15).map((entry) => {
                    const iconMap: Record<string, string> = { text: '\u{1F4AC}', tool_use: '\u{1F527}', error: '\u{274C}', status: '\u{1F4AC}' };
                    const icon = iconMap[entry.kind] ?? '\u{25CF}';
                    const statusColor = entry.status === 'running' || entry.status === 'spawned' ? 'text-emerald-500'
                      : entry.status === 'failed' || entry.status === 'timeout' ? 'text-destructive' : 'text-muted-foreground';
                    return (
                      <div key={entry.id} className="flex items-start gap-1.5 text-[10px] leading-tight">
                        <span className="shrink-0">{icon}</span>
                        <span className="font-medium text-primary shrink-0">{entry.agentName}</span>
                        {entry.status && <span className={`${statusColor} shrink-0`}>{entry.status}</span>}
                        {entry.toolName && <span className="text-muted-foreground shrink-0">[{entry.toolName}]</span>}
                        <span className="text-muted-foreground truncate">{entry.content}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="px-4 py-1.5 border-t text-[10px] text-muted-foreground flex items-center gap-4">
              <span>↑↓ navigate</span>
              <span>↵ select detail</span>
              <span>Esc deselect / close</span>
            </div>
          </div>
        </div>

        {/* Right: Agent detail */}
        {selectedAgent && (
          <div className="flex-1 overflow-hidden bg-card/50">
            <div className="h-full flex flex-col">
              {/* Detail header bar */}
              <div className="shrink-0 px-4 py-2 border-b bg-card/80 flex items-center gap-2">
                <ArrowRight className="h-4 w-4 text-primary" />
                <span className="text-xs font-semibold text-primary">{selectedAgent.name}</span>
                <span className="text-[10px] text-muted-foreground">detailed view</span>
                <button
                  type="button"
                  onClick={() => setSelectedIdx(null)}
                  className="ml-auto text-[10px] text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
                >
                  ✕ close
                </button>
              </div>
              {/* Detail content */}
              <div className="flex-1 overflow-hidden">
                <FleetAgentDetailPanel agent={selectedAgent} now={nowTick} />
              </div>
            </div>
          </div>
        )}

        {/* Empty state when nothing selected */}
        {!selectedAgent && fleetList.length > 0 && (
          <div className="flex-1 flex items-center justify-center bg-muted/20">
            <div className="text-center space-y-3 max-w-sm">
              <Users className="h-12 w-12 text-muted-foreground/30 mx-auto" />
              <p className="text-sm text-muted-foreground">
                Select an agent to view detailed information
              </p>
              <p className="text-xs text-muted-foreground/60">
                Click on any agent in the list to see detailed metrics, tool logs,
                streaming output, and more — similar to the chat history detailed view.
              </p>
              <div className="flex items-center justify-center gap-4 pt-2">
                <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <kbd className="px-1.5 py-0.5 rounded bg-muted border text-[9px]">↑</kbd>
                  <kbd className="px-1.5 py-0.5 rounded bg-muted border text-[9px]">↓</kbd>
                  <span>navigate</span>
                </div>
                <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <kbd className="px-1.5 py-0.5 rounded bg-muted border text-[9px]">Enter</kbd>
                  <span>select</span>
                </div>
                <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <kbd className="px-1.5 py-0.5 rounded bg-muted border text-[9px]">Esc</kbd>
                  <span>deselect</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
      </div>
    </>
  );
}
