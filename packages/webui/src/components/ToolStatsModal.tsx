import { Bot, Clock, Layers, TriangleAlert, Wrench, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import {
  bucketSuccessRatio,
  LEADER_AGENT_KEY,
  sessionInFlight,
  type ToolStatsBucket,
  type ToolStatsSession,
  useHistoryStore,
  useToolStatsStore,
  useUIStore,
} from '@/stores';

interface ToolStatsModalProps {
  open: boolean;
  onClose: () => void;
}

interface ToolTotals {
  started: number;
  ok: number;
  failed: number;
  totalMs: number;
}

function emptyTotals(): ToolTotals {
  return { started: 0, ok: 0, failed: 0, totalMs: 0 };
}

function addBucket(totals: ToolTotals, bucket: ToolStatsBucket): void {
  totals.started += bucket.started;
  totals.ok += bucket.ok;
  totals.failed += bucket.failed;
  totals.totalMs += bucket.totalMs;
}

/** Completed-call success percentage, or null when nothing has completed yet. */
function successPct(ok: number, failed: number): number | null {
  const completed = ok + failed;
  return completed > 0 ? (ok / completed) * 100 : null;
}

function formatPct(pct: number | null): string {
  return pct === null ? '--' : `${pct.toFixed(0)}%`;
}

function formatMs(ms: number): string {
  if (ms <= 0) return '--';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Two-segment ok/failed bar; in-flight calls show as a muted remainder. */
function RatioBar({
  ok,
  failed,
  inFlight,
}: {
  ok: number;
  failed: number;
  inFlight: number;
}) {
  const total = Math.max(1, ok + failed + inFlight);
  return (
    <span className="relative inline-block h-2 w-full min-w-16 overflow-hidden rounded-full bg-muted/60 align-middle ring-1 ring-inset ring-border/20">
      <span
        className="absolute inset-y-0 left-0 bg-success transition-all duration-500"
        style={{ width: `${(ok / total) * 100}%` }}
      />
      <span
        className="absolute inset-y-0 bg-destructive transition-all duration-500"
        style={{ left: `${(ok / total) * 100}%`, width: `${(failed / total) * 100}%` }}
      />
    </span>
  );
}

function StatChip({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col rounded-lg border border-border/50 bg-muted/20 px-2.5 py-2">
      <span className="truncate text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className={cn('font-mono text-sm font-bold tabular-nums', tone)}>{value}</span>
    </div>
  );
}

function ToolRow({ name, bucket }: { name: string; bucket: ToolStatsBucket }) {
  const completed = bucket.ok + bucket.failed;
  const avg = completed > 0 ? bucket.totalMs / completed : 0;
  return (
    <div className="flex items-center gap-2 px-2 py-1 text-xs rounded hover:bg-muted/40 transition-colors">
      <Wrench className="h-3 w-3 shrink-0 text-muted-foreground" />
      <span className="font-mono truncate flex-1 min-w-0" title={name}>
        {name}
      </span>
      <span className="tabular-nums text-muted-foreground w-12 text-right">
        {bucket.started}×</span>
      <RatioBar ok={bucket.ok} failed={bucket.failed} inFlight={0} />
      <span className="tabular-nums text-success w-8 text-right">{bucket.ok}</span>
      <span className="tabular-nums text-destructive w-8 text-right">
        {bucket.failed}
      </span>
      <span className="tabular-nums text-muted-foreground w-14 text-right">
        {formatMs(avg)}
      </span>
    </div>
  );
}

/**
 * One-click tool-call statistics for every session the page has seen.
 *
 * Live section: per-tab aggregates collected from `tool.started`/`tool.executed`
 * WS events (leader calls + agent-attributed agent-to-agent calls) and
 * `delegate.*` outcomes. History section: closed sessions from the server
 * catalogue, which already tracks per-session call/error counts.
 */
export function ToolStatsModal({ open, onClose }: ToolStatsModalProps) {
  const { t } = useAppTranslation();
  const sessions = useToolStatsStore((s) => s.sessions);
  const nicknames = useUIStore((s) => s.sessionNicknames);
  const historyEntries = useHistoryStore((s) => s.entries);

  const [animateIn, setAnimateIn] = useState(false);
  useEffect(() => {
    if (!open) {
      setAnimateIn(false);
      return;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => setAnimateIn(true)));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const liveSessions = useMemo(
    () => Object.values(sessions).sort((a, b) => b.lastActivityAt - a.lastActivityAt),
    [sessions],
  );

  const totals = useMemo(() => {
    const acc = emptyTotals();
    let inFlight = 0;
    let delegations = 0;
    let delegationFailures = 0;
    for (const session of liveSessions) {
      for (const bucket of Object.values(session.perAgent)) addBucket(acc, bucket);
      inFlight += sessionInFlight(session);
      delegations += session.delegations.ok + session.delegations.failed;
      delegationFailures += session.delegations.failed;
    }
    return { ...acc, inFlight, delegations, delegationFailures };
  }, [liveSessions]);

  const pastSessions = useMemo(
    () =>
      historyEntries
        .filter((e) => !(e.id in sessions) && (e.toolCallCount ?? 0) > 0)
        .slice(0, 12),
    [historyEntries, sessions],
  );

  if (!open) return null;

  const hasLive = liveSessions.length > 0;
  const rate = successPct(totals.ok, totals.failed);

  return (
    <div
      className={cn(
        'fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm transition-opacity duration-200',
        animateIn ? 'opacity-100' : 'opacity-0',
      )}
      onClick={onClose}
      data-testid="tool-stats-modal"
    >
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/click-events-have-key-events -- backdrop click closes; content clicks stop propagation */}
      <section
        aria-label={t('chat:toolStats.title', 'Tool call statistics')}
        className={cn(
          'flex max-h-[82vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border/70 bg-card shadow-2xl transition-transform duration-200',
          animateIn ? 'scale-100' : 'scale-95',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
          <Wrench className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold">
            {t('chat:toolStats.title', 'Tool call statistics')}
          </h2>
          <span className="ml-auto text-[10px] text-muted-foreground">
            {t('chat:toolStats.liveScope', 'This page · live + closed sessions')}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            title={t('common:action.close', 'Close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto overscroll-contain p-4">
          {/* ── Aggregate strip ── */}
          <div className="flex gap-2">
            <StatChip
              label={t('chat:toolStats.calls', 'Calls')}
              value={totals.started.toLocaleString()}
            />
            <StatChip label={t('chat:toolStats.ok', 'Success')} value={`${totals.ok}`} tone="text-success" />
            <StatChip
              label={t('chat:toolStats.failed', 'Failed')}
              value={`${totals.failed}`}
              tone={totals.failed > 0 ? 'text-destructive' : undefined}
            />
            <StatChip
              label={t('chat:toolStats.successRate', 'Success rate')}
              value={formatPct(rate)}
              tone={rate !== null && rate < 80 ? 'text-warning' : 'text-success'}
            />
            {totals.inFlight > 0 && (
              <StatChip
                label={t('chat:toolStats.inFlight', 'In flight')}
                value={`${totals.inFlight}`}
                tone="text-info"
              />
            )}
            <StatChip
              label={t('chat:toolStats.totalDuration', 'Tool time')}
              value={formatMs(totals.totalMs)}
            />
          </div>
          <RatioBar
            ok={totals.ok}
            failed={totals.failed}
            inFlight={totals.inFlight}
          />

          {/* ── Live sessions (open tabs) ── */}
          <div>
            <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-foreground/80">
              <Layers className="h-3.5 w-3.5 text-primary" />
              {t('chat:toolStats.liveSessions', 'Open tabs')}
            </h3>
            {!hasLive ? (
              <p className="rounded-lg border border-border/40 bg-muted/20 px-3 py-4 text-center text-xs text-muted-foreground">
                {t(
                  'chat:toolStats.noLiveData',
                  'No tool calls recorded yet on this page. Run a prompt — stats appear here live, per tab.',
                )}
              </p>
            ) : (
              <div className="space-y-2">
                {liveSessions.map((session) => (
                  <SessionCard key={session.sessionId} session={session} label={sessionLabel(session.sessionId, nicknames)} />
                ))}
              </div>
            )}
          </div>

          {/* ── Closed sessions (server history catalogue) ── */}
          {pastSessions.length > 0 && (
            <div>
              <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-foreground/80">
                <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                {t('chat:toolStats.pastSessions', 'Earlier sessions')}
              </h3>
              <div className="space-y-0.5 rounded-lg border border-border/40 bg-muted/10 p-2">
                {pastSessions.map((entry) => {
                  const ok = Math.max(0, (entry.toolCallCount ?? 0) - (entry.toolErrorCount ?? 0));
                  const failed = entry.toolErrorCount ?? 0;
                  return (
                    <div
                      key={entry.id}
                      className="flex items-center gap-2 px-2 py-1 text-xs rounded hover:bg-muted/40 transition-colors"
                    >
                      <span className="truncate flex-1 min-w-0" title={entry.id}>
                        {entry.title || entry.id.slice(0, 8)}
                      </span>
                      <RatioBar ok={ok} failed={failed} inFlight={0} />
                      <span className="tabular-nums text-muted-foreground w-12 text-right">
                        {entry.toolCallCount}×
                      </span>
                      <span className="tabular-nums text-success w-8 text-right">{ok}</span>
                      <span className="tabular-nums text-destructive w-8 text-right">
                        {failed}
                      </span>
                      <span className="tabular-nums w-10 text-right font-mono text-muted-foreground">
                        {formatPct(successPct(ok, failed))}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function sessionLabel(sessionId: string, nicknames: Record<string, string>): string {
  const nickname = nicknames[sessionId];
  return nickname ?? `session ${sessionId.slice(0, 8)}`;
}

function SessionCard({ session, label }: { session: ToolStatsSession; label: string }) {
  const { t } = useAppTranslation();
  const tools = useMemo(
    () => Object.entries(session.perTool).sort(([, a], [, b]) => b.started - a.started),
    [session.perTool],
  );
  const agentEntries = useMemo(
    () => Object.entries(session.perAgent),
    [session.perAgent],
  );
  const agentToAgent = agentEntries.filter(([key]) => key !== LEADER_AGENT_KEY);
  const leader = session.perAgent[LEADER_AGENT_KEY];
  const totals = useMemo(() => {
    const acc = emptyTotals();
    for (const bucket of Object.values(session.perAgent)) addBucket(acc, bucket);
    return acc;
  }, [session.perAgent]);
  const inFlight = sessionInFlight(session);
  const d = session.delegations;

  return (
    <div className="rounded-lg border border-border/50 bg-muted/10 p-2.5">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="truncate text-xs font-semibold" title={session.sessionId}>
          {label}
        </span>
        {inFlight > 0 && (
          <span className="rounded bg-info/10 px-1.5 py-0.5 font-mono text-[10px] text-info">
            {t('chat:toolStats.running', '{{count}} running', { count: inFlight })}
          </span>
        )}
        <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
          {formatPct(successPct(totals.ok, totals.failed))} · {totals.ok}✓ {totals.failed}✗
        </span>
        <span className="w-24 shrink-0">
          <RatioBar ok={totals.ok} failed={totals.failed} inFlight={inFlight} />
        </span>
      </div>

      <div className="space-y-0.5">
        {tools.map(([name, bucket]) => (
          <ToolRow key={name} name={name} bucket={bucket} />
        ))}
      </div>

      {/* Agent-to-agent slice: agent-attributed calls + delegated runs */}
      {(agentToAgent.length > 0 || d.started > 0) && (
        <div className="mt-2 rounded border border-border/40 bg-background/40 p-2">
          <div className="mb-1 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            <Bot className="h-3 w-3" />
            {t('chat:toolStats.agentToAgent', 'Agent-to-agent')}
          </div>
          {agentToAgent.map(([agent, bucket]) => (
            <div
              key={agent}
              className="flex items-center gap-2 px-1 py-0.5 text-xs"
            >
              <Bot className="h-3 w-3 shrink-0 text-info" />
              <span className="font-mono truncate flex-1 min-w-0" title={agent}>
                {agent}
              </span>
              <RatioBar ok={bucket.ok} failed={bucket.failed} inFlight={0} />
              <span className="tabular-nums text-success w-8 text-right">{bucket.ok}</span>
              <span className="tabular-nums text-destructive w-8 text-right">
                {bucket.failed}
              </span>
            </div>
          ))}
          {d.started > 0 && (
            <div className="mt-1 flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
              <TriangleAlert
                className={cn('h-3 w-3', d.failed > 0 ? 'text-destructive' : 'text-success')}
              />
              {t('chat:toolStats.delegations', '{{count}} delegated run(s)', {
                count: d.ok + d.failed,
              })}
              {d.failed > 0 && (
                <span className="text-destructive">
                  {t('chat:toolStats.delegationFailed', '{{count}} failed', { count: d.failed })}
                </span>
              )}
              <span className="ml-auto tabular-nums">
                {t('chat:toolStats.delegateToolCalls', '{{count}} tools inside', {
                  count: d.toolCalls,
                })}
              </span>
            </div>
          )}
        </div>
      )}

      {leader && agentToAgent.length > 0 && (
        <p className="mt-1 px-1 text-[10px] text-muted-foreground/70">
          {t('chat:toolStats.leaderLine', 'Leader: {{ok}}✓ {{failed}}✗', {
            ok: leader.ok,
            failed: leader.failed,
          })}
        </p>
      )}
    </div>
  );
}
