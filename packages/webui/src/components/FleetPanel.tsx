import { Bot, Check, Clock, Copy, Cpu, MessageSquare, Wrench, XCircle } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { agentBelongsToSession } from '@/lib/agent-session';
import { compareAgentsByActivity, tallyAgents } from '@/lib/agent-status';
import { cn } from '@/lib/utils';
import { type SubagentView, useFleetStore, useSessionStore, useUIStore } from '@/stores';
import { fmtCost, fmtElapsed as fmtDuration } from './dashboard-primitives.js';

const STATUS_CONFIG: Record<
  SubagentView['status'],
  { led: string; badge: string; labelKey: string }
> = {
  running: {
    led: 'bg-success led-pulse',
    badge: 'border-success/30 bg-success/10 text-success',
    labelKey: 'activity:fleet.statusRunning',
  },
  completed: {
    led: 'bg-success',
    badge: 'border-border bg-muted/40 text-muted-foreground',
    labelKey: 'activity:fleet.statusDone',
  },
  failed: {
    led: 'bg-destructive',
    badge: 'border-destructive/30 bg-destructive/10 text-destructive',
    labelKey: 'activity:fleet.statusFailed',
  },
  timeout: {
    led: 'bg-warning',
    badge: 'border-warning/30 bg-warning/10 text-warning',
    labelKey: 'activity:fleet.statusTimeout',
  },
  stopped: {
    led: 'bg-muted-foreground',
    badge: 'border-border bg-muted text-muted-foreground',
    labelKey: 'activity:fleet.statusStopped',
  },
};

/**
 * FleetPanel — clean, lightweight summary of running/completed subagents.
 * Provides instant status overview and one-click navigation to each agent's chat tab.
 */
export function FleetPanel({ className }: { className?: string }): React.ReactElement | null {
  const { t } = useAppTranslation();
  const agents = useFleetStore((s) => s.agents);
  const currentSessionId = useSessionStore((s) => s.session?.id);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const list = useMemo(() => {
    const arr = Array.from(agents.values()).filter((a) =>
      agentBelongsToSession(a.sessionId, currentSessionId),
    );
    arr.sort(compareAgentsByActivity);
    return arr;
  }, [agents, currentSessionId]);

  const handleCopy = useCallback(async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      // Ignore
    }
  }, []);

  const openAgentTab = useCallback((agentId: string) => {
    useUIStore.getState().setSubagentChatFocus(agentId);
    useUIStore.getState().setDockSection(null);
  }, []);

  if (list.length === 0) {
    return (
      <div className={cn('p-4 text-center text-xs text-muted-foreground', className)}>
        {t('activity:agents.noAgentsRunning')}
      </div>
    );
  }

  const tally = tallyAgents(list);
  const totalCost = list.reduce((sum, a) => sum + (a.costUsd ?? 0), 0);

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {/* ── Summary bar ── */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 bg-card/60 px-3 py-2 text-xs backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-primary shrink-0" />
          <span className="font-semibold">{t('activity:dock.fleet')}</span>
          <span className="text-muted-foreground">({list.length})</span>
        </div>
        <div className="flex items-center gap-2 text-[11px]">
          {tally.running > 0 && (
            <span className="inline-flex items-center gap-1 font-medium text-success">
              <span className="h-2 w-2 rounded-full bg-success animate-pulse" />
              {tally.running} {t('activity:fleet.statusRunning')}
            </span>
          )}
          {tally.completed > 0 && (
            <span className="text-muted-foreground">
              {tally.completed} {t('activity:fleet.statusDone')}
            </span>
          )}
          {tally.failed > 0 && (
            <span className="font-medium text-destructive">
              {tally.failed} {t('activity:fleet.statusFailed')}
            </span>
          )}
          {totalCost > 0 && (
            <span className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-foreground/80">
              {fmtCost(totalCost)}
            </span>
          )}
        </div>
      </div>

      {/* ── Agents list ── */}
      <div className="flex flex-col gap-2">
        {list.map((agent) => {
          const cfg = STATUS_CONFIG[agent.status] ?? STATUS_CONFIG.stopped;
          const elapsed = Date.now() - agent.startedAt;
          const currentTask = agent.description;

          return (
            <div
              key={agent.id}
              className="group flex flex-col gap-2 rounded-lg border border-border/70 bg-card/80 p-3 shadow-xs transition-colors hover:border-primary/40 hover:bg-card"
            >
              {/* Row 1: Status LED, Name, Model, Duration & Open Tab button */}
              <div className="flex items-center justify-between gap-2 min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={cn('h-2 w-2 rounded-full shrink-0', cfg.led)} />
                  <span className="truncate text-xs font-semibold text-foreground">
                    {agent.name}
                  </span>
                  {(agent.provider || agent.model) && (
                    <span className="hidden sm:inline-flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground truncate">
                      <Cpu className="h-3 w-3 shrink-0" />
                      {agent.model ?? agent.provider}
                    </span>
                  )}
                  <span
                    className={cn(
                      'rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider shrink-0',
                      cfg.badge,
                    )}
                  >
                    {t(cfg.labelKey)}
                  </span>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <span className="flex items-center gap-1 text-[11px] font-mono text-muted-foreground tabular-nums">
                    <Clock className="h-3 w-3" />
                    {fmtDuration(elapsed)}
                  </span>
                  <button
                    type="button"
                    onClick={() => openAgentTab(agent.id)}
                    className="inline-flex items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-2 py-1 text-xs font-medium text-primary hover:bg-primary/20 transition-colors cursor-pointer"
                    title="Open subagent chat tab"
                  >
                    <MessageSquare className="h-3 w-3" />
                    <span>Chat Tab</span>
                  </button>
                </div>
              </div>

              {/* Row 2: Task / Brief or current tool */}
              {currentTask ? (
                <p className="text-[11px] text-muted-foreground line-clamp-2 leading-relaxed">
                  {currentTask}
                </p>
              ) : null}

              {/* Row 3: Active Tool / Error / Quick Stats */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/40 pt-2 text-[11px]">
                <div className="flex items-center gap-2 min-w-0">
                  {agent.status === 'running' && (agent.currentTool || agent.lastTool) ? (
                    <span className="inline-flex items-center gap-1 text-primary font-mono text-[10px] bg-primary/10 px-1.5 py-0.5 rounded truncate">
                      <Wrench className="h-3 w-3 shrink-0 animate-pulse" />
                      {agent.currentTool ? agent.currentTool : `last: ${agent.lastTool}`}
                    </span>
                  ) : agent.error ? (
                    <span className="inline-flex items-center gap-1 text-destructive text-[10px] truncate">
                      <XCircle className="h-3 w-3 shrink-0" />
                      {agent.error.message}
                    </span>
                  ) : (
                    <span className="text-[10px] text-muted-foreground font-mono">
                      iter {agent.iteration} · {agent.toolCalls} tools
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2 ml-auto">
                  {agent.costUsd > 0 && (
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {fmtCost(agent.costUsd)}
                    </span>
                  )}
                  {agent.finalText && (
                    <button
                      type="button"
                      onClick={() => handleCopy(agent.id, agent.finalText!)}
                      className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted px-1.5 py-0.5 rounded transition-colors cursor-pointer"
                      title={t('activity:fleet.copyOutput')}
                    >
                      {copiedId === agent.id ? (
                        <Check className="h-3 w-3 text-success" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                      <span>
                        {copiedId === agent.id
                          ? t('common:action.copied')
                          : t('common:action.copy')}
                      </span>
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
