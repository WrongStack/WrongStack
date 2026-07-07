/**
 * SessionsDashboard — live session viewer for the WebUI.
 *
 * Fetches GET /api/sessions every 5s when the hosting server exposes that API
 * and renders every active WrongStack session across processes, with per-agent
 * status, git branch, working directory, and elapsed time.
 *
 * Usage: <SessionsDashboard /> — standalone, no store dependencies.
 */
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Clock,
  Cpu,
  FolderGit2,
  Loader2,
  PauseCircle,
  Radio,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { i18n, useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';

// ── Types ─────────────────────────────────────────────────────────────

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
  projectSlug: string;
  projectRoot?: string;
  workingDir: string;
  gitBranch?: string;
  status: string;
  pid: number;
  startedAt: string;
  agentCount: number;
  agents: LiveAgent[];
}

export async function sessionApiError(res: Response): Promise<string> {
  try {
    const body = (await res.clone().json()) as { error?: unknown; message?: unknown };
    const message = typeof body.error === 'string' ? body.error : body.message;
    if (typeof message === 'string' && message.trim()) return message;
  } catch {
    try {
      const text = await res.text();
      if (text.trim()) return text.trim();
    } catch {
      // fall through to status text
    }
  }
  return res.statusText || `HTTP ${res.status}`;
}

// ── Helpers ────────────────────────────────────────────────────────────

function agentMeta(status: string): { icon: React.ReactNode; cls: string } {
  switch (status) {
    case 'running':
      return {
        icon: <Activity className="h-3.5 w-3.5" />,
        cls: 'text-[hsl(var(--success))]',
      };
    case 'streaming':
      return {
        icon: <Radio className="h-3.5 w-3.5" />,
        cls: 'text-primary',
      };
    case 'waiting_user':
      return {
        icon: <Clock className="h-3.5 w-3.5" />,
        cls: 'text-[hsl(var(--warning))]',
      };
    case 'error':
      return {
        icon: <AlertCircle className="h-3.5 w-3.5" />,
        cls: 'text-destructive',
      };
    case 'idle':
      return {
        icon: <PauseCircle className="h-3.5 w-3.5" />,
        cls: 'text-muted-foreground',
      };
    default:
      return {
        icon: <CheckCircle2 className="h-3.5 w-3.5" />,
        cls: 'text-muted-foreground',
      };
  }
}

function sessionMeta(status: string): { icon: React.ReactNode; cls: string; badge: string } {
  switch (status) {
    case 'active':
      return {
        icon: <Wifi className="h-3.5 w-3.5" />,
        cls: 'text-[hsl(var(--success))]',
        badge: 'border-[hsl(var(--success)/0.25)] bg-[hsl(var(--success)/0.08)] text-[hsl(var(--success))]',
      };
    case 'idle':
      return {
        icon: <WifiOff className="h-3.5 w-3.5" />,
        cls: 'text-primary',
        badge: 'border-primary/25 bg-primary/10 text-primary',
      };
    case 'closing':
      return {
        icon: <Clock className="h-3.5 w-3.5" />,
        cls: 'text-[hsl(var(--warning))]',
        badge: 'border-[hsl(var(--warning)/0.25)] bg-[hsl(var(--warning)/0.1)] text-[hsl(var(--warning))]',
      };
    default:
      return {
        icon: <WifiOff className="h-3.5 w-3.5" />,
        cls: 'text-muted-foreground',
        badge: 'border-border bg-muted text-muted-foreground',
      };
  }
}

function fmtDuration(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return '<1m';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ${min % 60}m`;
  return `${Math.floor(h / 24)}d`;
}

function fmtTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 10) return i18n.t('common:time.justNow');
  if (sec < 60) return i18n.t('common:time.secondsAgo', { count: sec });
  const min = Math.floor(sec / 60);
  if (min < 60) return i18n.t('common:time.minutesAgo', { count: min });
  return i18n.t('common:time.hoursAgo', { count: Math.floor(min / 60) });
}

// ── Component ──────────────────────────────────────────────────────────

export function SessionsDashboard() {
  const { t } = useAppTranslation();
  const [sessions, setSessions] = useState<LiveSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch('/api/sessions');
      if (!res.ok) {
        if (res.status === 404) {
          // API not available — server might be running without session support
          setError(null);
          setSessions([]);
          return;
        }
        throw new Error(`HTTP ${res.status}: ${await sessionApiError(res)}`);
      }
      const contentType = res.headers.get('content-type')?.toLowerCase() ?? '';
      if (!contentType.includes('application/json')) {
        // Vite/static preview servers answer unknown /api routes with index.html.
        // Treat that as "live sessions API absent" instead of surfacing a JSON
        // parser error to the user.
        setError(null);
        setSessions([]);
        return;
      }
      const data = (await res.json()) as unknown;
      if (!Array.isArray(data)) {
        setError(null);
        setSessions([]);
        return;
      }
      setSessions(data as LiveSession[]);
      setError(null);
    } catch (err) {
      if (err instanceof SyntaxError) {
        setError(null);
        setSessions([]);
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchSessions();
    const t = setInterval(fetchSessions, 5000);
    return () => clearInterval(t);
  }, [fetchSessions]);

  const activeSessions = sessions.filter((s) => s.status === 'active').length;
  const totalAgents = sessions.reduce((sum, s) => sum + s.agentCount, 0);

  if (loading) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center bg-[hsl(var(--surface-2)/0.45)] p-4">
        <div className="ws-surface flex items-center gap-2 rounded-xl px-4 py-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          {t('activity:liveSessions.loading')}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center bg-[hsl(var(--surface-2)/0.45)] p-4">
        <div className="ws-surface max-w-lg rounded-xl p-5 text-center">
          <AlertCircle className="mx-auto h-8 w-8 text-[hsl(var(--warning))]" />
          <p className="mt-3 text-sm font-medium">{t('activity:liveSessions.apiUnavailable')}</p>
          <p className="mt-1 break-words text-xs text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center bg-[hsl(var(--surface-2)/0.45)] p-4">
        <div className="ws-surface max-w-md rounded-xl p-6 text-center text-muted-foreground">
          <WifiOff className="mx-auto h-9 w-9 opacity-50" />
          <p className="mt-3 text-sm font-medium text-foreground">{t('activity:liveSessions.empty')}</p>
          <p className="mt-1 text-xs">{t('activity:liveSessions.autoRefresh')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-[hsl(var(--surface-2)/0.45)] p-4 sm:p-6">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
        <header className="rounded-xl border border-border/70 bg-card/75 p-4 shadow-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Wifi className="h-4 w-4 text-primary" />
                <h2 className="text-base font-semibold">
                  {t('activity:liveSessions.heading', { count: sessions.length })}
                </h2>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('activity:liveSessions.autoRefresh')}
              </p>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center sm:min-w-[22rem]">
              <div className="rounded-lg border border-border/70 bg-background/60 px-3 py-2">
                <div className="text-lg font-semibold tabular-nums">{sessions.length}</div>
                <div className="text-[10px] uppercase text-muted-foreground">Sessions</div>
              </div>
              <div className="rounded-lg border border-border/70 bg-background/60 px-3 py-2">
                <div className="text-lg font-semibold tabular-nums text-[hsl(var(--success))]">
                  {activeSessions}
                </div>
                <div className="text-[10px] uppercase text-muted-foreground">Active</div>
              </div>
              <div className="rounded-lg border border-border/70 bg-background/60 px-3 py-2">
                <div className="text-lg font-semibold tabular-nums">{totalAgents}</div>
                <div className="text-[10px] uppercase text-muted-foreground">Agents</div>
              </div>
            </div>
          </div>
        </header>

        <div className="grid gap-3">
          {sessions.map((s) => {
            const meta = sessionMeta(s.status);
            return (
              <article
                key={s.sessionId}
                className="rounded-xl border border-border/70 bg-card/75 p-3 shadow-sm sm:p-4"
              >
                <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className={meta.cls}>{meta.icon}</span>
                      <h3 className="min-w-0 truncate text-sm font-semibold" title={s.projectName}>
                        {s.projectName}
                      </h3>
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                        {s.projectSlug}
                      </span>
                      <span
                        className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${meta.badge}`}
                      >
                        {s.status}
                      </span>
                    </div>

                    <div className="mt-2 grid gap-1.5 text-xs text-muted-foreground md:grid-cols-[minmax(0,1fr)_auto]">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <Cpu className="h-3.5 w-3.5 shrink-0" />
                        <span className="min-w-0 truncate font-mono" title={s.workingDir}>
                          {s.workingDir}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {s.gitBranch ? (
                          <span className="inline-flex min-w-0 max-w-full items-center gap-1 text-primary">
                            <FolderGit2 className="h-3.5 w-3.5 shrink-0" />
                            <span className="truncate font-mono">{s.gitBranch}</span>
                          </span>
                        ) : null}
                        <span className="inline-flex items-center gap-1">
                          <Clock className="h-3.5 w-3.5" />
                          {fmtDuration(s.startedAt)}
                        </span>
                        <span className="font-mono">{t('activity:liveSessions.pidLabel', { pid: s.pid })}</span>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3 lg:w-64">
                    <div className="rounded-lg border border-border/70 bg-background/50 px-2 py-1.5">
                      <div className="text-[10px] text-muted-foreground">Agents</div>
                      <div className="font-semibold tabular-nums">{s.agentCount}</div>
                    </div>
                    <div className="rounded-lg border border-border/70 bg-background/50 px-2 py-1.5">
                      <div className="text-[10px] text-muted-foreground">Status</div>
                      <div className="truncate font-mono font-semibold">{s.status}</div>
                    </div>
                    <div className="rounded-lg border border-border/70 bg-background/50 px-2 py-1.5">
                      <div className="text-[10px] text-muted-foreground">Runtime</div>
                      <div className="font-mono font-semibold">{fmtDuration(s.startedAt)}</div>
                    </div>
                  </div>
                </div>

                <div className="mt-3 overflow-hidden rounded-lg border border-border/70 bg-background/45">
                  {s.agents.length === 0 ? (
                    <div className="px-3 py-3 text-xs text-muted-foreground">
                      {t('activity:liveSessions.noAgents')}
                    </div>
                  ) : (
                    <div className="divide-y divide-border/60">
                      {s.agents.slice(0, 5).map((a) => {
                        const agent = agentMeta(a.status);
                        return (
                          <div
                            key={a.id}
                            className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 px-3 py-2 text-xs sm:grid-cols-[auto_minmax(0,1fr)_minmax(0,14rem)_auto]"
                          >
                            <span className={cn('mt-0.5 shrink-0', agent.cls)}>{agent.icon}</span>
                            <div className="min-w-0">
                              <div className="truncate font-medium" title={a.name}>{a.name}</div>
                              <div className="font-mono text-[10px] text-muted-foreground">
                                {t('activity:liveSessions.agentMeta', {
                                  iter: a.iterations,
                                  tools: a.toolCalls,
                                  ago: fmtTimeAgo(a.lastActivityAt),
                                })}
                              </div>
                            </div>
                            <div className="min-w-0 font-mono text-[10px] text-muted-foreground sm:text-xs">
                              {a.currentTool ? (
                                <span className="block truncate" title={a.currentTool}>{a.currentTool}</span>
                              ) : (
                                <span className="text-muted-foreground/60">{a.status}</span>
                              )}
                            </div>
                            <span className="hidden font-mono text-[10px] text-muted-foreground sm:block">
                              {fmtTimeAgo(a.lastActivityAt)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {s.agents.length > 5 ? (
                    <div className="border-t border-border/60 px-3 py-2 text-xs text-muted-foreground">
                      {t('activity:liveSessions.andMore', { count: s.agents.length - 5 })}
                    </div>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
}
