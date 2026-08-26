import {
  Bot,
  CheckCircle2,
  Clock,
  Crown,
  LayoutGrid,
  Trash2,
  Wrench,
  XCircle,
  Zap,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { openPanel } from '@/components/activity-bar/nav';
import { cn } from '@/lib/utils';
import type { SubagentView } from '@/stores';
import { useFleetStore, useSessionStore, useUIStore } from '@/stores';

const STATUS_META: Record<
  string,
  { led: string; badge: string; icon: React.ReactNode; color: string }
> = {
  running: {
    led: 'bg-success',
    badge: 'bg-success/12 text-success',
    icon: <span className="led text-success led-pulse" />,
    color: 'text-success',
  },
  completed: {
    led: 'bg-success',
    badge: 'bg-success/12 text-success',
    icon: <CheckCircle2 className="h-3.5 w-3.5" />,
    color: 'text-success',
  },
  failed: {
    led: 'bg-destructive',
    badge: 'bg-destructive/15 text-destructive',
    icon: <XCircle className="h-3.5 w-3.5" />,
    color: 'text-destructive',
  },
  timeout: {
    led: 'bg-warning',
    badge: 'bg-muted text-muted-foreground',
    icon: <Clock className="h-3.5 w-3.5" />,
    color: 'text-warning',
  },
  stopped: {
    led: 'bg-muted-foreground',
    badge: 'bg-muted text-muted-foreground',
    icon: <span className="led text-muted-foreground" />,
    color: 'text-muted-foreground',
  },
  idle: {
    led: 'bg-muted-foreground',
    badge: 'bg-muted text-muted-foreground',
    icon: <span className="led text-muted-foreground" />,
    color: 'text-muted-foreground',
  },
};

function fmtElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m ${totalSec % 60}s`;
  const totalH = Math.floor(totalMin / 60);
  if (totalH < 24) return `${totalH}h ${totalMin % 60}m`;
  return `${Math.floor(totalH / 24)}d`;
}

function fmtCost(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return '$0';
  if (n < 0.01) {
    const s = n.toFixed(5);
    if (s === '0.00000') return '$0';
    return '$' + s.replace(/(\d)0+$/, '$1').replace(/\.$/, '');
  }
  return '$' + n.toFixed(3);
}

// `sendRosterMessage` lives in `@/lib/roster-ws` and is shared with `CustomRosterPanel.tsx`.

// ══════════════════════════════════════════════════════════════════════
//  TAB: Live Fleet
// ══════════════════════════════════════════════════════════════════════

export function LiveFleetTab({ nowTick }: { nowTick: number }) {
  const { t } = useAppTranslation();
  const fleetAgents = useFleetStore((s) => s.agents);
  const leaderId = useFleetStore((s) => s.leaderId);
  const currentSessionId = useSessionStore((s) => s.session?.id);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'running' | 'done' | 'failed'>('all');

  const sessionAgents = useMemo(() => {
    return Array.from(fleetAgents.values()).filter(
      (a) => !a.sessionId || !currentSessionId || a.sessionId === currentSessionId,
    );
  }, [fleetAgents, currentSessionId]);

  const list = useMemo(() => {
    const arr = [...sessionAgents];
    arr.sort((a, b) => {
      const aActive = a.status === 'running' ? 0 : 1;
      const bActive = b.status === 'running' ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      return b.startedAt - a.startedAt;
    });
    if (filter === 'all') return arr;
    if (filter === 'running') return arr.filter((a) => a.status === 'running');
    if (filter === 'done') return arr.filter((a) => a.status === 'completed');
    if (filter === 'failed')
      return arr.filter((a) => a.status === 'failed' || a.status === 'timeout');
    return arr;
  }, [sessionAgents, filter]);

  const counts = useMemo(() => {
    let running = 0,
      completed = 0,
      failed = 0;
    for (const a of sessionAgents) {
      if (a.status === 'running') running++;
      else if (a.status === 'completed') completed++;
      else if (a.status === 'failed' || a.status === 'timeout') failed++;
    }
    return { running, completed, failed, total: sessionAgents.length };
  }, [sessionAgents]);

  const clearFinished = useFleetStore((s) => s.clearFinishedAgents);

  const selected = selectedId ? list.find((a) => a.id === selectedId) : null;

  const openInspector = useCallback((agentId?: string) => {
    const ui = useUIStore.getState();
    if (agentId) {
      ui.setInspectorFocusedAgentId(agentId);
      ui.setInspectorTab('agents');
    } else {
      ui.setInspectorTab('fleet');
    }
    ui.setInspectorOpen(true);
  }, []);

  if (list.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <div className="text-center space-y-3">
          <Bot className="h-10 w-10 mx-auto opacity-30" />
          <p className="text-sm">{t('activity:agentRoster.noActiveFleetAgents')}</p>
          <p className="text-xs text-muted-foreground/70">
            {t('activity:agentRoster.liveEmpty')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      {/* Left: agent list */}
      <div
        className={cn(
          'flex flex-col min-h-0 min-w-0 overflow-hidden',
          selected ? 'w-80 shrink-0 border-r border-border/50' : 'flex-1',
        )}
      >
        {/* Filter bar */}
        <div className="flex items-center gap-1 shrink-0 px-3 py-2 border-b border-border/50">
          {(['all', 'running', 'done', 'failed'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={cn(
                'rounded px-2 py-0.5 text-[10px] font-medium transition-colors',
                filter === f
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
              )}
            >
              {f === 'all' && t('activity:agentRoster.filterAll', { count: counts.total })}
              {f === 'running' && t('activity:agentRoster.filterRunning', { count: counts.running })}
              {f === 'done' && t('activity:agentRoster.filterDone', { count: counts.completed })}
              {f === 'failed' && t('activity:agentRoster.filterFailed', { count: counts.failed })}
            </button>
          ))}
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => openPanel('agents')}
            className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            title={t('activity:agentRoster.openAgentsPanel')}
          >
            <Bot className="h-3 w-3" />
            {t('activity:agentRoster.openAgentsPanel')}
          </button>
          {counts.completed + counts.failed > 0 && (
            <button
              type="button"
              onClick={clearFinished}
              className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
            >
              <Trash2 className="h-2.5 w-2.5" /> {t('activity:agentRoster.clear')}
            </button>
          )}
        </div>

        {/* Agent list */}
        <div className="min-h-0 flex-1 overflow-y-auto p-2 space-y-1">
          {list.map((agent) => (
            <button
              key={agent.id}
              type="button"
              onClick={() => setSelectedId(selectedId === agent.id ? null : agent.id)}
              className={cn(
                'w-full text-left rounded-lg border px-3 py-2 transition-colors flex items-center gap-2',
                selectedId === agent.id
                  ? 'border-primary/50 bg-primary/[0.06]'
                  : 'border-border/60 hover:border-primary/30 hover:bg-primary/[0.03]',
              )}
            >
              <span
                className={cn(
                  'led shrink-0',
                  STATUS_META[agent.status]?.led ?? 'bg-muted-foreground',
                  agent.status === 'running' && 'led-pulse',
                )}
              />
              <span className="text-xs font-semibold min-w-0 truncate max-w-[7rem]">
                {agent.name}
              </span>
              {agent.id === leaderId && <Crown className="h-3 w-3 shrink-0 text-warning" />}
              {agent.model && (
                <span className="text-[9px] text-muted-foreground font-mono truncate max-w-[6rem] shrink-0">
                  {agent.model}
                </span>
              )}
              <span className="text-[9px] text-muted-foreground tabular-nums shrink-0">
                {agent.iteration}it · {agent.toolCalls}t
              </span>
              {agent.status === 'running' && (
                <span className="text-[9px] text-primary tabular-nums shrink-0 ml-auto">
                  {fmtElapsed(Date.now() - agent.startedAt)}
                </span>
              )}
              {agent.status !== 'running' && (
                <span
                  className={cn(
                    'text-[9px] tabular-nums shrink-0 ml-auto',
                    STATUS_META[agent.status]?.color ?? 'text-muted-foreground',
                  )}
                >
                  {agent.status}
                </span>
              )}
              {agent.costUsd > 0 && (
                <span className="text-[9px] text-success tabular-nums font-medium shrink-0">
                  {fmtCost(agent.costUsd)}
                </span>
              )}
              {agent.status === 'running' && agent.currentTool && (
                <span className="text-[9px] text-primary font-mono truncate max-w-[6rem] shrink-0">
                  → {agent.currentTool}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Bottom bar */}
        <div className="shrink-0 border-t border-border/50 px-3 py-2 flex items-center gap-2 text-[10px] text-muted-foreground">
          <span className="font-medium tabular-nums">{counts.total}</span> {t('activity:agentRoster.agentsTotal')}
          <span className="text-muted-foreground/50">·</span>
          <span className="text-success tabular-nums">{counts.running}</span> running
          <span className="text-muted-foreground/50">·</span>
          <span className="tabular-nums">{counts.completed}</span> done
          {counts.failed > 0 && (
            <>
              <span className="text-muted-foreground/50">·</span>
              <span className="text-destructive tabular-nums">{counts.failed}</span> failed
            </>
          )}
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => openInspector()}
            className="inline-flex items-center gap-1 rounded border border-border/50 px-2 py-1 hover:bg-accent transition-colors"
          >
            <LayoutGrid className="h-3 w-3" />
            {t('activity:agentRoster.fleetInspector')}
          </button>
        </div>
      </div>

      {/* Right: selected agent detail */}
      {selected && (
        <div className="flex-1 min-h-0 min-w-0 overflow-y-auto p-4">
          <AgentDetailCard agent={selected} nowTick={nowTick} />
        </div>
      )}
    </div>
  );
}

function AgentDetailCard({ agent, nowTick }: { agent: SubagentView; nowTick: number }) {
  const { t } = useAppTranslation();
  const elapsed =
    agent.status === 'running'
      ? fmtElapsed(nowTick - agent.startedAt)
      : agent.completedAt
        ? fmtElapsed(agent.completedAt - agent.startedAt)
        : '-';
  const ctxPct = Math.min(100, Math.max(0, agent.ctxPct));
  const hasTool = agent.currentTool || agent.lastTool;
  const leaderId = useFleetStore((s) => s.leaderId);

  return (
    <div className="space-y-4">
      {/* Identity header */}
      <div className="flex items-center gap-3">
        <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-primary/10">
          <Bot className="h-5 w-5 text-primary" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <span className="text-base font-semibold">{agent.name}</span>
            {agent.id === leaderId && (
              <span className="inline-flex items-center gap-1 rounded border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-[9px] font-medium text-warning">
                <Crown className="h-2.5 w-2.5" /> {t('activity:agentRoster.leader')}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <span
              className={cn(
                'led',
                STATUS_META[agent.status]?.led,
                agent.status === 'running' && 'led-pulse',
              )}
            />
            <span>{agent.status}</span>
            {agent.model && (
              <span>
                · {agent.provider}/{agent.model}
              </span>
            )}
            <span>· {elapsed}</span>
          </div>
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-4 gap-2">
        <div className="rounded-lg border bg-card p-2">
          <span className="text-[9px] text-muted-foreground uppercase tracking-wider">
            {t('activity:agentRoster.iterations')}
          </span>
          <div className="text-lg font-mono font-semibold mt-0.5">{agent.iteration}</div>
        </div>
        <div className="rounded-lg border bg-card p-2">
          <span className="text-[9px] text-muted-foreground uppercase tracking-wider">
            {t('activity:agentRoster.toolCalls')}
          </span>
          <div className="text-lg font-mono font-semibold mt-0.5">{agent.toolCalls}</div>
        </div>
        <div className="rounded-lg border bg-card p-2">
          <span className="text-[9px] text-muted-foreground uppercase tracking-wider">{t('activity:agentRoster.cost')}</span>
          <div className="text-lg font-mono font-semibold mt-0.5 text-success">
            {fmtCost(agent.costUsd)}
          </div>
        </div>
        <div className="rounded-lg border bg-card p-2">
          <span className="text-[9px] text-muted-foreground uppercase tracking-wider">{t('activity:agentRoster.context')}</span>
          <div className="text-lg font-mono font-semibold mt-0.5">{ctxPct}%</div>
        </div>
      </div>

      {/* Context bar */}
      {agent.maxContext > 0 && (
        <div className="space-y-1">
          <div className="flex justify-between text-[10px]">
            <span className="text-muted-foreground">{t('activity:agentRoster.contextWindow')}</span>
            <span
              className={cn(
                'tabular font-medium',
                ctxPct >= 85 ? 'text-destructive' : ctxPct >= 70 ? 'text-warning' : 'text-success',
              )}
            >
              {agent.ctxTokens.toLocaleString()} / {agent.maxContext.toLocaleString()} tokens
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                'h-full rounded-full transition-all',
                ctxPct >= 85 ? 'bg-destructive' : ctxPct >= 70 ? 'bg-warning' : 'bg-primary',
              )}
              style={{ width: `${Math.max(2, ctxPct)}%` }}
            />
          </div>
        </div>
      )}

      {/* Current tool */}
      {hasTool && (
        <div
          className={cn(
            'flex items-center gap-2 rounded-lg border px-3 py-2',
            agent.status === 'running'
              ? 'border-primary/30 bg-primary/[0.04]'
              : 'border-border bg-muted/30',
          )}
        >
          <Wrench
            className={cn(
              'h-4 w-4',
              agent.status === 'running' ? 'text-primary animate-pulse' : 'text-muted-foreground',
            )}
          />
          <span className="text-sm font-mono">{agent.currentTool ?? agent.lastTool}</span>
          <span className="text-[10px] text-muted-foreground ml-auto">
            {agent.currentTool ? t('activity:agentRoster.running') : 'Last tool'}
          </span>
        </div>
      )}

      {/* Error */}
      {agent.error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
          <span className="text-[10px] font-semibold text-destructive uppercase tracking-wider">
            {t('activity:agentRoster.error')}
          </span>
          <p className="text-xs text-destructive/90 mt-1">{agent.error.message}</p>
        </div>
      )}

      {/* Tool log */}
      {agent.toolLog.length > 0 && (
        <div className="space-y-1">
          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
            Tool Log ({agent.toolLog.length})
          </span>
          <div className="space-y-0.5">
            {agent.toolLog.slice(0, 10).map((tl, i) => (
              <div
                key={`${tl.name}-${i}`}
                className={cn(
                  'flex items-center gap-2 rounded px-2 py-1 text-[10px] font-mono',
                  tl.ok ? 'bg-muted/30' : 'bg-destructive/5 border border-destructive/20',
                )}
              >
                <span className={cn('led shrink-0', tl.ok ? 'text-success' : 'text-destructive')} />
                <span className="truncate flex-1">{tl.name}</span>
                <span className="tabular text-muted-foreground">{tl.durationMs}ms</span>
                {!tl.ok && <span className="text-destructive">✗</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Budget warning */}
      {agent.budgetWarning && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-warning/10 border border-warning/25 text-xs">
          <Zap className="h-3.5 w-3.5 text-warning shrink-0" />
          <span className="text-warning">
            Budget: {agent.budgetWarning.kind} limit ({agent.budgetWarning.used}/
            {agent.budgetWarning.limit})
          </span>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════
//  TAB: Roster Catalog
// ══════════════════════════════════════════════════════════════════════
