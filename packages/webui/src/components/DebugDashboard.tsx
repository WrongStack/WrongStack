import { useCallback, useEffect, useState } from 'react';
import { useScrollPosition } from '@/hooks/useScrollPosition';
import { useAppTranslation, i18n } from '@/i18n';
import { Activity, AlertCircle, BarChart3, Clock, Eye, FileWarning, Gauge, RefreshCw, Server, TrendingUp } from 'lucide-react';

interface FileWatcherMetrics {
  fileChangesDetected: number;
  filesProcessed: number;
  broadcastsSent: number;
  debounceResets: number;
  totalDebounceDelayMs: number;
  activeProjects: number;
  averageDebounceDelayMs: number;
  watcherActive: boolean;
  timestamp: number;
}

interface SystemMetrics {
  pid: number;
  memoryUsage: NodeJS.MemoryUsage;
  heapLimit: number;
  uptime: number;
  cpuUsage: NodeJS.CpuUsage;
  codebaseIndexServer?: {
    status: string;
    connected: boolean;
    pid?: number | undefined;
    health?: {
      status: string;
      latencyMs: number | null;
      missedHeartbeats: number;
      server?: {
        uptimeMs: number;
        memory: { rss: number; heapUsed: number; heapTotal: number };
        clients: number;
        activeRequests: number;
        activeWrites: number;
        queuedWrites: number;
        pendingExternalFiles: number;
        watchingExternal: boolean;
        watchingClients?: number | undefined;
        clientLeaseTimeoutMs?: number | undefined;
        oldestClientIdleMs?: number | undefined;
      } | undefined;
    } | undefined;
  } | undefined;
  timestamp: number;
}

interface DebugData {
  fileWatcher: FileWatcherMetrics | null;
  system: SystemMetrics | null;
  lastUpdated: Date | null;
  error: string | null;
}

function MetricCard({
  title,
  value,
  subtitle,
  icon: Icon,
  color = 'text-primary',
  trend,
}: {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: React.ComponentType<{ className?: string }>;
  color?: string;
  trend?: 'up' | 'down' | 'neutral';
}) {
  const { t } = useAppTranslation();
  return (
    <div className="rounded-xl border border-border/70 bg-card/75 p-4 shadow-sm">
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground font-medium">{title}</p>
          <p className={`mt-1 truncate text-xl font-semibold tabular-nums sm:text-2xl ${color}`}>{value}</p>
          {subtitle && <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>}
        </div>
        <div className={`shrink-0 rounded-lg bg-muted/70 p-2 ${color}`}>
          <Icon className="w-5 h-5" />
        </div>
      </div>
      {trend && (
        <div className="mt-2 flex items-center gap-1">
          {trend === 'up' && <TrendingUp className="w-3 h-3 text-success" />}
          {trend === 'down' && <TrendingUp className="w-3 h-3 rotate-180 text-destructive" />}
          <span className="text-xs text-muted-foreground">
            {trend === 'up' ? t('activity:debug.trendUp') : trend === 'down' ? t('activity:debug.trendDown') : t('activity:debug.trendStable')}
          </span>
        </div>
      )}
    </div>
  );
}

function _StatusBadge({ active }: { active: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium ${
        active ? 'bg-success/12 text-success' : 'bg-destructive/10 text-destructive'
      }`}
    >
      <span className={`w-2 h-2 rounded-full ${active ? 'bg-success' : 'bg-destructive'}`} />
      {active ? 'Active' : 'Inactive'}
    </span>
  );
}

export function DebugDashboard() {
  const { t } = useAppTranslation();
  const [data, setData] = useState<DebugData>({
    fileWatcher: null,
    system: null,
    lastUpdated: null,
    error: null,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [refreshInterval, setRefreshInterval] = useState<number>(2000);

  const fetchMetrics = useCallback(async () => {
    try {
      const [watcherRes, systemRes] = await Promise.all([
        fetch('/debug/watcher-metrics'),
        fetch('/debug/system', { cache: 'no-store' }),
      ]);
      let watcherData: FileWatcherMetrics | null = null;
      const watcherContentType = watcherRes.headers.get('content-type') ?? '';
      if (watcherRes.ok && watcherContentType.includes('application/json')) {
        watcherData = await watcherRes.json();
      }

      if (!systemRes.ok) throw new Error(`System metrics request failed (${systemRes.status})`);
      const systemData = (await systemRes.json()) as SystemMetrics;

      setData({
        fileWatcher: watcherData,
        system: systemData,
        lastUpdated: new Date(),
        error: null,
      });
    } catch (err) {
      setData((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : i18n.t('activity:debug.fetchFailed'),
      }));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMetrics();
    const interval = setInterval(fetchMetrics, refreshInterval);
    return () => clearInterval(interval);
  }, [fetchMetrics, refreshInterval]);

  const handleRefresh = () => {
    setIsLoading(true);
    void fetchMetrics();
  };

  return (
    <div ref={useScrollPosition('debug')} className="h-full min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain bg-[hsl(var(--surface-2)/0.45)] p-4 sm:p-6">
      <div className="mx-auto flex max-w-7xl flex-col gap-5">
        {/* Header */}
        <div className="rounded-xl border border-border/70 bg-card/75 p-4 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <h1 className="flex items-center gap-2 text-lg font-semibold sm:text-xl">
              <BarChart3 className="h-5 w-5 text-primary" />
              {t('activity:debug.heading')}
            </h1>
              <p className="mt-1 text-sm text-muted-foreground">
              {t('activity:debug.subtitle')}
            </p>
          </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <label className="flex min-w-0 items-center gap-2 text-sm">
              <RefreshCw className="w-4 h-4 text-muted-foreground" />
              <span className="shrink-0 text-muted-foreground">{t('activity:debug.refreshLabel')}</span>
              <select
                value={refreshInterval}
                onChange={(e) => setRefreshInterval(Number(e.target.value))}
                className="h-9 rounded-md border border-border/70 bg-background/70 px-2 text-sm"
              >
                <option value={1000}>1s</option>
                <option value={2000}>2s</option>
                <option value={5000}>5s</option>
                <option value={10000}>10s</option>
              </select>
            </label>
            <button type="button"
              onClick={handleRefresh}
              disabled={isLoading}
                className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground shadow-sm shadow-primary/15 hover:bg-primary/90 disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
              {t('common:action.refresh')}
            </button>
            </div>
          </div>
        </div>

        {/* Last Updated */}
        {data.lastUpdated && (
          <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-card/55 px-3 py-2 text-sm text-muted-foreground">
            <Clock className="w-4 h-4" />
            {t('activity:debug.lastUpdated', { time: data.lastUpdated.toLocaleTimeString() })}
          </div>
        )}

        {/* Error Display */}
        {data.error && (
          <div className="flex items-center gap-3 rounded-xl border border-destructive/25 bg-destructive/10 p-4 text-destructive">
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
            <div>
              <p className="font-medium">{t('activity:debug.fetchFailed')}</p>
              <p className="text-sm opacity-80">{data.error}</p>
            </div>
          </div>
        )}

        {/* File Watcher Section */}
        <section>
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
            <Eye className="h-4 w-4 text-primary" />
            {t('activity:debug.fileWatcher')}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <MetricCard
              title={t('activity:debug.watcherStatus')}
              value={data.fileWatcher?.watcherActive ? t('activity:debug.running') : t('activity:debug.stopped')}
              icon={Server}
              color={data.fileWatcher?.watcherActive ? 'text-success' : 'text-destructive'}
            />
            <MetricCard
              title={t('activity:debug.activeProjects')}
              value={data.fileWatcher?.activeProjects ?? 0}
              subtitle={t('activity:debug.projectsWatched')}
              icon={FileWarning}
              color="text-primary"
            />
            <MetricCard
              title={t('activity:debug.fileChanges')}
              value={data.fileWatcher?.fileChangesDetected ?? 0}
              subtitle={t('activity:debug.totalDetected')}
              icon={Activity}
              color="text-primary"
              trend="neutral"
            />
            <MetricCard
              title={t('activity:debug.filesProcessed')}
              value={data.fileWatcher?.filesProcessed ?? 0}
              subtitle={t('activity:debug.afterHash')}
              icon={Gauge}
              color="text-success"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mt-4">
            <MetricCard
              title={t('activity:debug.broadcastsSent')}
              value={data.fileWatcher?.broadcastsSent ?? 0}
              subtitle={t('activity:debug.toClients')}
              icon={TrendingUp}
              color="text-success"
            />
            <MetricCard
              title={t('activity:debug.debounceResets')}
              value={data.fileWatcher?.debounceResets ?? 0}
              subtitle={t('activity:debug.rapidWrites')}
              icon={RefreshCw}
              color="text-warning"
            />
            <MetricCard
              title={t('activity:debug.avgDebounce')}
              value={`${(data.fileWatcher?.averageDebounceDelayMs ?? 0).toFixed(1)}ms`}
              subtitle={t('activity:debug.actualDelay')}
              icon={Clock}
              color="text-warning"
            />
            <MetricCard
              title={t('activity:debug.totalDelay')}
              value={`${(data.fileWatcher?.totalDebounceDelayMs ?? 0).toFixed(0)}ms`}
              subtitle={t('activity:debug.sumDelays')}
              icon={BarChart3}
              color="text-primary"
            />
          </div>
        </section>

        {/* WebUI server process section */}
        <section>
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
            <Gauge className="h-4 w-4 text-primary" />
            WebUI Server Process
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <MetricCard
              title="Process RAM (RSS)"
              value={formatBytes(data.system?.memoryUsage?.rss ?? 0)}
              subtitle={data.system ? `PID ${data.system.pid}` : undefined}
              icon={Server}
              color="text-primary"
            />
            <MetricCard
              title={t('activity:debug.heapUsed')}
              value={formatBytes(data.system?.memoryUsage?.heapUsed ?? 0)}
              subtitle={t('activity:debug.jsHeap')}
              icon={BarChart3}
              color="text-primary"
            />
            <MetricCard
              title={t('activity:debug.heapTotal')}
              value={formatBytes(data.system?.memoryUsage?.heapTotal ?? 0)}
              subtitle={t('activity:debug.totalHeap')}
              icon={BarChart3}
              color="text-success"
            />
            <MetricCard
              title="V8 Heap Limit"
              value={formatBytes(data.system?.heapLimit ?? 0)}
              subtitle="Configured old-space ceiling"
              icon={Gauge}
              color="text-warning"
            />
            <MetricCard
              title="Server Uptime"
              value={formatUptime(data.system?.uptime ?? 0)}
              subtitle="Since process start"
              icon={Clock}
              color="text-primary"
            />
          </div>
        </section>

        {/* Detached codebase-index process section */}
        <section>
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
            <Server className="h-4 w-4 text-primary" />
            Codebase Index Server
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <MetricCard
              title="Connection"
              value={
                data.system?.codebaseIndexServer?.health?.status ??
                data.system?.codebaseIndexServer?.status ??
                'unknown'
              }
              subtitle={
                data.system?.codebaseIndexServer?.pid
                  ? `PID ${data.system.codebaseIndexServer.pid} · RTT ${data.system.codebaseIndexServer.health?.latencyMs ?? '—'}ms`
                  : 'No connected project server'
              }
              icon={Activity}
              color={
                data.system?.codebaseIndexServer?.health?.status === 'healthy'
                  ? 'text-success'
                  : data.system?.codebaseIndexServer?.status === 'unresponsive' ||
                      data.system?.codebaseIndexServer?.status === 'error'
                    ? 'text-destructive'
                    : 'text-warning'
              }
            />
            <MetricCard
              title="Index RAM (RSS)"
              value={formatBytes(
                data.system?.codebaseIndexServer?.health?.server?.memory.rss ?? 0,
              )}
              subtitle={`Heap ${formatBytes(data.system?.codebaseIndexServer?.health?.server?.memory.heapUsed ?? 0)} / ${formatBytes(data.system?.codebaseIndexServer?.health?.server?.memory.heapTotal ?? 0)}`}
              icon={BarChart3}
              color="text-primary"
            />
            <MetricCard
              title="Index Workload"
              value={`${data.system?.codebaseIndexServer?.health?.server?.activeRequests ?? 0} requests`}
              subtitle={`${data.system?.codebaseIndexServer?.health?.server?.activeWrites ?? 0} writes · ${data.system?.codebaseIndexServer?.health?.server?.queuedWrites ?? 0} queued`}
              icon={Gauge}
              color="text-primary"
            />
            <MetricCard
              title="Index Watcher"
              value={
                data.system?.codebaseIndexServer?.health?.server?.watchingExternal
                  ? 'Active'
                  : 'Off'
              }
              subtitle={`${data.system?.codebaseIndexServer?.health?.server?.watchingClients ?? 0} owners · ${data.system?.codebaseIndexServer?.health?.server?.pendingExternalFiles ?? 0} pending`}
              icon={Eye}
              color={
                data.system?.codebaseIndexServer?.health?.server?.watchingExternal
                  ? 'text-success'
                  : 'text-muted-foreground'
              }
            />
          </div>
        </section>

        {/* Raw JSON Section */}
        <section>
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
            <Activity className="h-4 w-4 text-primary" />
            {t('activity:debug.rawData')}
          </h2>
          <div className="rounded-xl border border-border/70 bg-card/75 p-4 shadow-sm">
            <pre className="overflow-x-auto text-xs font-mono text-muted-foreground">
              {JSON.stringify(
                {
                  fileWatcher: data.fileWatcher,
                  serverPid: data.system?.pid,
                  serverMemory: data.system?.memoryUsage,
                  serverHeapLimit: data.system?.heapLimit,
                  serverUptime: data.system?.uptime,
                  codebaseIndexServer: data.system?.codebaseIndexServer,
                },
                null,
                2,
              )}
            </pre>
          </div>
        </section>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / k ** i).toFixed(1)} ${sizes[i]}`;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}
