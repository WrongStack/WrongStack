/**
 * FleetSummaryBar — compact per-session fleet metrics strip for the Agents sidebar.
 *
 * Displays a 2-line horizontal strip + compact event ticker:
 * - Line 1: running/completed/failed status counts with color-coded LEDs,
 *           total agent count, total cost
 * - Line 2: concurrency gauge, token in/out
 * - Line 3 (optional, when events exist): horizontal event ticker chips
 *
 * Spans the sidebar width and wraps gracefully at narrow widths.
 */

import { Crown } from 'lucide-react';
import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { fmtCost } from '@/components/dashboard-primitives';
import { ConcurrencyGauge } from '@/components/ui/concurrency-gauge';
import { useAppTranslation } from '@/i18n';
import { fmtTok } from '@/lib/agent-status';
import { cn } from '@/lib/utils';
import { openMainView } from '@/lib/view-navigation';
import { useActiveSessionId, useFleetStore, useSessionFleetTotals } from '@/stores';

export interface FleetSummaryBarProps {
  /** Optional CSS class for the wrapper. */
  className?: string;
  /** Session whose agents should be summarized. Undefined falls back to the active session. */
  sessionId?: string | undefined;
  /** Optional leader name shown as a badge. */
  leaderName?: string | undefined;
}

export function FleetSummaryBar({ className, sessionId, leaderName }: FleetSummaryBarProps) {
  const activeSessionId = useActiveSessionId();
  const targetSessionId = sessionId ?? activeSessionId ?? undefined;
  const sessionSummary = useSessionFleetTotals(targetSessionId);
  const fleetRuntime = useFleetStore(
    useShallow((s) => ({
      concurrencyMax: s.fleetConcurrencyMax,
      maxSpawns: s.fleetMaxSpawns,
      usedSpawns: s.fleetUsedSpawns,
      remainingSpawns: s.fleetRemainingSpawns,
      budgetSource: s.fleetBudgetSource,
      ceilingMismatch: s.fleetCeilingMismatch || undefined,
      checkpointMaxSpawns: s.fleetCheckpointMaxSpawns,
    })),
  );
  const recentEvents = useFleetStore(
    useShallow((s) =>
      s.eventTimeline
        .filter((ev) => {
          const agent = ev.agentId ? s.agents.get(ev.agentId) : undefined;
          return agent?.sessionId === targetSessionId;
        })
        .slice(0, 3),
    ),
  );
  const { t } = useAppTranslation();

  const summary = {
    ...sessionSummary,
    concurrency: sessionSummary.running,
    ...fleetRuntime,
  };
  const hasActivity = summary.total > 0;

  const openFleetInspector = useCallback(() => {
    openMainView('roster');
  }, []);

  return (
    <div
      data-testid="fleet-summary-bar"
      className={cn(
        'flex flex-col gap-0.5 border-b border-border/70 bg-muted/20 px-3 py-1.5 text-[10px]',
        className,
      )}
    >
      {/* Line 1: Status counts + total cost + leader badge */}
      <div className="flex items-center gap-2 min-w-0 flex-wrap">
        {/* Running */}
        <StatusLed
          label={String(summary.running)}
          ledClass="bg-success"
          pulse={summary.running > 0}
        />
        <span className="tabular-nums text-success count-transition">
          {t('activity:agents.runningCount', { count: summary.running })}
        </span>

        {/* Completed */}
        {summary.completed > 0 && (
          <>
            <span className="text-muted-foreground/50">·</span>
            <span className="tabular-nums text-muted-foreground count-transition">
              {summary.completed} done
            </span>
          </>
        )}

        {/* Failed + timeout */}
        {summary.failed > 0 && (
          <>
            <span className="text-muted-foreground/50">·</span>
            <StatusLed label={String(summary.failed)} ledClass="bg-destructive" pulse={false} />
          </>
        )}

        {/* Total count */}
        <span className="text-muted-foreground/50">·</span>
        <span className="tabular-nums text-muted-foreground count-transition">
          {t('activity:agents.totalCount', { count: summary.total })}
        </span>

        {/* Spacer */}
        <span className="flex-1 min-w-0" />

        {/* Total cost */}
        {summary.totalCost > 0 && (
          <span className="tabular-nums font-mono text-muted-foreground ml-auto shrink-0 count-transition">
            {fmtCost(summary.totalCost)}
          </span>
        )}

        {/* Leader badge */}
        {leaderName && (
          <span className="inline-flex items-center gap-0.5 rounded border border-warning/30 bg-warning/10 px-1 py-0.5 text-[9px] font-medium text-warning shrink-0">
            <Crown className="h-2.5 w-2.5" />
            {leaderName}
          </span>
        )}
      </div>

      {/* Line 2: Concurrency + tokens + lifetime spawn budget */}
      {(hasActivity || summary.maxSpawns !== undefined) && (
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <ConcurrencyGauge current={summary.concurrency} max={summary.concurrencyMax} showLabel />

          {summary.maxSpawns !== undefined && summary.usedSpawns !== undefined && (
            <>
              <span className="text-muted-foreground/50">·</span>
              <span
                className={cn(
                  'tabular-nums font-mono count-transition',
                  summary.ceilingMismatch ? 'text-warning' : 'text-muted-foreground',
                )}
                title={
                  summary.ceilingMismatch && summary.checkpointMaxSpawns !== undefined
                    ? `Checkpoint maxSpawns was ${summary.checkpointMaxSpawns}; live ceiling is ${summary.maxSpawns}${summary.budgetSource ? ` (${summary.budgetSource})` : ''}`
                    : summary.budgetSource
                      ? `Lifetime spawns · ${summary.budgetSource}`
                      : 'Lifetime spawn budget'
                }
              >
                spawns {summary.usedSpawns}/
                {Number.isFinite(summary.maxSpawns) ? summary.maxSpawns : '∞'}
                {summary.remainingSpawns !== undefined
                  ? ` (${Number.isFinite(summary.remainingSpawns) ? summary.remainingSpawns : '∞'} left)`
                  : ''}
              </span>
            </>
          )}

          {summary.tokensIn + summary.tokensOut > 0 && (
            <>
              <span className="text-muted-foreground/50">·</span>
              <span className="tabular-nums font-mono text-muted-foreground count-transition">
                {'\u2193'}
                {fmtTok(summary.tokensIn)} {'\u2191'}
                {fmtTok(summary.tokensOut)}
              </span>
            </>
          )}
        </div>
      )}

      {/* Line 3: Event ticker — 3 most recent fleet events */}
      {recentEvents.length > 0 && (
        <div className="flex items-center gap-1 min-w-0 overflow-x-auto no-scrollbar">
          {recentEvents.map((ev) => (
            <button
              key={ev.id}
              type="button"
              onClick={openFleetInspector}
              className="inline-flex items-center gap-1 shrink-0 rounded border border-border/50 bg-background/40 px-1.5 py-0.5 text-[9px] text-muted-foreground cursor-pointer hover:bg-accent/50 hover:text-foreground transition-colors"
              title={ev.message}
              aria-label={`${KIND_LABEL[ev.kind] ?? ev.kind}: ${ev.message}`}
            >
              <EventKindDot kind={ev.kind} />
              {KIND_LABEL[ev.kind] ?? ev.kind}
            </button>
          ))}
        </div>
      )}

      {/* Empty state — show only if no agents */}
      {!hasActivity && (
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-muted-foreground italic">
            {t('activity:fleetSummaryBar.fleetIdle')}
          </span>
        </div>
      )}
    </div>
  );
}

/** Small colored dot with an adjacent label. */
function StatusLed({
  label,
  ledClass,
  pulse,
}: {
  label: string;
  ledClass: string;
  pulse: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1 shrink-0">
      <span className={cn('led h-1.5 w-1.5', ledClass, pulse && 'led-pulse')} aria-hidden="true" />
      <span className="tabular-nums font-medium">{label}</span>
    </span>
  );
}

const KIND_LABEL: Record<string, string> = {
  spawned: 'spawned',
  task_started: 'started',
  tool_executed: 'tool',
  iteration_summary: 'iter',
  budget_warning: 'budget',
  budget_extended: 'extended',
  task_completed: 'done',
  ctx_pct: 'ctx',
  leader_updated: 'leader',
};

const KIND_COLORS: Record<string, string> = {
  spawned: 'bg-primary',
  task_started: 'bg-info',
  tool_executed: 'bg-warning',
  iteration_summary: 'bg-muted-foreground',
  budget_warning: 'bg-destructive',
  budget_extended: 'bg-warning',
  task_completed: 'bg-success',
  ctx_pct: 'bg-muted-foreground',
  leader_updated: 'bg-warning',
};

function EventKindDot({ kind }: { kind: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block h-1.5 w-1.5 rounded-full shrink-0',
        KIND_COLORS[kind] ?? 'bg-muted-foreground',
      )}
    />
  );
}
