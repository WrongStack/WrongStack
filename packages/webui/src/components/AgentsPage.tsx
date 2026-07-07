import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/i18n';
import { EMPTY_AGENT_TRANSCRIPT, useChatStore, useConfigStore, useFleetStore, useSessionStore } from '@/stores';
import type { SubagentView } from '@/stores';
import {
  Activity,
  ArrowRight,
  Bot,
  CheckCircle2,
  ChevronRight,
  Clock,
  Cpu,
  Copy,
  Database,
  DollarSign,
  FolderOpen,
  Loader2,
  Timer,
  Wrench,
  XCircle,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ContextFillBar } from './ContextBar';
import { ContextBreakdownModal } from './ContextBreakdownModal';
import { AgentTranscript } from './AgentTranscript';
import { fmtTok } from './ChatView/utils';
import { bucketActivity, fmtCost, fmtDuration, fmtElapsed, sparkline } from './AgentsPage/format';

// Pure formatters live in ./AgentsPage/format. Re-exported here so existing
// imports from '../AgentsPage' keep resolving.
export { bucketActivity, fmtCost, fmtDuration, fmtElapsed, sparkline };

function shortSessionId(sessionId: string): string {
  const leaf = sessionId.split('/').pop() ?? sessionId;
  return leaf.length > 12 ? `${leaf.slice(0, 12)}…` : leaf;
}

const STATUS_META: Record<string, { icon: React.ReactNode; color: string; labelKey: string; ns: 'fleet' | 'agents' }> = {
  running: {
    icon: <span className="led text-[hsl(var(--success))] led-pulse" />,
    color: 'text-[hsl(var(--success))]',
    labelKey: 'statusRunning',
    ns: 'fleet',
  },
  idle: {
    icon: <span className="led text-muted-foreground" />,
    color: 'text-muted-foreground',
    labelKey: 'statusIdle',
    ns: 'agents',
  },
  completed: {
    icon: <CheckCircle2 className="h-3.5 w-3.5" />,
    color: 'text-[hsl(var(--success))]',
    labelKey: 'statusDone',
    ns: 'fleet',
  },
  failed: {
    icon: <XCircle className="h-3.5 w-3.5" />,
    color: 'text-destructive',
    labelKey: 'statusFailed',
    ns: 'fleet',
  },
  timeout: {
    icon: <Clock className="h-3.5 w-3.5" />,
    color: 'text-[hsl(var(--warning))]',
    labelKey: 'statusTimeout',
    ns: 'fleet',
  },
  stopped: {
    icon: <span className="led text-muted-foreground" />,
    color: 'text-muted-foreground',
    labelKey: 'statusStopped',
    ns: 'fleet',
  },
};

// ── Leader entry (Agent #0) synthesised from session data ──────────────

interface LeaderEntry {
  id: 'leader';
  name: string;
  /** Session this leader belongs to. */
  sessionId?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  status: 'running' | 'idle';
  iterations: number;
  toolCalls: number;
  costUsd: number;
  ctxPct: number;
  ctxTokens: number;
  maxContext: number;
  startedAt: number;
  lastEventAt: number;
  extensions: number;
  currentTool?: string | undefined;
  toolLog: SubagentView['toolLog'];
  partialText?: string | undefined;
  finalText?: string | undefined;
  error?: { kind: string | undefined; message: string } | undefined;
  /** Human-readable description of the current task. */
  description?: string | undefined;
  /** Budget warning if hitting a soft limit. */
  budgetWarning?: { kind: string; used: number; limit: number } | undefined;
  /** Per-agent token usage. */
  tokensIn?: number | undefined;
  tokensOut?: number | undefined;
  /** Sparkline bins for activity visualization. */
  sparklineBins?: number[];
}

type AgentView = SubagentView | LeaderEntry;

function statusLabel(status: string, t: (key: string) => string): string {
  const m = STATUS_META[status];
  return m ? t(`activity:${m.ns}.${m.labelKey}`) : status;
}

// ── Agent Detail ──────────────────────────────────────────────────────

function AgentDetailPanel({
  agent,
  now,
}: {
  agent: AgentView;
  now: number;
}): React.ReactElement {
  const { t } = useAppTranslation();
  const [copied, setCopied] = useState(false);
  const [showFullToolLog, setShowFullToolLog] = useState(false);
  const handleCopy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  }, []);

  const active = agent.status === 'running';
  const tool = agent.currentTool;
  const lastTool = agent.toolLog[0];
  const transcript = useFleetStore((s) => s.agentTranscripts.get(agent.id) ?? EMPTY_AGENT_TRANSCRIPT);
  const toolTimestamps = agent.toolLog.map((t) => t.at);
  const spark = sparkline(bucketActivity(toolTimestamps, now));
  const ctxPct = Math.min(100, Math.max(0, agent.ctxPct));

  // Build streaming / final text
  const outputText = agent.partialText || agent.finalText || undefined;
  const isStream = !agent.finalText && !!agent.partialText;

  // Calculate total tool duration
  const totalToolDuration = agent.toolLog.reduce((sum, t) => sum + t.durationMs, 0);
  const avgToolDuration = agent.toolLog.length > 0 ? Math.round(totalToolDuration / agent.toolLog.length) : 0;

  // Get unique tools used
  const uniqueTools = useMemo(() => {
    const tools = new Set<string>();
    for (const t of agent.toolLog) tools.add(t.name);
    return tools.size;
  }, [agent.toolLog]);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
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
                  STATUS_META[agent.status]?.color === 'text-[hsl(var(--success))]'
                    ? 'bg-success/12 text-success'
                    : STATUS_META[agent.status]?.color === 'text-destructive'
                      ? 'bg-destructive/15 text-destructive'
                      : 'bg-muted text-muted-foreground'
                )}>
                  {statusLabel(agent.status, t)}
                </span>
              </div>
              {'sessionId' in agent && agent.sessionId && (
                <span className="text-[10px] text-muted-foreground font-mono">
                  {t('activity:fleet.sessionPrefix')} {agent.sessionId.slice(0, 12)}…
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            {active && (
              <span className="flex items-center gap-1.5">
                <Timer className="h-3.5 w-3.5" />
                <span className="tabular-nums font-mono">{fmtElapsed(Math.max(0, now - agent.startedAt))}</span>
              </span>
            )}
            <span className={cn('led', STATUS_META[agent.status]?.color.replace('text-', 'bg-'), active && 'led-pulse')} />
          </div>
        </div>

        {/* Activity sparkline */}
        {spark && (
          <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-muted/30">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wider">{t('activity:fleet.activity')}</span>
            <span className="text-sm text-[hsl(var(--success))] font-mono tracking-[-0.1em]">{spark}</span>
            {lastTool && (
              <span className="text-[10px] text-muted-foreground ml-auto">
                {t('activity:agents.lastToolLabel')} <span className="font-mono">{lastTool.name}</span>
                <span className="tabular-nums"> {lastTool.durationMs}ms</span>
                {!lastTool.ok && <span className="text-destructive ml-1">✗</span>}
              </span>
            )}
          </div>
        )}

        {/* Task description */}
        {agent.description && (
          <div className="px-3 py-2 rounded-lg bg-muted/20 border border-border/50">
            <span className="text-[9px] text-muted-foreground uppercase tracking-wider">{t('activity:fleet.currentTask')}</span>
            <p className="text-xs mt-1 text-foreground/80">{agent.description}</p>
          </div>
        )}
      </div>

      {/* Scrollable content */}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 space-y-4">
        {/* Stats grid - detailed */}
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg border bg-card p-3">
            <div className="flex items-center gap-2 text-[9px] text-muted-foreground uppercase tracking-wider mb-2">
              <Cpu className="h-3 w-3" /> {t('activity:fleet.providerModel')}
            </div>
            <div className="text-sm font-mono font-medium">
              {agent.provider ?? '?'}/{agent.model ?? '?'}
            </div>
          </div>
          <div className="rounded-lg border bg-card p-3">
            <div className="flex items-center gap-2 text-[9px] text-muted-foreground uppercase tracking-wider mb-2">
              <Activity className="h-3 w-3" /> {t('activity:fleet.performance')}
            </div>
            <div className="space-y-1">
              <div className="flex justify-between text-[11px]">
                <span className="text-muted-foreground">{t('activity:fleet.iterations')}</span>
                <span className="font-mono font-medium">L{getIterations(agent)}</span>
              </div>
              <div className="flex justify-between text-[11px]">
                <span className="text-muted-foreground">{t('activity:fleet.toolCalls')}</span>
                <span className="font-mono font-medium">{agent.toolCalls}</span>
              </div>
              <div className="flex justify-between text-[11px]">
                <span className="text-muted-foreground">{t('activity:fleet.uniqueTools')}</span>
                <span className="font-mono font-medium">{uniqueTools}</span>
              </div>
            </div>
          </div>
          <div className="rounded-lg border bg-card p-3">
            <div className="flex items-center gap-2 text-[9px] text-muted-foreground uppercase tracking-wider mb-2">
              <DollarSign className="h-3 w-3" /> {t('activity:fleet.cost')}
            </div>
            <div className="text-lg font-mono font-bold text-[hsl(var(--success))]">
              {fmtCost(agent.costUsd)}
            </div>
            <div className="text-[10px] text-muted-foreground mt-1">
              {t('activity:fleet.avgPerTool', { ms: avgToolDuration })}
            </div>
          </div>
          <div className="rounded-lg border bg-card p-3">
            <div className="flex items-center gap-2 text-[9px] text-muted-foreground uppercase tracking-wider mb-2">
              <Database className="h-3 w-3" /> {t('activity:fleet.context')}
            </div>
            <div className="space-y-2">
              <div className="flex justify-between text-[11px]">
                <span className="text-muted-foreground">{t('activity:fleet.tokens')}</span>
                <span className="font-mono font-medium">{fmtTok(agent.ctxTokens)}</span>
              </div>
              <ContextFillBar pct={ctxPct} tokens={agent.ctxTokens} maxTokens={agent.maxContext} />
            </div>
          </div>
        </div>

        {/* Context bar - full width */}
        {agent.maxContext > 0 && (
          <div className="rounded-lg border bg-card p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[9px] text-muted-foreground uppercase tracking-wider">{t('activity:agents.contextUsage')}</span>
              <span className={cn(
                'text-[11px] font-mono font-medium',
                ctxPct >= 85 ? 'text-destructive' : ctxPct >= 70 ? 'text-warning' : 'text-[hsl(var(--success))]'
              )}>
                {ctxPct}%
              </span>
            </div>
            <ContextFillBar pct={ctxPct} tokens={agent.ctxTokens} maxTokens={agent.maxContext} />
          </div>
        )}

        {/* Current tool */}
        {tool && (
          <div className={cn(
            'rounded-lg border px-4 py-3 flex items-center gap-3',
            active ? 'border-primary/30 bg-primary/[0.04]' : 'border-border bg-muted/30'
          )}>
            <Wrench className={cn('h-4 w-4', active ? 'text-primary animate-pulse' : 'text-muted-foreground')} />
            <span className="text-sm font-mono font-medium">{tool}</span>
            {active ? (
              <span className="ml-auto flex items-center gap-1.5 text-[10px] text-primary">
                <Loader2 className="h-3 w-3 animate-spin" /> {t('activity:fleet.running')}
              </span>
            ) : (
              <span className="ml-auto text-[10px] text-muted-foreground">{t('activity:fleet.completed')}</span>
            )}
          </div>
        )}

        {agent.id !== 'leader' && (
          <AgentTranscript
            entries={transcript}
            agentName={agent.name}
            maxHeightClassName="max-h-[28rem]"
          />
        )}

        {/* Streaming/Final output */}
        {outputText ? (
          <div className="rounded-lg border bg-card">
            <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/30">
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                {isStream ? (
                  <>
                    <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                    {t('activity:fleet.liveOutput')}
                  </>
                ) : (
                  <>
                    <FolderOpen className="h-3 w-3" />
                    {t('activity:fleet.finalOutput')}
                  </>
                )}
              </span>
              <button
                type="button"
                onClick={() => handleCopy(outputText)}
                className="flex items-center gap-1 px-2 py-1 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                {copied ? <CheckCircle2 className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
                {copied ? t('common:action.copied') : t('common:action.copy')}
              </button>
            </div>
            <pre className="p-4 text-xs whitespace-pre-wrap font-mono text-foreground/80 leading-relaxed max-h-64 overflow-y-auto">
              {outputText}
            </pre>
          </div>
        ) : active ? (
          <div className="rounded-lg border border-dashed border-border p-6 text-center">
            <Loader2 className="h-6 w-6 mx-auto mb-2 text-muted-foreground/50 animate-spin" />
            <span className="text-xs text-muted-foreground">{t('activity:fleet.waitingOutput')}</span>
          </div>
        ) : null}

        {/* Budget warning */}
        {agent.budgetWarning && (
          <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-warning/10 border border-warning/25">
            <Zap className="h-5 w-5 text-warning shrink-0" />
            <div>
              <span className="text-sm font-medium text-warning">
                {t('activity:fleet.budgetWarningTitle')}
              </span>
              <p className="text-[11px] text-warning/80 mt-0.5">
                {t('activity:fleet.hittingLimit', { kind: agent.budgetWarning.kind, used: agent.budgetWarning.used, limit: agent.budgetWarning.limit })}
              </p>
            </div>
          </div>
        )}

        {/* Extensions */}
        {agent.extensions > 0 && (
          <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-[hsl(var(--warning))]/10 border border-[hsl(var(--warning))]/20">
            <Zap className="h-5 w-5 text-[hsl(var(--warning))] shrink-0" />
            <div>
              <span className="text-sm font-medium">
                {t('activity:fleet.budgetExt', { count: agent.extensions })}
              </span>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {t('activity:fleet.extendedTimes', { count: agent.extensions })}
              </p>
            </div>
          </div>
        )}

        {/* Error */}
        {agent.error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
            <div className="flex items-center gap-2 mb-2">
              <XCircle className="h-4 w-4 text-destructive" />
              <span className="text-[10px] font-semibold text-destructive uppercase tracking-wider">{t('activity:fleet.errorLabel')}</span>
            </div>
            <p className="text-sm text-destructive/90">{agent.error.message}</p>
          </div>
        )}

        {/* Tool Log - detailed */}
        {agent.toolLog.length > 0 && (
          <div className="rounded-lg border bg-card">
            <button
              type="button"
              onClick={() => setShowFullToolLog(!showFullToolLog)}
              className="w-full flex items-center justify-between px-4 py-2 border-b bg-muted/30 hover:bg-muted/50 transition-colors"
            >
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                <Wrench className="h-3 w-3" />
                {t('activity:fleet.toolLog', { count: agent.toolLog.length })}
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
                    <span className={cn('led shrink-0', tl.ok ? 'text-[hsl(var(--success))]' : 'text-destructive')} />
                    <span className={cn('font-mono font-medium w-20 shrink-0', tl.ok ? 'text-foreground' : 'text-destructive')}>
                      {tl.name}
                    </span>
                    <span className="text-muted-foreground tabular-nums text-[10px]">
                      {tl.durationMs >= 1000 ? `${(tl.durationMs / 1000).toFixed(2)}s` : `${tl.durationMs}ms`}
                    </span>
                    {!tl.ok && (
                      <span className="ml-auto text-[10px] text-destructive font-medium">{t('activity:fleet.failed')}</span>
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

// ── Agent Row ──────────────────────────────────────────────────────────

function AgentRow({
  agent,
  now,
  selected,
  onClick,
  onContextClick,
}: {
  agent: AgentView;
  now: number;
  selected: boolean;
  onClick: () => void;
  onContextClick: () => void;
}): React.ReactElement {
  const { t } = useAppTranslation();
  const meta = STATUS_META[agent.status] ?? STATUS_META.idle;
  const active = agent.status === 'running';
  const modelLabel = agent.provider && agent.model
    ? `${agent.provider}/${agent.model}`
    : agent.model ?? '—';
  const projectName = useSessionStore((s) => s.projectName);
  const ctxPct = Math.min(100, Math.max(0, agent.ctxPct));

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full text-left rounded-lg border px-3 py-2 transition-colors flex items-center gap-3',
        selected
          ? 'border-primary/50 bg-primary/[0.06]'
          : 'border-border/60 hover:border-primary/30 hover:bg-primary/[0.03]',
        agent.status === 'failed' || agent.status === 'timeout'
          ? 'opacity-80'
          : '',
      )}
    >
      {/* Selection indicator */}
      <span className={cn('shrink-0', selected ? 'text-primary' : 'text-muted-foreground/30')}>
        {selected ? <ChevronRight className="h-4 w-4" /> : <span className="w-4 inline-block" />}
      </span>

      {/* Status icon */}
      <span className={meta.color}>{meta.icon}</span>

      {/* Name */}
      <span className={cn('text-xs font-semibold min-w-0 truncate max-w-[8rem]', selected && 'text-primary')}>
        {agent.name}
      </span>

      {/* Session badge — shows which session/project the agent belongs to */}
      {'sessionId' in agent && agent.sessionId && (
        <span
          className="shrink-0 text-[9px] font-mono text-muted-foreground/50 bg-muted/40 px-1 py-0.5 rounded select-none"
          title={`${t('activity:agents.sessionTitle', { sid: agent.sessionId })}${projectName ? t('activity:agents.projectSuffix', { name: projectName }) : ''}`}
        >
          {shortSessionId(agent.sessionId)}
        </span>
      )}

      {/* Model */}
      <span className="text-[10px] text-muted-foreground font-mono truncate max-w-[10rem] shrink">
        {modelLabel}
      </span>

      {/* Iterations / tools */}
      <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
        L{getIterations(agent)} {agent.toolCalls}t
      </span>

      {/* Context bar */}
      {ctxPct > 0 && agent.maxContext > 0 && (
        <div className="shrink-0">
          <ContextFillBar
            pct={ctxPct}
            tokens={agent.ctxTokens}
            maxTokens={agent.maxContext}
            onClick={onContextClick}
          />
        </div>
      )}

      {/* Current tool */}
      {active && agent.currentTool && (
        <span className="text-[10px] text-primary font-mono truncate max-w-[8rem] shrink">
          → {agent.currentTool}
        </span>
      )}

      {/* Extensions */}
      {agent.extensions > 0 && (
        <span className="text-[10px] text-[hsl(var(--warning))] shrink-0">
          ⚡×{agent.extensions}
        </span>
      )}

      {/* Elapsed */}
      <span className="text-[10px] text-muted-foreground tabular-nums shrink-0 ml-auto">
        {active ? fmtElapsed(Math.max(0, now - agent.startedAt)) : statusLabel(agent.status, t)}
      </span>

      {/* Cost */}
      {agent.costUsd > 0 && (
        <span className="text-[10px] text-[hsl(var(--success))] tabular-nums font-medium shrink-0">
          {fmtCost(agent.costUsd)}
        </span>
      )}
    </button>
  );
}

export function getLastEventAt(a: AgentView): number {
  if (a.id === 'leader') return (a as LeaderEntry).lastEventAt;
  return (a as SubagentView).completedAt ?? (a as SubagentView).startedAt;
}

export function getIterations(a: AgentView): number {
  if (a.id === 'leader') return (a as LeaderEntry).iterations;
  return (a as SubagentView).iteration;
}

export function AgentsPage({
  className,
}: {
  className?: string | undefined;
}): React.ReactElement {
  const { t } = useAppTranslation();
  const fleetAgents = useFleetStore((s) => s.agents);
  // Narrow selectors — the bare `useSessionStore()` form re-rendered on every
  // unrelated session-store write (todos, modes, …). We only consume the
  // cost/context/identity fields below.
  const sessionStore = useSessionStore(
    useShallow((s) => ({
      sessionId: s.session?.id,
      cost: s.cost,
      lastInputTokens: s.lastInputTokens,
      maxContext: s.maxContext,
      startTime: s.startTime,
    })),
  );
  const { provider, model } = useConfigStore(
    useShallow((s) => ({ provider: s.provider, model: s.model })),
  );
  const chatIsLoading = useChatStore((s) => s.isLoading);
  const chatMessages = useChatStore((s) => s.messages);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(Date.now());
  const [breakdownOpen, setBreakdownOpen] = useState(false);

  // Live clock
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // ── Build leader entry ──
  const leaderEntry: LeaderEntry = useMemo(() => {
    const toolMsgs = chatMessages.filter((m) => m.role === 'tool');
    const isLoading = chatIsLoading;

    return {
      id: 'leader',
      name: 'LEADER',
      sessionId: sessionStore.sessionId,
      provider,
      model,
      status: isLoading ? ('running' as const) : ('idle' as const),
      iterations: 0,
      toolCalls: toolMsgs.length,
      costUsd: sessionStore.cost,
      ctxPct: sessionStore.maxContext > 0
        ? Math.min(100, Math.round((sessionStore.lastInputTokens / sessionStore.maxContext) * 100))
        : 0,
      ctxTokens: sessionStore.lastInputTokens,
      maxContext: sessionStore.maxContext,
      startedAt: sessionStore.startTime ?? Date.now(),
      lastEventAt: Date.now(),
      extensions: 0,
      toolLog: [],
    };
  }, [provider, model, sessionStore.cost, sessionStore.lastInputTokens, sessionStore.maxContext, sessionStore.startTime, sessionStore.sessionId, chatMessages, chatIsLoading]);

  // ── Merge leader + fleet ──
  // The server now emits subagent.event for subagentId 'leader' as well.
  // We merge that live data into our synthetic LeaderEntry so the leader row
  // gets real-time tool tracking, context updates, and cost — just like the TUI.
  // Fleet store's 'leader' entry is excluded from subagents to avoid duplication.
  const allAgents = useMemo(() => {
    const fleetLeader = fleetAgents.get('leader');
    const mergedLeader: LeaderEntry = fleetLeader
      ? {
          ...leaderEntry,
          status: fleetLeader.status === 'running' ? 'running' : leaderEntry.status,
          iterations: fleetLeader.iteration || leaderEntry.iterations,
          toolCalls: fleetLeader.toolCalls || leaderEntry.toolCalls,
          costUsd: fleetLeader.costUsd || leaderEntry.costUsd,
          ctxPct: fleetLeader.ctxPct,
          ctxTokens: fleetLeader.ctxTokens,
          maxContext: fleetLeader.maxContext || leaderEntry.maxContext,
          extensions: fleetLeader.extensions,
          currentTool: fleetLeader.currentTool ?? fleetLeader.lastTool,
          toolLog: fleetLeader.toolLog,
          partialText: fleetLeader.partialText,
          finalText: fleetLeader.finalText,
          error: fleetLeader.error,
          lastEventAt: fleetLeader.completedAt ?? fleetLeader.startedAt ?? leaderEntry.lastEventAt,
        }
      : leaderEntry;

    const list: AgentView[] = [mergedLeader];
    // Exclude the 'leader' entry from the fleet store to avoid duplication.
    const subs = Array.from(fleetAgents.values()).filter((a) => a.id !== 'leader');
    list.push(...subs);
    return list;
  }, [leaderEntry, fleetAgents]);

  // ── Sort: running first > idle > completed/failed (newest first) ──
  const sorted = useMemo(() => {
    return [...allAgents].sort((a, b) => {
      const ra = a.status === 'running' ? 0 : a.status === 'idle' ? 1 : 2;
      const rb = b.status === 'running' ? 0 : b.status === 'idle' ? 1 : 2;
      if (ra !== rb) return ra - rb;
      if (ra === 2) return getLastEventAt(b) - getLastEventAt(a);
      return a.startedAt - b.startedAt;
    });
  }, [allAgents]);

  // ── Counts ──
  const counts = useMemo(() => {
    let running = 0;
    let idle = 0;
    let completed = 0;
    let failed = 0;
    for (const a of allAgents) {
      if (a.status === 'running') running++;
      else if (a.status === 'idle') idle++;
      else if (a.status === 'completed') completed++;
      else failed++; // failed/timeout/stopped
    }
    return { running, idle, completed, failed };
  }, [allAgents]);

  // ── Totals ──
  const totalCost = useMemo(
    () => allAgents.reduce((sum, a) => sum + (a.costUsd ?? 0), 0),
    [allAgents],
  );

  const selected = selectedId ? allAgents.find((a) => a.id === selectedId) ?? null : null;

  // ── Keyboard navigation ──
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;

      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        const idx = selectedId ? sorted.findIndex((a) => a.id === selectedId) : -1;
        const nextIdx = Math.min(sorted.length - 1, idx + 1);
        const next = sorted[nextIdx];
        if (next) setSelectedId(next.id);
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        const idx = selectedId ? sorted.findIndex((a) => a.id === selectedId) : 0;
        const prevIdx = Math.max(0, idx - 1);
        const prev = sorted[prevIdx];
        if (prev) setSelectedId(prev.id);
      } else if (e.key === 'Escape') {
        setSelectedId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, sorted]);

  // ── Model mapping ──
  const modelMap = useMemo(() => {
    const seen = new Map<string, string>();
    for (const a of sorted) {
      if (a.model && !seen.has(a.name)) {
        seen.set(a.name, `${a.provider ?? '?'}/${a.model}`);
      }
    }
    return [...seen.entries()].slice(0, 4);
  }, [sorted]);

  return (
    <div
      className={cn('flex h-full min-h-0 min-w-0 overflow-x-auto overflow-y-hidden', className)}
      ref={containerRef}
    >
      {/* ── Left column: Agent list ── */}
      <div className={cn(
        'flex min-h-0 min-w-0 flex-col border-r bg-card/95 transition-all duration-200',
        selected ? 'w-[400px] max-w-full shrink-0' : 'w-full'
      )}>
        {/* Header */}
        <div className="border-b bg-card/95 backdrop-blur-sm shrink-0">
          <div className="px-4 py-3 space-y-2">
            {/* Title row */}
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold flex items-center gap-1.5">
                <Bot className="h-4 w-4 text-primary" />
                {t('activity:agents.agentsLive')}
              </h2>
              <span className="text-muted-foreground/40">│</span>
              {counts.running > 0 && (
                <span className="flex items-center gap-1 text-[11px] text-[hsl(var(--success))] font-medium">
                  <span className="led led-pulse text-[hsl(var(--success))]" />
                  {t('activity:fleet.runningCount', { count: counts.running })}
                </span>
              )}
              <span className="text-[11px] text-muted-foreground">
                {t('activity:agents.doneCount', { count: counts.completed })}
              </span>
              {counts.failed > 0 && (
                <span className="text-[11px] text-destructive">
                  {t('activity:agents.failedCount', { count: counts.failed })}
                </span>
              )}
            </div>

            {/* Model mapping */}
            {modelMap.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[10px] text-muted-foreground">{t('activity:agents.modelsLabel')}</span>
                {modelMap.map(([name, mod]) => (
                  <span key={name} className="text-[10px] text-muted-foreground font-mono">
                    {name}:{mod}
                  </span>
                ))}
              </div>
            )}

            {/* Totals row */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] text-muted-foreground">{t('activity:agents.shownLabel')}</span>
              <span className="text-[10px] font-medium">{sorted.length}</span>
              <span className="text-[10px] text-muted-foreground">{t('activity:agents.totalLabel')}</span>
              <span className="text-[10px] text-[hsl(var(--success))] font-medium tabular-nums">
                {fmtCost(totalCost)}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {t('activity:agents.leaderFleetTotals', { leader: fmtCost(leaderEntry.costUsd), fleet: fmtCost(totalCost - leaderEntry.costUsd) })}
              </span>
            </div>

            {/* Navigation hint */}
            <div className="flex items-center gap-2">
              <span className="text-[9px] text-muted-foreground/60">
                {t('activity:agents.navHintJk')}
              </span>
              {selected && (
                <button
                  type="button"
                  onClick={() => setSelectedId(null)}
                  className="text-[9px] text-muted-foreground/60 hover:text-foreground transition-colors"
                >
                  {t('activity:agents.escCloseDetail')}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Agent list */}
        <div className="min-h-0 min-w-0 flex-1 overflow-auto">
          {sorted.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center space-y-2">
                <Bot className="h-8 w-8 text-muted-foreground/40 mx-auto" />
                <p className="text-sm text-muted-foreground">
                  {t('activity:agents.noAgentsRunning')}
                </p>
                <p className="text-xs text-muted-foreground/60">
                  {t('activity:fleet.agentsAppear')}
                </p>
              </div>
            </div>
          ) : (
            <div className="p-2 space-y-1">
              {(() => {
                const groups = new Map<string, AgentView[]>();
                for (const a of sorted) {
                  const sid = 'sessionId' in a ? a.sessionId : undefined;
                  const key = sid ?? '__unknown__';
                  const list = groups.get(key) ?? [];
                  list.push(a);
                  groups.set(key, list);
                }
                const entries = [...groups.entries()];
                const multiSession = entries.length > 1;

                const rows: React.ReactNode[] = [];
                for (const [sid, agents] of entries) {
                  if (multiSession) {
                    const label = sid === '__unknown__' ? t('activity:agents.unknownSession') : sid.slice(0, 8);
                    const agentCount = agents.length;
                    rows.push(
                      <button
                        type="button"
                        key={`grp-${sid}`}
                        className="text-[9px] text-muted-foreground/50 font-mono px-2 pt-3 pb-1 uppercase tracking-wider hover:text-muted-foreground hover:bg-muted/30 rounded transition-colors cursor-pointer w-full text-left"
                        title={t('activity:agents.sessionCopyTitle', { sid })}
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(sid);
                          } catch {
                            // clipboard unavailable — no-op
                          }
                        }}
                      >
                        {label}
                        {sid !== '__unknown__' && (
                          <span className="ml-1.5 text-[8px] opacity-60">{t('activity:agents.sessionWord')}</span>
                        )}
                        <span className="ml-1 text-[8px] opacity-40">
                          · {t('activity:agents.agentsCountSuffix', { count: agentCount })}
                        </span>
                      </button>,
                    );
                  }
                  for (const a of agents) {
                    rows.push(
                      <AgentRow
                        key={a.id}
                        agent={a}
                        now={nowTick}
                        selected={a.id === selected?.id}
                        onClick={() => setSelectedId(selectedId === a.id ? null : a.id)}
                        onContextClick={() => setBreakdownOpen(true)}
                      />,
                    );
                  }
                }
                return rows;
              })()}
            </div>
          )}
        </div>
      </div>

      {/* ── Right column: Agent detail ── */}
      {selected && (
        <div className="min-h-0 min-w-[360px] flex-1 overflow-hidden bg-card/50">
          <div className="flex h-full min-h-0 min-w-0 flex-col">
            {/* Detail header bar */}
            <div className="shrink-0 px-4 py-2 border-b bg-card/80 flex items-center gap-2">
              <ArrowRight className="h-4 w-4 text-primary" />
              <span className="text-xs font-semibold text-primary">{selected.name}</span>
              <span className="text-[10px] text-muted-foreground">{t('activity:fleet.detailedView')}</span>
              <button
                type="button"
                onClick={() => setSelectedId(null)}
                className="ml-auto text-[10px] text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
              >
                {t('activity:fleet.closeBtn')}
              </button>
            </div>
            {/* Detail content */}
            <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
              <AgentDetailPanel agent={selected} now={nowTick} />
            </div>
          </div>
        </div>
      )}

      {/* Empty state when nothing selected */}
      {!selected && sorted.length > 0 && (
        <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-muted/20">
          <div className="text-center space-y-3 max-w-sm">
            <Bot className="h-12 w-12 text-muted-foreground/30 mx-auto" />
            <p className="text-sm text-muted-foreground">
              {t('activity:fleet.selectAgentDetail')}
            </p>
            <p className="text-xs text-muted-foreground/60">
              {t('activity:fleet.selectAgentBody')}
            </p>
            <div className="flex items-center justify-center gap-4 pt-2">
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <kbd className="px-1.5 py-0.5 rounded bg-muted border text-[9px]">j</kbd>
                <kbd className="px-1.5 py-0.5 rounded bg-muted border text-[9px]">k</kbd>
                <span>{t('activity:fleet.navigateWord')}</span>
              </div>
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <kbd className="px-1.5 py-0.5 rounded bg-muted border text-[9px]">Enter</kbd>
                <span>{t('activity:fleet.selectWord')}</span>
              </div>
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <kbd className="px-1.5 py-0.5 rounded bg-muted border text-[9px]">Esc</kbd>
                <span>{t('activity:fleet.deselectWord')}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      <ContextBreakdownModal open={breakdownOpen} onClose={() => setBreakdownOpen(false)} />
    </div>
  );
}
