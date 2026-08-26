import { cn } from '@/lib/utils';
import { AgentTranscript } from '@/components/AgentTranscript';
import { EMPTY_AGENT_TRANSCRIPT, type SubagentView, useFleetStore, useSessionStore } from '@/stores';
import { compareAgentsByActivity, tallyAgents } from '@/lib/agent-status';
import { Bot, Check, ChevronDown, ChevronRight, Clock, Copy, Cpu, Wrench, X, Zap } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { SparklineChart } from '@/components/ui/sparkline';

/** Status → LED color + label. */
const STATUS_META: Record<
  SubagentView['status'],
  { led: string; pulse: boolean }
> = {
  running: { led: 'text-success', pulse: true },
  completed: { led: 'text-success', pulse: false },
  failed: { led: 'text-destructive', pulse: false },
  timeout: { led: 'text-warning', pulse: false },
  stopped: { led: 'text-muted-foreground', pulse: false },
};

import { fmtCost, fmtTok, fmtElapsed as fmtDuration } from './dashboard-primitives.js';

// ── Agent detail overlay ──────────────────────────────────────────────

export function AgentDetail({
  agent,
  onClose,
}: {
  agent: SubagentView;
  onClose: () => void;
}): React.ReactElement {
  const _meta = STATUS_META[agent.status];
  const { t } = useAppTranslation();
  const active = agent.status === 'running';
  const tool = agent.currentTool ?? agent.lastTool;
  const elapsed = Date.now() - agent.startedAt;
  const [copied, setCopied] = useState(false);
  const leaderId = useFleetStore((s) => s.leaderId);
  const _isLeader = agent.id === leaderId;
  const transcript = useFleetStore((s) => s.agentTranscripts.get(agent.id) ?? EMPTY_AGENT_TRANSCRIPT);
  const ctxPct = Math.min(100, Math.max(0, agent.ctxPct));

  const handleCopy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable — silently ignore
    }
  }, []);

  // Hand-rolled overlay (not Radix Dialog), so Escape must be wired manually.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const ctxTone =
    ctxPct >= 85
      ? 'bg-destructive/12 text-destructive'
      : ctxPct >= 70
        ? 'bg-warning/12 text-warning'
        : 'bg-muted text-muted-foreground';

  return (
    <div className="p-3 space-y-3">
          {/* Description / Task */}
          {agent.description && (
            <div className="text-xs text-muted-foreground leading-relaxed">
              {agent.description}
            </div>
          )}

          {/* Stats grid */}
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg border bg-muted/30 px-3 py-2">
              <span className="text-[10px] text-muted-foreground">{t('activity:fleet.providerModel')}</span>
              <div className="flex items-center gap-1 mt-0.5">
                <Cpu className="h-3 w-3 text-muted-foreground" />
                <span className="text-xs font-mono font-medium">
                  {agent.provider ?? '?'}/{agent.model ?? '?'}
                </span>
              </div>
            </div>
            <div className="rounded-lg border bg-muted/30 px-3 py-2">
              <span className="text-[10px] text-muted-foreground">{t('activity:fleet.elapsed')}</span>
              <div className="flex items-center gap-1 mt-0.5">
                <Clock className="h-3 w-3 text-muted-foreground" />
                <span className="text-xs font-mono tabular">{fmtDuration(elapsed)}</span>
                {active && (
                  <span className="text-[10px] text-success">· {t('activity:fleet.running')}</span>
                )}
              </div>
            </div>
            <div className="rounded-lg border bg-muted/30 px-3 py-2">
              <span className="text-[10px] text-muted-foreground">{t('activity:fleet.iterations')}</span>
              <span className="block text-xs font-mono font-medium mt-0.5 tabular">
                {agent.iteration}
              </span>
            </div>
            <div className="rounded-lg border bg-muted/30 px-3 py-2">
              <span className="text-[10px] text-muted-foreground">{t('activity:fleet.toolCalls')}</span>
              <span className="block text-xs font-mono font-medium mt-0.5 tabular">
                {agent.toolCalls}
              </span>
            </div>
            <div className="rounded-lg border bg-muted/30 px-3 py-2">
              <span className="text-[10px] text-muted-foreground">{t('activity:fleet.cost')}</span>
              <span className="block text-xs font-mono font-medium mt-0.5 tabular">
                {fmtCost(agent.costUsd)}
              </span>
            </div>
            {agent.extensions > 0 && (
              <div className="rounded-lg border bg-muted/30 px-3 py-2">
                <span className="text-[10px] text-muted-foreground">{t('activity:fleet.budgetExtensions')}</span>
                <span className="block text-xs font-mono font-medium mt-0.5 tabular">
                  ⚡×{agent.extensions}
                </span>
              </div>
            )}
          </div>

          {/* Activity sparkline */}
          {active && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground">{t('activity:fleet.activity')}</span>
              <SparklineChart bins={agent.sparklineBins} className="font-mono" />
            </div>
          )}

          {/* Budget warning */}
          {agent.budgetWarning && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-warning/10 border border-warning/25 text-xs">
              <Zap className="h-3.5 w-3.5 text-warning shrink-0" />
              <span className="text-warning">
                {t('activity:fleet.hittingLimitTitle', { kind: agent.budgetWarning.kind, used: agent.budgetWarning.used, limit: agent.budgetWarning.limit })}
              </span>
            </div>
          )}

          {/* Context bar */}
          {agent.maxContext > 0 && (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[10px]">
                <span className="text-muted-foreground">{t('activity:fleet.contextWindow')}</span>
                <span className={cn('tabular font-medium', ctxTone.replace(/bg-\S+\s*/g, ''))}>
                  {ctxPct}%
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    'h-full rounded-full transition-all',
                    ctxPct >= 85
                      ? 'bg-destructive'
                      : ctxPct >= 70
                        ? 'bg-warning'
                        : 'bg-primary',
                  )}
                  style={{ width: `${Math.max(2, ctxPct)}%` }}
                />
              </div>
              <div className="text-[10px] text-muted-foreground tabular text-right">
                {t('activity:fleet.tokensUsed', { used: fmtTok(agent.ctxTokens), max: fmtTok(agent.maxContext) })}
              </div>
            </div>
          )}

          {/* Current tool */}
          {tool && (
            <div
              className={cn(
                'flex items-center gap-2 rounded-lg border px-3 py-2',
                active ? 'border-primary/30 bg-primary/[0.04]' : 'border-border bg-muted/30',
              )}
            >
              <Wrench className={cn('h-3.5 w-3.5', active ? 'text-primary animate-pulse' : 'text-muted-foreground')} />
              <span className="text-xs font-mono">{tool}</span>
              <span className="text-[10px] text-muted-foreground ml-auto">
                {agent.currentTool ? t('activity:fleet.toolRunning') : t('activity:fleet.lastTool')}
              </span>
            </div>
          )}

          <AgentTranscript
            entries={transcript}
            agentName={agent.name}
            compact
            maxHeightClassName="max-h-80"
          />

          {/* Error */}
          {agent.error && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
              <span className="text-[10px] font-semibold text-destructive uppercase tracking-wider">
                {t('activity:fleet.error')}
              </span>
              <p className="text-xs text-destructive/90 mt-1 leading-relaxed">
                {agent.error.message}
              </p>
            </div>
          )}

          {/* Output — partial text from subagent streaming, or final text on completion */}
          {agent.finalText ? (
            <div className="rounded-lg border bg-muted/20 p-3">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  {t('activity:fleet.finalOutput')}
                </span>
                <button
                  type="button"
                  onClick={() => handleCopy(agent.finalText!)}
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  title={t('activity:fleet.copyOutput')}
                >
                  {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
                  {copied ? t('common:action.copied') : t('common:action.copy')}
                </button>
              </div>
              <pre className="text-xs whitespace-pre-wrap font-mono text-foreground/80 leading-relaxed max-h-64 overflow-y-auto">
                {agent.finalText}
              </pre>
            </div>
          ) : agent.partialText ? (
            <div className="rounded-lg border bg-muted/20 p-3">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  {t('activity:fleet.liveOutput')}
                </span>
                <button
                  type="button"
                  onClick={() => handleCopy(agent.partialText!)}
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  title={t('activity:fleet.copyOutput')}
                >
                  {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
                  {copied ? t('common:action.copied') : t('common:action.copy')}
                </button>
              </div>
              <pre className="text-xs whitespace-pre-wrap font-mono text-foreground/80 leading-relaxed max-h-48 overflow-y-auto">
                {agent.partialText}
              </pre>
            </div>
          ) : active ? (
            <div className="rounded-lg border border-dashed border-border p-3 text-center">
              <span className="text-xs text-muted-foreground">
                {t('activity:fleet.waitingOutput')}
              </span>
              <p className="text-[10px] text-muted-foreground/75 mt-0.5">
                {t('activity:fleet.outputHint')}
              </p>
            </div>
          ) : null}

          {/* Tool execution log */}
          {agent.toolLog.length > 0 && (
            <div className="space-y-1">
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                {t('activity:fleet.toolLog', { count: agent.toolLog.length })}
              </span>
              <div className="max-h-40 overflow-y-auto space-y-0.5">
                {agent.toolLog.slice(0, 15).map((tl, i) => (
                  <div
                    key={`${tl.name}-${tl.at}-${i}`}
                    className={cn(
                      'flex items-center gap-2 rounded px-2 py-1 text-[10px]',
                      tl.ok ? 'bg-muted/30' : 'bg-destructive/5 border border-destructive/20',
                    )}
                  >
                    <span className={cn('led shrink-0', tl.ok ? 'text-success' : 'text-destructive')} />
                    <span className="font-mono truncate flex-1">{tl.name}</span>
                    <span className="tabular text-muted-foreground">{tl.durationMs}ms</span>
                    {!tl.ok && <span className="text-destructive font-medium">{t('activity:fleet.fail')}</span>}
                  </div>
                ))}
                {agent.toolLog.length > 15 && (
                  <p className="text-[9px] text-muted-foreground text-center px-2 py-0.5">
                    {t('activity:fleet.moreTools', { count: agent.toolLog.length - 15 })}
                  </p>
                )}
              </div>
            </div>
          )}
    </div>
  );
}

// ── Agent mini card (clickable) ───────────────────────────────────────
// Named AgentMiniCard to avoid colliding with the shared exported
// AgentCard in ./AgentCard (different props: `a`/`onClick` here).

function AgentMiniCard({
  a,
  onClick,
}: {
  a: SubagentView;
  onClick: () => void;
}): React.ReactElement {
  const meta = STATUS_META[a.status];
  const { t } = useAppTranslation();
  const active = a.status === 'running';
  const tool = a.currentTool ?? a.lastTool;
  const ctxPct = Math.min(100, Math.max(0, a.ctxPct));
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex min-w-[12rem] max-w-[15rem] flex-col gap-1 rounded-lg border p-2 transition-colors text-left cursor-pointer',
        'hover:border-primary/40 hover:bg-primary/[0.06]',
        active ? 'border-primary/30 bg-primary/[0.04]' : 'border-border bg-card opacity-85',
      )}
    >
      {/* Identity row */}
      <div className="flex items-center gap-1.5 min-w-0">
        <span className={cn('led shrink-0', meta.led, meta.pulse && 'led-pulse')} />
        <span className="truncate text-[11px] font-semibold text-foreground" title={a.name}>
          {a.name}
        </span>
        <span className="tabular ml-auto shrink-0 text-[10px] text-muted-foreground">
          {a.iteration}it · {a.toolCalls}t
        </span>
      </div>

      {/* Model + cost */}
      <div className="flex items-center gap-1.5 min-w-0">
        {a.model && (
          <span
            className="flex items-center gap-0.5 text-[10px] text-muted-foreground truncate"
            title={`${a.provider ?? ''}/${a.model}`}
          >
            <Cpu className="h-2.5 w-2.5 shrink-0" />
            <span className="truncate font-mono">{a.model}</span>
          </span>
        )}
        <span className="tabular text-[10px] text-foreground/75 ml-auto">
          {fmtCost(a.costUsd)}
        </span>
      </div>

      {/* Current/last tool */}
      {tool && (
        <div
          className={cn(
            'flex items-center gap-1 text-[10px] truncate',
            active ? 'text-primary' : 'text-muted-foreground',
          )}
          title={a.currentTool ? t('activity:fleet.cardRunning', { tool }) : t('activity:fleet.cardLastTool', { tool })}
        >
          <Wrench className={cn('h-2.5 w-2.5 shrink-0', active && 'animate-pulse')} />
          <span className="truncate font-mono">{tool}</span>
        </div>
      )}

      {/* Context bar — only when running */}
      {active && a.maxContext > 0 && (
        <div className="flex items-center gap-1" title={t('activity:fleet.contextPercent', { pct: ctxPct })}>
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                'h-full rounded-full transition-all',
                ctxPct >= 85
                  ? 'bg-destructive'
                  : ctxPct >= 70
                    ? 'bg-warning'
                    : 'bg-primary',
              )}
              style={{ width: `${Math.max(2, ctxPct)}%` }}
            />
          </div>
          <span className="tabular text-[9px] text-muted-foreground">
            {a.maxContext > 0 ? `${ctxPct}%` : '—'}
          </span>
        </div>
      )}

      {/* Error */}
      {a.error && (
        <div
          className="truncate rounded bg-destructive/10 px-1 py-0.5 text-[9px] text-destructive"
          title={a.error.message}
        >
          {a.error.message}
        </div>
      )}
    </button>
  );
}

// ── FleetPanel ─────────────────────────────────────────────────────────

/**
 * FleetPanel — compact live roster of subagents.
 *
 * Auto-collapses when there are 3+ agents to keep the chat column
 * clean. Shows a summary pill with running/done counts. Click any
 * agent card to open a detail overlay with full stats and (soon) the
 * live output stream.
 */
export function FleetPanel({
  className,
}: {
  className?: string | undefined;
}): React.ReactElement | null {
  const agents = useFleetStore((s) => s.agents);
  const currentSessionId = useSessionStore((s) => s.session?.id);
  const { t } = useAppTranslation();
  const [collapsed, setCollapsed] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const list = useMemo(() => {
    const arr = Array.from(agents.values()).filter(
      (a) => !a.sessionId || !currentSessionId || a.sessionId === currentSessionId,
    );
    arr.sort(compareAgentsByActivity);
    return arr;
  }, [agents, currentSessionId]);
  // Fleet is bounded (active agents), show all without pagination.

  const selected = selectedId ? list.find((a) => a.id === selectedId) : null;

  if (list.length === 0) return null;

  const tally = tallyAgents(list);
  const totalCost = list.reduce((sum, a) => sum + (a.costUsd ?? 0), 0);

  // Auto-expand when small fleet; collapse when large
  const effectiveCollapsed = collapsed && list.length >= 3;

  return (
    <div className={cn('flex min-h-0 min-w-0 gap-3', className)}>
      {/* Agent cards column */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col rounded-lg border border-border bg-card/50 backdrop-blur-sm overflow-hidden">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted/30 transition-colors shrink-0"
        >
          <Bot className="h-3.5 w-3.5 text-primary" />
          <span className="text-[11px] font-semibold text-foreground">Fleet</span>

          {/* Compact summary pills */}
          <span className="flex items-center gap-1.5 ml-auto text-[10px]">
            {tally.running > 0 && (
              <span className="flex items-center gap-1 text-success">
                <span className="led led-pulse text-success" />
                {tally.running}
              </span>
            )}
            {tally.completed > 0 && (
              <span className="text-muted-foreground">{t('activity:fleet.doneCount', { count: tally.completed })}</span>
            )}
            {tally.failed > 0 && (
              <span className="text-destructive">{t('activity:fleet.errCount', { count: tally.failed })}</span>
            )}
            {totalCost > 0 && (
              <span className="tabular text-foreground/70">{fmtCost(totalCost)}</span>
            )}
          </span>

          {effectiveCollapsed ? (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          )}
        </button>

        {!effectiveCollapsed && (
          <div>
            <div className="flex gap-2 overflow-x-auto px-2 pb-2 min-h-0">
            {list.map((a) => (
              <AgentMiniCard
                key={a.id}
                a={a}
                onClick={() => setSelectedId(selectedId === a.id ? null : a.id)}
              />
            ))}
            </div>
          </div>
        )}
      </div>

      {/* Agent detail inline panel — replaces the modal overlay */}
      {selected && (
        <div className="w-96 max-w-full shrink-0 rounded-lg border border-border bg-card shadow-lg overflow-hidden">
          <div className="flex h-full min-h-0 min-w-0 flex-col">
            {/* Detail header */}
            <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b bg-muted/20">
              <span className="text-xs font-semibold text-foreground truncate">{selected.name}</span>
              <button
                type="button"
                onClick={() => setSelectedId(null)}
                className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                aria-label={t('common:action.close')}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            {/* Scrollable detail content */}
            <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain">
              <AgentDetail agent={selected} onClose={() => setSelectedId(null)} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
