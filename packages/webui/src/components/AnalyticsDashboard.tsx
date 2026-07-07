/**
 * AnalyticsDashboard — live analytics view for the WebUI.
 *
 * Fetches from /api/analytics (event buffer), /api/sessions (session
 * registry), and the WS stats.get message to render a card-based
 * analytics overview with tool usage, cost, and event breakdowns.
 *
 * Usage: <AnalyticsDashboard /> — standalone, auto-polls every 10s.
 */
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Cpu,
  DollarSign,
  Loader2,
  MessageSquare,
  Terminal,
  TrendingUp,
  Users,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getWSClient } from '@/lib/ws-client';
import { useAppTranslation } from '@/i18n';
import { useConfigStore } from '@/stores';

// ── Types ─────────────────────────────────────────────────────────────

interface AnalyticsSummary {
  totalEvents: number;
  uniqueEvents: number;
  uniqueCategories: number;
  eventBreakdown: Record<string, number>;
  categoryBreakdown: Record<string, number>;
  oldestTimestamp: string | null;
  newestTimestamp: string | null;
}

interface AnalyticsEvent {
  event: string;
  category: string;
  label?: string;
  value?: number;
  metadata?: Record<string, unknown>;
  timestamp: string;
  sessionId?: string;
  userAgent?: string;
}

interface LiveAgent {
  id: string;
  name: string;
  status: string;
  currentTool?: string;
  iterations: number;
  toolCalls: number;
  lastActivityAt: string;
}

interface LiveSession {
  sessionId: string;
  projectName: string;
  status: string;
  pid: number;
  startedAt: string;
  agents: LiveAgent[];
}

interface StatsPayload {
  sessionId: string;
  provider: string;
  model: string;
  usage: { input: number; output: number; cacheRead?: number };
  cache: { hits: number; misses: number; ratio: number };
  cost: number;
  messages: number;
  readFiles: number;
  tools: number;
  sideEffectCount: number;
  elapsedMs: number;
}

// ── Helpers ────────────────────────────────────────────────────────────

function fmtDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ${min % 60}m`;
  return `${Math.floor(h / 24)}d`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtCost(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(2)}`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function eventColor(event: string): string {
  if (event.includes('error') || event.includes('fail')) return 'text-destructive';
  if (event.includes('warn')) return 'text-[hsl(var(--warning))]';
  if (event.includes('success') || event.includes('complete')) return 'text-[hsl(var(--success))]';
  return 'text-muted-foreground';
}

// ── Card wrappers ──────────────────────────────────────────────────────

function StatCard({
  icon,
  label,
  value,
  sub,
  color = 'text-muted-foreground',
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-border/70 bg-card/75 p-4 shadow-sm">
      <div className={`mt-0.5 ${color}`}>{icon}</div>
      <div className="min-w-0">
        <div className="text-2xl font-semibold tabular-nums text-foreground">{value}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">{label}</div>
        {sub ? <div className="mt-1 text-xs text-muted-foreground/70">{sub}</div> : null}
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────

export function AnalyticsDashboard() {
  const { t } = useAppTranslation();
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [events, setEvents] = useState<AnalyticsEvent[]>([]);
  const [sessions, setSessions] = useState<LiveSession[]>([]);
  const [stats, setStats] = useState<StatsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [statsLoading, setStatsLoading] = useState(false);
  const wsRef = useRef<ReturnType<typeof getWSClient> | null>(null);

  // Fetch from /api/analytics/summary
  const fetchSummary = useCallback(async () => {
    try {
      const res = await fetch('/api/analytics/summary');
      if (res.ok) {
        const data = (await res.json()) as AnalyticsSummary;
        setSummary(data);
      }
    } catch {
      // silently fail
    }
  }, []);

  // Fetch from /api/analytics
  const fetchEvents = useCallback(async () => {
    try {
      const res = await fetch('/api/analytics?limit=50');
      if (res.ok) {
        const data = (await res.json()) as { events: AnalyticsEvent[] };
        setEvents(data.events);
      }
    } catch {
      // silently fail
    }
  }, []);

  // Fetch from /api/sessions
  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch('/api/sessions');
      if (res.ok) {
        const data = (await res.json()) as LiveSession[];
        setSessions(data);
      }
    } catch {
      // silently fail
    }
  }, []);

  // Request stats.get via WS
  const fetchStats = useCallback(async () => {
    if (statsLoading) return;
    setStatsLoading(true);
    try {
      const ws = getWSClient(useConfigStore.getState().wsUrl);
      wsRef.current = ws;

      const cleanup = ws.on('stats.get', (msg: unknown) => {
        const payload = (msg as { payload: StatsPayload }).payload;
        setStats(payload);
        setStatsLoading(false);
        cleanup();
      });
      ws.getStats();

      // Timeout guard: remove listener after 8s so stale handlers don't pile up
      setTimeout(() => {
        setStatsLoading(false);
        cleanup();
      }, 8000);
    } catch {
      setStatsLoading(false);
    }
  }, [statsLoading]);

  // Poll all endpoints every 10s
  useEffect(() => {
    const load = () => {
      void Promise.all([fetchSummary(), fetchEvents(), fetchSessions(), fetchStats()]).finally(() =>
        setLoading(false),
      );
    };
    load();
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, [fetchSummary, fetchEvents, fetchSessions, fetchStats]);

  // Compute derived stats. Memoized to avoid redoing the reduce/sort work on
// every render — the inputs (sessions, summary) only change once per 10s poll.
  const { totalAgents, activeAgents, totalToolCalls, totalIterations } = useMemo(() => {
    let agents = 0;
    let active = 0;
    let tools = 0;
    let iters = 0;
    for (const s of sessions) {
      for (const a of s.agents) {
        agents++;
        if (a.status === 'running') active++;
        tools += a.toolCalls;
        iters += a.iterations;
      }
    }
    return { totalAgents: agents, activeAgents: active, totalToolCalls: tools, totalIterations: iters };
  }, [sessions]);

  // Top event categories for the breakdown (sorted by count)
  const categoryEntries = useMemo(
    () =>
      summary
        ? Object.entries(summary.categoryBreakdown).sort((a, b) => b[1] - a[1]).slice(0, 8)
        : [],
    [summary],
  );

  // Top event names
  const eventEntries = useMemo(
    () =>
      summary
        ? Object.entries(summary.eventBreakdown).sort((a, b) => b[1] - a[1]).slice(0, 10)
        : [],
    [summary],
  );

  // Health counters — error/warning event totals, derived from summary.
  const errorCount = useMemo(() => {
    if (!summary) return 0;
    let total = 0;
    for (const [k, v] of Object.entries(summary.eventBreakdown)) {
      if (k.toLowerCase().includes('error')) total += v;
    }
    return total;
  }, [summary]);

  const warningCount = useMemo(() => {
    if (!summary) return 0;
    let total = 0;
    for (const [k, v] of Object.entries(summary.eventBreakdown)) {
      if (k.toLowerCase().includes('warn')) total += v;
    }
    return total;
  }, [summary]);

  // Recent events reversed for display (newest first). Memoize to avoid
  // allocating a fresh array on every render.
  const reversedEvents = useMemo(() => [...events].reverse(), [events]);

  if (loading) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center bg-[hsl(var(--surface-2)/0.45)] p-4">
        <div className="ws-surface flex items-center gap-2 rounded-xl px-4 py-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          {t('activity:analytics.loading')}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 min-w-0 overflow-y-auto bg-[hsl(var(--surface-2)/0.45)] p-4 sm:p-6">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
      {/* ── Header ── */}
      <div className="rounded-xl border border-border/70 bg-card/75 p-4 shadow-sm">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-2">
            <BarChart3 className="h-4 w-4 text-primary" />
            <h1 className="truncate text-base font-semibold">
              {t('activity:analytics.heading')}
            </h1>
          </div>
          <span className="text-xs text-muted-foreground">{t('activity:analytics.autoRefresh')}</span>
        </div>
      </div>

      {/* ── Scrollable content ── */}
      <div className="min-w-0 space-y-5">
        {/* ── Row 1: Overview cards ── */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <StatCard
            icon={<Activity className="h-4 w-4" />}
            label={t('activity:analytics.liveSessions')}
            value={sessions.length}
            color="text-primary"
          />
          <StatCard
            icon={<Users className="h-4 w-4" />}
            label={t('activity:analytics.agents')}
            value={`${activeAgents}/${totalAgents}`}
            sub={activeAgents > 0 ? t('activity:analytics.agentsActive', { count: activeAgents }) : undefined}
            color="text-[hsl(var(--success))]"
          />
          <StatCard
            icon={<MessageSquare className="h-4 w-4" />}
            label={t('activity:analytics.totalEvents')}
            value={summary?.totalEvents ?? 0}
            sub={t('activity:analytics.categoriesSub', { count: summary?.uniqueCategories ?? 0 })}
            color="text-[hsl(var(--warning))]"
          />
          <StatCard
            icon={<Terminal className="h-4 w-4" />}
            label={t('activity:analytics.toolCalls')}
            value={totalToolCalls}
            sub={t('activity:analytics.iterationsSub', { count: totalIterations })}
            color="text-[hsl(var(--success))]"
          />
          <StatCard
            icon={<DollarSign className="h-4 w-4" />}
            label={t('activity:analytics.sessionCost')}
            value={stats ? fmtCost(stats.cost) : '—'}
            sub={stats ? t('activity:analytics.tokensSub', { input: fmtTokens(stats.usage.input), output: fmtTokens(stats.usage.output) }) : undefined}
            color="text-primary"
          />
          <StatCard
            icon={<Cpu className="h-4 w-4" />}
            label={t('activity:analytics.sessionDuration')}
            value={stats ? fmtDuration(stats.elapsedMs) : '—'}
            sub={stats ? t('activity:analytics.messagesSub', { count: stats.messages }) : undefined}
            color="text-muted-foreground"
          />
        </div>

        {/* ── Row 2: Breakdowns ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Category breakdown */}
          <div className="rounded-xl border border-border/70 bg-card/75 p-4 shadow-sm">
            <h3 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
              <TrendingUp className="h-3.5 w-3.5 text-primary" />
              {t('activity:analytics.eventsByCategory')}
            </h3>
            {categoryEntries.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('activity:analytics.noEvents')}</p>
            ) : (
              <div className="space-y-1.5">
                {categoryEntries.map(([cat, count]) => {
                  const maxCount = categoryEntries[0]?.[1] ?? 1;
                  const pct = Math.round((count / maxCount) * 100);
                  return (
                    <div key={cat} className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)_2.5rem] items-center gap-2 text-xs">
                      <span className="min-w-0 truncate text-foreground">{cat}</span>
                      <div className="h-4 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary/70 transition-all"
                          style={{ width: `${Math.max(pct, 4)}%` }}
                        />
                      </div>
                      <span className="text-right tabular-nums text-muted-foreground">{count}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Tool usage / Event breakdown */}
          <div className="rounded-xl border border-border/70 bg-card/75 p-4 shadow-sm">
            <h3 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
              <BarChart3 className="h-3.5 w-3.5 text-[hsl(var(--warning))]" />
              {t('activity:analytics.topEvents')}
            </h3>
            {eventEntries.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('activity:analytics.noEvents')}</p>
            ) : (
              <div className="space-y-1.5">
                {eventEntries.map(([evt, count]) => {
                  const maxCount = eventEntries[0]?.[1] ?? 1;
                  const pct = Math.round((count / maxCount) * 100);
                  return (
                    <div key={evt} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_2.5rem] items-center gap-2 text-xs">
                      <span className={`min-w-0 truncate ${eventColor(evt)}`}>{evt}</span>
                      <div className="h-4 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-[hsl(var(--warning)/0.7)] transition-all"
                          style={{ width: `${Math.max(pct, 4)}%` }}
                        />
                      </div>
                      <span className="text-right tabular-nums text-muted-foreground">{count}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* ── Row 3: Current session stats & error alert ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Session usage detail */}
          <div className="rounded-xl border border-border/70 bg-card/75 p-4 shadow-sm">
            <h3 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
              <DollarSign className="h-3.5 w-3.5 text-primary" />
              {t('activity:analytics.activeSessionUsage')}
            </h3>
            {stats ? (
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="min-w-0 rounded-lg border border-border/70 bg-background/50 px-3 py-2">
                  <span className="text-muted-foreground">{t('activity:analytics.provider')}</span>
                  <p className="mt-0.5 truncate font-mono text-foreground">{stats.provider}</p>
                </div>
                <div className="min-w-0 rounded-lg border border-border/70 bg-background/50 px-3 py-2">
                  <span className="text-muted-foreground">{t('activity:analytics.model')}</span>
                  <p className="mt-0.5 truncate font-mono text-foreground">{stats.model}</p>
                </div>
                <div className="rounded-lg border border-border/70 bg-background/50 px-3 py-2">
                  <span className="text-muted-foreground">{t('activity:analytics.inputTokens')}</span>
                  <p className="mt-0.5 tabular-nums text-foreground">{fmtTokens(stats.usage.input)}</p>
                </div>
                <div className="rounded-lg border border-border/70 bg-background/50 px-3 py-2">
                  <span className="text-muted-foreground">{t('activity:analytics.outputTokens')}</span>
                  <p className="mt-0.5 tabular-nums text-foreground">{fmtTokens(stats.usage.output)}</p>
                </div>
                <div className="rounded-lg border border-border/70 bg-background/50 px-3 py-2">
                  <span className="text-muted-foreground">{t('activity:analytics.cacheRatio')}</span>
                  <p className="mt-0.5 tabular-nums text-foreground">{(stats.cache.ratio * 100).toFixed(1)}%</p>
                </div>
                <div className="rounded-lg border border-border/70 bg-background/50 px-3 py-2">
                  <span className="text-muted-foreground">{t('activity:analytics.filesRead')}</span>
                  <p className="mt-0.5 tabular-nums text-foreground">{stats.readFiles}</p>
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">{t('activity:analytics.noSession')}</p>
            )}
          </div>

          {/* Error/warning indicator */}
          <div className="rounded-xl border border-border/70 bg-card/75 p-4 shadow-sm">
            <h3 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
              <AlertTriangle className="h-3.5 w-3.5 text-[hsl(var(--warning))]" />
              {t('activity:analytics.healthErrors')}
            </h3>
            <div className="space-y-2 text-xs">
              {summary ? (
                <>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('activity:analytics.errorEvents')}</span>
                    <span className="tabular-nums text-destructive">{errorCount}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('activity:analytics.warningEvents')}</span>
                    <span className="tabular-nums text-[hsl(var(--warning))]">{warningCount}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('activity:analytics.cacheHitRate')}</span>
                    <span className="tabular-nums text-[hsl(var(--success))]">
                      {stats ? `${(stats.cache.ratio * 100).toFixed(1)}%` : '—'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('activity:analytics.totalCategories')}</span>
                    <span className="tabular-nums text-foreground">{summary.uniqueCategories}</span>
                  </div>
                </>
              ) : (
                <p className="text-muted-foreground">{t('activity:analytics.waitingData')}</p>
              )}
            </div>
          </div>
        </div>

        {/* ── Row 4: Recent events stream ── */}
        <div className="rounded-xl border border-border/70 bg-card/75 p-4 shadow-sm">
          <h3 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
            <Activity className="h-3.5 w-3.5 text-primary" />
            {t('activity:analytics.recentEvents')}
          </h3>
          {events.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('activity:analytics.noRecentEvents')}</p>
          ) : (
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {reversedEvents.map((evt, i) => (
                <div
                  key={`${evt.timestamp}-${i}`}
                  className="grid grid-cols-[4rem_minmax(0,7rem)_minmax(0,6rem)_minmax(0,1fr)] items-start gap-2 rounded px-2 py-1 text-xs hover:bg-muted/60"
                >
                  <span className="tabular-nums text-muted-foreground/70">{fmtTime(evt.timestamp)}</span>
                  <span className={`min-w-0 truncate ${eventColor(evt.event)}`}>{evt.event}</span>
                  <span className="min-w-0 truncate text-muted-foreground">{evt.category}</span>
                  <span className="min-w-0 truncate text-foreground/80">{evt.label ?? evt.sessionId ?? ''}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}
