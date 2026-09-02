import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { useMonitorStore } from '@/stores';
import type { VizEvent } from '@/stores/viz-store';
import { Activity, Bot, Cpu, DollarSign, Hash, Monitor, Terminal, Users, Zap } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { feedColor } from './resolve.js';

export function StatsHUD() {
  const { t } = useAppTranslation();
  const { clientCounts, currentSession, totalAgents, activeAgents, aggregate } = useMonitorStore(
    useShallow((s) => ({
      clientCounts: s.clientCounts,
      currentSession: s.currentSession,
      totalAgents: s.totalAgents,
      activeAgents: s.activeAgents,
      aggregate: s.aggregate,
    })),
  );
  const totalClients = clientCounts.tui + clientCounts.webui + clientCounts.repl;
  const fmtNum = (n?: number) => n?.toLocaleString() ?? '0';
  const fmtCost = (n?: number) => (n != null ? `$${n.toFixed(4)}` : '$0.0000');

  return (
    <div className="absolute left-4 top-20 z-10 rounded-xl border border-border/70 bg-card/90 p-3 text-foreground shadow-xl backdrop-blur">
      <div className="flex items-center gap-2 mb-2">
        <Activity className="h-3.5 w-3.5 text-success" />
        <span className="text-[10px] font-bold uppercase text-muted-foreground">
          {t('activity:office.sessionStats')}
        </span>
      </div>

      <div className="space-y-1.5 text-[10px]">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-1.5">
            <Users className="h-3 w-3 text-muted-foreground" />
            <span className="text-muted-foreground">{t('activity:office.clients')}</span>
          </div>
          <span className="font-mono text-foreground">
            {activeAgents} <span className="text-muted-foreground">/</span>{' '}
            <span className="text-success">{totalClients}</span>
          </span>
        </div>

        <div className="flex items-center gap-3 pl-4 text-[9px]">
          {clientCounts.tui > 0 && (
            <span className="flex items-center gap-1">
              <Terminal className="h-2.5 w-2.5 text-success" />
              <span className="text-muted-foreground">{t('activity:hud.tui')}</span>
              <span className="font-mono text-success">{clientCounts.tui}</span>
            </span>
          )}
          {clientCounts.webui > 0 && (
            <span className="flex items-center gap-1">
              <Monitor className="h-2.5 w-2.5 text-primary" />
              <span className="text-muted-foreground">{t('activity:hud.webui')}</span>
              <span className="font-mono text-primary">{clientCounts.webui}</span>
            </span>
          )}
          {clientCounts.repl > 0 && (
            <span className="flex items-center gap-1">
              <Terminal className="h-2.5 w-2.5 text-warning" />
              <span className="text-muted-foreground">{t('activity:hud.repl')}</span>
              <span className="font-mono text-warning">{clientCounts.repl}</span>
            </span>
          )}
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-1.5">
            <Bot className="h-3 w-3 text-muted-foreground" />
            <span className="text-muted-foreground">{t('activity:officeMap.agents')}</span>
          </div>
          <span className="font-mono text-foreground">
            {activeAgents} <span className="text-muted-foreground">/</span>{' '}
            <span className="text-primary">{totalAgents}</span>
          </span>
        </div>

        {currentSession.model && (
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-1.5">
              <Cpu className="h-3 w-3 text-muted-foreground" />
              <span className="text-muted-foreground">{t('activity:officeMap.model')}</span>
            </div>
            <span
              className="max-w-[120px] truncate font-mono text-primary"
              title={currentSession.model}
            >
              {currentSession.model.split('/').pop()?.slice(0, 16)}
            </span>
          </div>
        )}

        {currentSession.mode && (
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-1.5">
              <Zap className="h-3 w-3 text-muted-foreground" />
              <span className="text-muted-foreground">{t('activity:officeMap.mode')}</span>
            </div>
            <span
              className={cn(
                'font-mono uppercase text-[9px] px-1.5 py-0.5 rounded',
                currentSession.mode === 'auto' && 'bg-primary/10 text-primary',
                currentSession.mode === 'suggest' && 'bg-success/10 text-success',
                currentSession.mode === 'off' && 'bg-muted text-muted-foreground',
                !['auto', 'suggest', 'off'].includes(currentSession.mode || '') &&
                  'bg-muted text-muted-foreground',
              )}
            >
              {currentSession.mode}
            </span>
          </div>
        )}

        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-1.5">
            <Hash className="h-3 w-3 text-muted-foreground" />
            <span className="text-muted-foreground">{t('activity:office.toolCallsLabel')}</span>
          </div>
          <span className="font-mono text-warning">{fmtNum(aggregate.toolCalls)}</span>
        </div>

        <div className="mt-1.5 space-y-1 border-t border-border/70 pt-1.5">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-1.5">
              <span className="text-[8px] text-muted-foreground">IN</span>
              <span className="text-muted-foreground">{t('activity:office.input')}</span>
            </div>
            <span className="font-mono text-[9px] text-foreground">
              {fmtNum(aggregate.tokensIn)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-1.5">
              <span className="text-[8px] text-muted-foreground">{t('activity:hud.out')}</span>
              <span className="text-muted-foreground">{t('activity:office.output')}</span>
            </div>
            <span className="font-mono text-[9px] text-foreground">
              {fmtNum(aggregate.tokensOut)}
            </span>
          </div>
        </div>

        <div className="mt-1.5 flex items-center justify-between gap-4 border-t border-border/70 pt-1.5">
          <div className="flex items-center gap-1.5">
            <DollarSign className="h-3 w-3 text-muted-foreground" />
            <span className="text-muted-foreground">{t('activity:office.cost')}</span>
          </div>
          <span className="font-mono font-medium text-success">{fmtCost(aggregate.costUsd)}</span>
        </div>
      </div>
    </div>
  );
}

export function LiveFeed({ events, now }: { events: VizEvent[]; now: number }) {
  const { t } = useAppTranslation();
  const recent = events.slice(0, 14);
  return (
    <div className="absolute bottom-0 left-0 right-0 z-10 pointer-events-none px-3 pb-3">
      <div className="pointer-events-auto mx-auto max-w-3xl rounded-lg border border-border/70 bg-card/90 px-3 py-2 shadow-xl backdrop-blur">
        <div className="mb-1.5 flex items-center gap-1.5 text-[10px] uppercase text-primary">
          <Activity className="h-3 w-3" />
          {t('activity:office.liveActivity')}
        </div>
        {recent.length === 0 ? (
          <div className="text-[11px] italic text-muted-foreground">
            {t('activity:office.waitingActivity')}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5 max-h-32 overflow-hidden">
            {recent.map((e) => {
              const ago = Math.max(0, Math.round((now - e.timestamp) / 1000));
              return (
                <div key={e.id} className="flex items-center gap-2 text-[11px] leading-tight">
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ backgroundColor: feedColor(e.kind) }}
                  />
                  <span className="flex-1 truncate text-foreground">{e.label}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {ago < 1 ? t('activity:office.now') : `${ago}s`}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
