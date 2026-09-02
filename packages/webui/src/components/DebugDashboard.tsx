import {
  Activity,
  AlertCircle,
  BarChart3,
  Clock,
  Eye,
  FileWarning,
  Gauge,
  RefreshCw,
  Server,
  TrendingUp,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useScrollPosition } from '@/hooks/useScrollPosition';
import { i18n, useAppTranslation } from '@/i18n';

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

interface ProcessMemoryDiagnostic {
  pid: number;
  surface: string;
  sessionId?: string | undefined;
  ts: string;
  memory: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
    retainedHeapUsed?: number | undefined;
    nativeResidual?: number | undefined;
    external?: number | undefined;
    arrayBuffers?: number | undefined;
  };
  signal?: string | undefined;
  heapGrowthBytesPerHour?: number | undefined;
  rssGrowthBytesPerHour?: number | undefined;
  workload: {
    messages?: number | undefined;
    messageEstimatedTokens?: number | undefined;
    historyEntries?: number | undefined;
    historyMountedEntries?: number | undefined;
    historyCachedGroups?: number | undefined;
    appRenders?: number | undefined;
    metricsDroppedObservations?: number | undefined;
    kanbanSyncActive?: boolean | undefined;
    kanbanSyncPendingBoards?: number | undefined;
    kanbanSyncFullRescanPending?: boolean | undefined;
    kanbanSyncRemoteApplyQueued?: boolean | undefined;
    kanbanSyncPendingRemoteBoards?: number | undefined;
    kanbanSyncPublishRuns?: number | undefined;
    kanbanSyncCoalescedRefreshes?: number | undefined;
    kanbanSupervisorSnapshots?: number | undefined;
    kanbanSupervisorScheduledBoards?: number | undefined;
    kanbanSupervisorAgentCooldowns?: number | undefined;
    kanbanSupervisorRunningAgents?: number | undefined;
  };
  resources: {
    active?: number | undefined;
    types?: string | undefined;
  };
  hqQueue?:
    | {
        entries: number;
        bytes: number;
        maxBytes: number;
        droppedFrames: number;
        droppedBytes: number;
        coalescedFrames: number;
        coalescedBytes: number;
      }
    | undefined;
  hqSnapshot?:
    | {
        inFlight: boolean;
        pending: boolean;
        timerScheduled: boolean;
        eventInFlight: boolean;
        pendingEvents: number;
        coalescedEvents: number;
        droppedEvents: number;
      }
    | undefined;
  profileTopStack?: string | undefined;
  profileTopStackBytes?: number | undefined;
}

interface SystemMetrics {
  pid: number;
  memoryUsage: NodeJS.MemoryUsage;
  heapLimit: number;
  uptime: number;
  cpuUsage: NodeJS.CpuUsage;
  codebaseIndexServer?:
    | {
        status: string;
        connected: boolean;
        pid?: number | undefined;
        health?:
          | {
              status: string;
              latencyMs: number | null;
              missedHeartbeats: number;
              server?:
                | {
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
                  }
                | undefined;
            }
          | undefined;
      }
    | undefined;
  processes?: ProcessMemoryDiagnostic[] | undefined;
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
          <p className={`mt-1 truncate text-xl font-semibold tabular-nums sm:text-2xl ${color}`}>
            {value}
          </p>
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
            {trend === 'up'
              ? t('activity:debug.trendUp')
              : trend === 'down'
                ? t('activity:debug.trendDown')
                : t('activity:debug.trendStable')}
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
    <div
      ref={useScrollPosition('debug')}
      className="h-full min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain bg-[hsl(var(--surface-2)/0.45)] p-4 sm:p-6"
    >
      <div className="mx-auto flex max-w-7xl flex-col gap-5">
        {/* Header */}
        <div className="rounded-xl border border-border/70 bg-card/75 p-4 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <h1 className="flex items-center gap-2 text-lg font-semibold sm:text-xl">
                <BarChart3 className="h-5 w-5 text-primary" />
                {t('activity:debug.heading')}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">{t('activity:debug.subtitle')}</p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <label className="flex min-w-0 items-center gap-2 text-sm">
                <RefreshCw className="w-4 h-4 text-muted-foreground" />
                <span className="shrink-0 text-muted-foreground">
                  {t('activity:debug.refreshLabel')}
                </span>
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
              <button
                type="button"
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
              value={
                data.fileWatcher?.watcherActive
                  ? t('activity:debug.running')
                  : t('activity:debug.stopped')
              }
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
            {t('activity:debugDash.webuiServerProcess')}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <MetricCard
              title={t('activity:debugDash.processRamRss')}
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
              title={t('activity:debugDash.v8HeapLimit')}
              value={formatBytes(data.system?.heapLimit ?? 0)}
              subtitle={t('activity:debugDash.oldSpaceCeiling')}
              icon={Gauge}
              color="text-warning"
            />
            <MetricCard
              title={t('activity:debugDash.serverUptime')}
              value={formatUptime(data.system?.uptime ?? 0)}
              subtitle={t('activity:debugDash.sinceProcessStart')}
              icon={Clock}
              color="text-primary"
            />
          </div>
        </section>

        {/* Cross-process flight recorder: newest heap sample per PID. */}
        <section>
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
            <Activity className="h-4 w-4 text-primary" />
            {t('activity:debugDash.liveWrongstackProcesses')}
          </h2>
          <div className="overflow-x-auto rounded-xl border border-border/70 bg-card/75 shadow-sm">
            <table className="w-full min-w-[980px] text-left text-xs">
              <thead className="border-b border-border/70 bg-muted/35 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">{t('activity:debugDash.surface')}</th>
                  <th className="px-3 py-2 font-medium">{t('activity:debugDash.memory')}</th>
                  <th className="px-3 py-2 font-medium">{t('activity:debugDash.growthSignal')}</th>
                  <th className="px-3 py-2 font-medium">{t('activity:debugDash.workload')}</th>
                  <th className="px-3 py-2 font-medium">
                    {t('activity:debugDash.hqOfflineQueue')}
                  </th>
                  <th className="px-3 py-2 font-medium">
                    {t('activity:debugDash.resourcesHotspot')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {(data.system?.processes ?? []).map((processSample) => {
                  const workload = [
                    processSample.workload.messages !== undefined
                      ? `${processSample.workload.messages} msgs`
                      : undefined,
                    processSample.workload.messageEstimatedTokens !== undefined
                      ? `${processSample.workload.messageEstimatedTokens.toLocaleString()} ctx tokens`
                      : undefined,
                    processSample.workload.historyEntries !== undefined
                      ? `${processSample.workload.historyMountedEntries ?? 0}/${processSample.workload.historyEntries} history mounted`
                      : undefined,
                    processSample.workload.appRenders !== undefined
                      ? `${processSample.workload.appRenders} renders`
                      : undefined,
                    processSample.workload.metricsDroppedObservations
                      ? `${processSample.workload.metricsDroppedObservations} metric drops`
                      : undefined,
                    processSample.workload.kanbanSyncActive ? 'kanban sync active' : undefined,
                    processSample.workload.kanbanSyncPendingBoards
                      ? `${processSample.workload.kanbanSyncPendingBoards} kanban pending`
                      : undefined,
                    processSample.workload.kanbanSyncFullRescanPending
                      ? 'kanban full rescan pending'
                      : undefined,
                    processSample.workload.kanbanSyncRemoteApplyQueued
                      ? `${processSample.workload.kanbanSyncPendingRemoteBoards ?? 0} remote boards queued`
                      : undefined,
                    processSample.workload.kanbanSyncCoalescedRefreshes
                      ? `${processSample.workload.kanbanSyncCoalescedRefreshes} kanban coalesced`
                      : undefined,
                    processSample.workload.kanbanSupervisorSnapshots
                      ? `${processSample.workload.kanbanSupervisorSnapshots} supervised boards`
                      : undefined,
                    processSample.workload.kanbanSupervisorScheduledBoards
                      ? `${processSample.workload.kanbanSupervisorScheduledBoards} supervisor schedules`
                      : undefined,
                  ]
                    .filter(Boolean)
                    .join(' · ');
                  return (
                    <tr
                      key={processSample.pid}
                      className="border-b border-border/50 align-top last:border-b-0"
                    >
                      <td className="px-3 py-3">
                        <div className="font-medium text-foreground">{processSample.surface}</div>
                        <div className="mt-1 text-muted-foreground">PID {processSample.pid}</div>
                        <div className="text-muted-foreground">
                          {new Date(processSample.ts).toLocaleTimeString()}
                        </div>
                      </td>
                      <td className="px-3 py-3 tabular-nums">
                        <div>RSS {formatBytes(processSample.memory.rss)}</div>
                        <div className="text-muted-foreground">
                          heap {formatBytes(processSample.memory.heapUsed)}
                          {processSample.memory.retainedHeapUsed !== undefined
                            ? ` · retained ${formatBytes(processSample.memory.retainedHeapUsed)}`
                            : ''}
                        </div>
                        {processSample.memory.nativeResidual !== undefined ? (
                          <div className="text-muted-foreground">
                            native {formatBytes(processSample.memory.nativeResidual)}
                          </div>
                        ) : null}
                        {processSample.memory.external !== undefined ? (
                          <div className="text-muted-foreground">
                            external {formatBytes(processSample.memory.external)}
                            {processSample.memory.arrayBuffers !== undefined
                              ? ` · buffers ${formatBytes(processSample.memory.arrayBuffers)}`
                              : ''}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-3 py-3 tabular-nums">
                        <div
                          className={
                            processSample.signal === 'stable'
                              ? 'text-success'
                              : processSample.signal
                                ? 'text-warning'
                                : 'text-muted-foreground'
                          }
                        >
                          {processSample.signal ?? 'sampling'}
                        </div>
                        <div className="mt-1 text-muted-foreground">
                          heap {formatByteRate(processSample.heapGrowthBytesPerHour)}
                        </div>
                        <div className="text-muted-foreground">
                          RSS {formatByteRate(processSample.rssGrowthBytesPerHour)}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-muted-foreground">{workload || '—'}</td>
                      <td className="px-3 py-3 tabular-nums">
                        {processSample.hqQueue ? (
                          <>
                            <div>
                              {processSample.hqQueue.entries} frames ·{' '}
                              {formatBytes(processSample.hqQueue.bytes)} /{' '}
                              {formatBytes(processSample.hqQueue.maxBytes)}
                            </div>
                            <div className="mt-1 text-muted-foreground">
                              {processSample.hqQueue.coalescedFrames} coalesced ·{' '}
                              {processSample.hqQueue.droppedFrames} dropped
                            </div>
                            {processSample.hqSnapshot ? (
                              <>
                                <div className="text-muted-foreground">
                                  snapshot{' '}
                                  {processSample.hqSnapshot.inFlight
                                    ? 'in-flight'
                                    : processSample.hqSnapshot.pending
                                      ? 'pending'
                                      : processSample.hqSnapshot.timerScheduled
                                        ? 'scheduled'
                                        : 'idle'}
                                </div>
                                <div className="text-muted-foreground">
                                  events{' '}
                                  {processSample.hqSnapshot.eventInFlight ? 'in-flight' : 'idle'} ·{' '}
                                  {processSample.hqSnapshot.pendingEvents} pending ·{' '}
                                  {processSample.hqSnapshot.coalescedEvents} coalesced ·{' '}
                                  {processSample.hqSnapshot.droppedEvents} dropped
                                </div>
                              </>
                            ) : null}
                          </>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="max-w-[360px] px-3 py-3 text-muted-foreground">
                        <div>
                          {processSample.resources.active ?? 0} active
                          {processSample.resources.types
                            ? ` · ${processSample.resources.types}`
                            : ''}
                        </div>
                        {processSample.profileTopStack ? (
                          <div className="mt-1 truncate" title={processSample.profileTopStack}>
                            {processSample.profileTopStackBytes !== undefined
                              ? `${formatBytes(processSample.profileTopStackBytes)} · `
                              : ''}
                            {processSample.profileTopStack}
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
                {(data.system?.processes?.length ?? 0) === 0 ? (
                  <tr>
                    <td className="px-3 py-5 text-muted-foreground" colSpan={6}>
                      {t('activity:debugDash.waitingForHeapFlightRecorderSamples')}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>

        {/* Detached codebase-index process section */}
        <section>
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
            <Server className="h-4 w-4 text-primary" />
            {t('activity:debugDash.codebaseIndexServer')}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <MetricCard
              title={t('activity:debugDash.connection')}
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
              title={t('activity:debugDash.indexRamRss')}
              value={formatBytes(data.system?.codebaseIndexServer?.health?.server?.memory.rss ?? 0)}
              subtitle={`Heap ${formatBytes(data.system?.codebaseIndexServer?.health?.server?.memory.heapUsed ?? 0)} / ${formatBytes(data.system?.codebaseIndexServer?.health?.server?.memory.heapTotal ?? 0)}`}
              icon={BarChart3}
              color="text-primary"
            />
            <MetricCard
              title={t('activity:debugDash.indexWorkload')}
              value={`${data.system?.codebaseIndexServer?.health?.server?.activeRequests ?? 0} requests`}
              subtitle={`${data.system?.codebaseIndexServer?.health?.server?.activeWrites ?? 0} writes · ${data.system?.codebaseIndexServer?.health?.server?.queuedWrites ?? 0} queued`}
              icon={Gauge}
              color="text-primary"
            />
            <MetricCard
              title={t('activity:debugDash.indexWatcher')}
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
                  processes: data.system?.processes,
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

function formatByteRate(bytesPerHour: number | undefined): string {
  if (bytesPerHour === undefined) return '—';
  const sign = bytesPerHour > 0 ? '+' : bytesPerHour < 0 ? '−' : '';
  return `${sign}${formatBytes(Math.abs(bytesPerHour))}/h`;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}
