import { TrendingUp } from 'lucide-react';
import { displayDecimal, useAppTranslation } from '../lib/i18n';

export interface FileWatcherMetrics {
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

/** Node's `process.memoryUsage()` and `process.cpuUsage()` readings, as the engine sends them. */
interface MemoryUsage {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}
interface CpuUsage {
  user: number;
  system: number;
}

export interface SystemMetrics {
  pid: number;
  memoryUsage: MemoryUsage;
  heapLimit: number;
  uptime: number;
  cpuUsage: CpuUsage;
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

export interface DebugData {
  fileWatcher: FileWatcherMetrics | null;
  system: SystemMetrics | null;
  lastUpdated: Date | null;
  error: string | null;
}

export function MetricCard({
  title,
  value,
  subtitle,
  icon: Icon,
  color = 'text-primary',
  trend,
}: {
  title: string;
  value: string | number;
  subtitle?: string | undefined;
  icon: React.ComponentType<{ className?: string }>;
  color?: string | undefined;
  trend?: 'up' | 'down' | 'neutral' | undefined;
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

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${displayDecimal(bytes / k ** i, 1)} ${sizes[i]}`;
}

export function formatByteRate(bytesPerHour: number | undefined): string {
  if (bytesPerHour === undefined) return '—';
  const sign = bytesPerHour > 0 ? '+' : bytesPerHour < 0 ? '−' : '';
  return `${sign}${formatBytes(Math.abs(bytesPerHour))}/h`;
}

export function formatUptime(seconds: number): string {
  if (seconds < 60) return `${displayDecimal(seconds, 0)}s`;
  if (seconds < 3600) return `${displayDecimal(seconds / 60, 1)}m`;
  return `${displayDecimal(seconds / 3600, 1)}h`;
}
