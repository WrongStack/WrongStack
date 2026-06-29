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
  if (event.includes('error') || event.includes('fail')) return 'text-red-400';
  if (event.includes('warn')) return 'text-amber-400';
  if (event.includes('success') || event.includes('complete')) return 'text-emerald-400';
  return 'text-slate-400';
}

// ── Card wrappers ──────────────────────────────────────────────────────

function StatCard({
  icon,
  label,
  value,
  sub,
  color = 'text-slate-300',
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4 flex items-start gap-3">
      <div className={`mt-0.5 ${color}`}>{icon}</div>
      <div className="min-w-0">
        <div className="text-2xl font-semibold tabular-nums text-slate-100">{value}</div>
        <div className="text-xs text-slate-500 mt-0.5">{label}</div>
        {sub ? <div className="text-xs text-slate-600 mt-1">{sub}</div> : null}
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────

export function AnalyticsDashboard() {
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
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
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
      <div className="flex items-center gap-2 p-4 text-slate-400">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading analytics...
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* ── Header ── */}
      <div className="shrink-0 px-4 pt-3 pb-2 border-b border-slate-700/50">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-cyan-400" />
            <h1 className="text-sm font-semibold text-slate-200 uppercase tracking-wider">
              Analytics Dashboard
            </h1>
          </div>
          <span className="text-xs text-slate-600">auto-refresh every 10s</span>
        </div>
      </div>

      {/* ── Scrollable content ── */}
      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        {/* ── Row 1: Overview cards ── */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <StatCard
            icon={<Activity className="h-4 w-4" />}
            label="Live Sessions"
            value={sessions.length}
            color="text-cyan-400"
          />
          <StatCard
            icon={<Users className="h-4 w-4" />}
            label="Agents"
            value={`${activeAgents}/${totalAgents}`}
            sub={activeAgents > 0 ? `${activeAgents} active` : undefined}
            color="text-blue-400"
          />
          <StatCard
            icon={<MessageSquare className="h-4 w-4" />}
            label="Total Events"
            value={summary?.totalEvents ?? 0}
            sub={`${summary?.uniqueCategories ?? 0} categories`}
            color="text-violet-400"
          />
          <StatCard
            icon={<Terminal className="h-4 w-4" />}
            label="Tool Calls"
            value={totalToolCalls}
            sub={`${totalIterations} iterations`}
            color="text-emerald-400"
          />
          <StatCard
            icon={<DollarSign className="h-4 w-4" />}
            label="Session Cost"
            value={stats ? fmtCost(stats.cost) : '—'}
            sub={stats ? `${fmtTokens(stats.usage.input)} in / ${fmtTokens(stats.usage.output)} out` : undefined}
            color="text-amber-400"
          />
          <StatCard
            icon={<Cpu className="h-4 w-4" />}
            label="Session Duration"
            value={stats ? fmtDuration(stats.elapsedMs) : '—'}
            sub={stats ? `${stats.messages} messages` : undefined}
            color="text-rose-400"
          />
        </div>

        {/* ── Row 2: Breakdowns ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Category breakdown */}
          <div className="rounded-lg border border-slate-700 bg-slate-800/30 p-4">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-2">
              <TrendingUp className="h-3.5 w-3.5 text-cyan-400" />
              Events by Category
            </h3>
            {categoryEntries.length === 0 ? (
              <p className="text-slate-600 text-xs">No events recorded yet.</p>
            ) : (
              <div className="space-y-1.5">
                {categoryEntries.map(([cat, count]) => {
                  const maxCount = categoryEntries[0]?.[1] ?? 1;
                  const pct = Math.round((count / maxCount) * 100);
                  return (
                    <div key={cat} className="flex items-center gap-2 text-xs">
                      <span className="w-28 shrink-0 truncate text-slate-300">{cat}</span>
                      <div className="flex-1 h-4 bg-slate-700/50 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-cyan-500/60 rounded-full transition-all"
                          style={{ width: `${Math.max(pct, 4)}%` }}
                        />
                      </div>
                      <span className="w-10 text-right tabular-nums text-slate-400">{count}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Tool usage / Event breakdown */}
          <div className="rounded-lg border border-slate-700 bg-slate-800/30 p-4">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-2">
              <BarChart3 className="h-3.5 w-3.5 text-violet-400" />
              Top Events
            </h3>
            {eventEntries.length === 0 ? (
              <p className="text-slate-600 text-xs">No events recorded yet.</p>
            ) : (
              <div className="space-y-1.5">
                {eventEntries.map(([evt, count]) => {
                  const maxCount = eventEntries[0]?.[1] ?? 1;
                  const pct = Math.round((count / maxCount) * 100);
                  return (
                    <div key={evt} className="flex items-center gap-2 text-xs">
                      <span className={`w-36 shrink-0 truncate ${eventColor(evt)}`}>{evt}</span>
                      <div className="flex-1 h-4 bg-slate-700/50 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-violet-500/60 rounded-full transition-all"
                          style={{ width: `${Math.max(pct, 4)}%` }}
                        />
                      </div>
                      <span className="w-10 text-right tabular-nums text-slate-400">{count}</span>
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
          <div className="rounded-lg border border-slate-700 bg-slate-800/30 p-4">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-2">
              <DollarSign className="h-3.5 w-3.5 text-amber-400" />
              Active Session Usage
            </h3>
            {stats ? (
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <span className="text-slate-500">Provider</span>
                  <p className="text-slate-200 font-mono mt-0.5">{stats.provider}</p>
                </div>
                <div>
                  <span className="text-slate-500">Model</span>
                  <p className="text-slate-200 font-mono mt-0.5">{stats.model}</p>
                </div>
                <div>
                  <span className="text-slate-500">Input Tokens</span>
                  <p className="text-slate-200 tabular-nums mt-0.5">{fmtTokens(stats.usage.input)}</p>
                </div>
                <div>
                  <span className="text-slate-500">Output Tokens</span>
                  <p className="text-slate-200 tabular-nums mt-0.5">{fmtTokens(stats.usage.output)}</p>
                </div>
                <div>
                  <span className="text-slate-500">Cache Ratio</span>
                  <p className="text-slate-200 tabular-nums mt-0.5">{(stats.cache.ratio * 100).toFixed(1)}%</p>
                </div>
                <div>
                  <span className="text-slate-500">Files Read</span>
                  <p className="text-slate-200 tabular-nums mt-0.5">{stats.readFiles}</p>
                </div>
              </div>
            ) : (
              <p className="text-slate-600 text-xs">No active session or waiting for data&hellip;</p>
            )}
          </div>

          {/* Error/warning indicator */}
          <div className="rounded-lg border border-slate-700 bg-slate-800/30 p-4">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-2">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
              Health &amp; Errors
            </h3>
            <div className="space-y-2 text-xs">
              {summary ? (
                <>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Error events</span>
                    <span className="text-red-400 tabular-nums">{errorCount}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Warning events</span>
                    <span className="text-amber-400 tabular-nums">{warningCount}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Cache hit rate</span>
                    <span className="text-emerald-400 tabular-nums">
                      {stats ? `${(stats.cache.ratio * 100).toFixed(1)}%` : '—'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Total categories</span>
                    <span className="text-slate-300 tabular-nums">{summary.uniqueCategories}</span>
                  </div>
                </>
              ) : (
                <p className="text-slate-600">Waiting for data&hellip;</p>
              )}
            </div>
          </div>
        </div>

        {/* ── Row 4: Recent events stream ── */}
        <div className="rounded-lg border border-slate-700 bg-slate-800/30 p-4">
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-2">
            <Activity className="h-3.5 w-3.5 text-cyan-400" />
            Recent Events
          </h3>
          {events.length === 0 ? (
            <p className="text-slate-600 text-xs">No recent events. Interact with the UI to generate events.</p>
          ) : (
            <div className="max-h-64 overflow-y-auto space-y-1">
              {reversedEvents.map((evt, i) => (
                <div
                  key={`${evt.timestamp}-${i}`}
                  className="flex items-start gap-2 py-1 px-2 rounded hover:bg-slate-700/30 text-xs"
                >
                  <span className="text-slate-600 tabular-nums shrink-0 w-16">{fmtTime(evt.timestamp)}</span>
                  <span className={`shrink-0 w-24 truncate ${eventColor(evt.event)}`}>{evt.event}</span>
                  <span className="text-slate-500 shrink-0 w-20 truncate">{evt.category}</span>
                  <span className="text-slate-400 truncate">{evt.label ?? evt.sessionId ?? ''}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
