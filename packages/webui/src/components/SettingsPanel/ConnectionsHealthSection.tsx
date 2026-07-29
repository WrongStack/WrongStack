import {
  Activity,
  CheckCircle2,
  CircleOff,
  Database,
  HardDrive,
  KanbanSquare,
  Mail,
  MemoryStick,
  RefreshCw,
  RotateCcw,
  Server,
  TriangleAlert,
  Wifi,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores';
import type {
  ConnectionHealthService,
  ConnectionsHealthReport,
  ServiceActionResult,
  WSServerMessage,
} from '@/types';
import { Button } from '../ui/button';

const REFRESH_INTERVAL_MS = 15_000;

export function ConnectionsHealthSection() {
  const { t } = useAppTranslation();
  const { client } = useWebSocket();
  const wsConnected = useConfigStore((state) => state.wsConnected);
  const [report, setReport] = useState<ConnectionsHealthReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingActions, setPendingActions] = useState<Set<string>>(new Set());
  const [actionFeedback, setActionFeedback] = useState<
    Record<string, { success: boolean; message: string } | null>
  >({});

  const refresh = useCallback(() => {
    if (!wsConnected || !client) {
      setLoading(false);
      setError(t('settings:connection.healthDisconnected'));
      return;
    }
    if (!client.supportsCapability('connections.health')) {
      setLoading(false);
      setError(t('settings:connection.healthRestartRequired'));
      return;
    }
    setLoading(true);
    setError(null);
    client.send({ type: 'connections.health' });
  }, [client, t, wsConnected]);

  const handleServiceAction = useCallback(
    (serviceId: string, action: 'shutdown' | 'restart') => {
      if (!client || !wsConnected) return;
      setPendingActions((prev) => new Set(prev).add(serviceId));
      setActionFeedback((prev) => ({ ...prev, [serviceId]: null }));
      client.send({ type: 'connections.service_action', payload: { serviceId, action } });
    },
    [client, wsConnected],
  );

  useEffect(() => {
    if (!client) return;
    const offResult = client.on('connections.health_result', (message: WSServerMessage) => {
      if (message.type !== 'connections.health_result') return;
      setReport(message.payload);
      setLoading(false);
      setError(null);
    });
    const offError = client.on('connections.health_error', (message: WSServerMessage) => {
      if (message.type !== 'connections.health_error') return;
      setLoading(false);
      setError(message.payload.message);
    });
    const offActionResult = client.on(
      'connections.service_action_result',
      (message: WSServerMessage) => {
        if (message.type !== 'connections.service_action_result') return;
        const result = message.payload as ServiceActionResult;
        setPendingActions((prev) => {
          const next = new Set(prev);
          next.delete(result.serviceId ?? '');
          return next;
        });
        setActionFeedback((prev) => ({
          ...prev,
          [result.serviceId ?? '']: { success: result.success, message: result.message },
        }));
        // Auto-clear feedback after 5s
        const timer = window.setTimeout(() => {
          setActionFeedback((prev) => ({
            ...prev,
            [result.serviceId ?? '']: null,
          }));
        }, 5_000);
        // Auto-refresh health after action
        void refresh();
        return () => window.clearTimeout(timer);
      },
    );
    refresh();
    const timer = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      offResult();
      offError();
      offActionResult();
    };
  }, [client, refresh]);

  const services = useMemo<ConnectionHealthService[]>(() => {
    if (report) return report.services;
    if (!error) return [];
    return [
      {
        id: 'webui',
        label: 'WebUI transport',
        status: wsConnected ? 'degraded' : 'error',
        required: true,
        mode: wsConnected ? 'legacy-backend' : 'disconnected',
        detail: error,
      },
    ];
  }, [error, report, wsConnected]);

  const counts = useMemo(() => {
    return {
      healthy: services.filter((service) => service.status === 'healthy').length,
      attention: services.filter(
        (service) => service.status === 'degraded' || service.status === 'error',
      ).length,
      sleeping: services.filter(
        (service) => service.status === 'offline' || service.status === 'unavailable',
      ).length,
    };
  }, [services]);

  return (
    <section
      className="rounded-xl border border-border/70 bg-card/80 p-5 shadow-sm"
      data-testid="connections-health"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/50 pb-4">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
            <Activity className="h-5 w-5" />
          </span>
          <div>
            <h3 className="text-sm font-semibold">{t('settings:connection.healthHeading')}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('settings:connection.healthHint')}
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
          <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', loading && 'animate-spin')} />
          {t('settings:connection.healthRefresh')}
        </Button>
      </div>

      <div className="my-4 flex flex-wrap items-center gap-2 text-[11px]">
        <SummaryPill
          tone={report?.overall ?? (error && !wsConnected ? 'error' : 'degraded')}
          label={
            report
              ? t(`settings:connection.healthOverall.${report.overall}`)
              : loading
                ? t('settings:connection.healthLoading')
                : t('settings:connection.healthUnknown')
          }
        />
        <span className="rounded-full border border-border bg-background px-2.5 py-1 text-muted-foreground">
          {t('settings:connection.healthCounts', counts)}
        </span>
        {report && (
          <span className="font-mono text-[10px] text-muted-foreground">
            {report.backend} · {new Date(report.checkedAt).toLocaleTimeString()}
          </span>
        )}
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="grid gap-3 xl:grid-cols-2">
        {services.map((service) => (
          <ServiceCard
            key={service.id}
            service={service}
            onAction={handleServiceAction}
            actionPending={pendingActions.has(service.id)}
            feedback={actionFeedback[service.id] ?? undefined}
          />
        ))}
        {!report && loading && [0, 1, 2, 3].map((key) => <ServiceSkeleton key={key} />)}
      </div>
    </section>
  );
}

function ServiceCard({
  service,
  onAction,
  actionPending,
  feedback,
}: {
  service: ConnectionHealthService;
  onAction?: (serviceId: string, action: 'shutdown' | 'restart') => void;
  actionPending?: boolean;
  feedback?: { success: boolean; message: string } | undefined;
}) {
  const { t } = useAppTranslation();
  const isWebui = service.id === 'webui';
  const Icon = isWebui
    ? Wifi
    : service.id === 'chronicle'
      ? Database
      : service.id === 'codebase-index'
        ? HardDrive
        : service.id === 'kanban'
          ? KanbanSquare
          : service.id === 'mailbox'
            ? Mail
            : MemoryStick;
  const displayLabel =
    service.id === 'kanban'
      ? (t('settings:connection.services.kanban.label', { defaultValue: service.label }) as string)
      : service.id === 'mailbox'
        ? (t('settings:connection.services.mailbox.label', {
            defaultValue: service.label,
          }) as string)
        : service.label;
  const fields = [
    service.ownerPid !== undefined ? ['PID', String(service.ownerPid)] : undefined,
    service.clients !== undefined ? ['clients', String(service.clients)] : undefined,
    service.activeRequests !== undefined ? ['active', String(service.activeRequests)] : undefined,
    service.queuedWork !== undefined ? ['queued', String(service.queuedWork)] : undefined,
    service.latencyMs !== undefined ? ['latency', `${service.latencyMs}ms`] : undefined,
    service.uptimeMs !== undefined ? ['uptime', formatDuration(service.uptimeMs)] : undefined,
  ].filter((field): field is string[] => field !== undefined);

  return (
    <article className="min-w-0 rounded-lg border border-border/70 bg-background/65 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 rounded-md border border-border bg-card p-2 text-primary">
            <Icon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-xs font-semibold">{displayLabel}</h4>
              {!service.required && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {t('settings:connection.healthOptional')}
                </span>
              )}
            </div>
            <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
              {service.detail}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!isWebui && onAction && (
            <Button
              variant="outline"
              size="sm"
              disabled={actionPending}
              onClick={() => onAction(service.id, 'shutdown')}
              className="h-7 px-2 text-[10px]"
              title={
                t('settings:connection.serviceActionReset', {
                  defaultValue: `Reset ${displayLabel}`,
                }) as string
              }
            >
              <RotateCcw className={cn('h-3 w-3', actionPending && 'animate-spin')} />
            </Button>
          )}
          <StatusBadge status={service.status} />
        </div>
      </div>

      {feedback && (
        <div
          className={cn(
            'mt-2 rounded px-2 py-1 text-[10px]',
            feedback.success
              ? 'border border-success/30 bg-success/10 text-success'
              : 'border border-destructive/30 bg-destructive/10 text-destructive',
          )}
        >
          {feedback.message}
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-border/50 pt-2 font-mono text-[9px] text-muted-foreground">
        <span>
          mode <b className="text-foreground">{service.mode}</b>
        </span>
        {fields.map(([label, value]) => (
          <span key={label}>
            {label} <b className="text-foreground">{value}</b>
          </span>
        ))}
        {service.watcher && (
          <span>
            watcher{' '}
            <b className={service.watcher.active ? 'text-success' : 'text-warning'}>
              {service.watcher.active ? 'active' : 'inactive'}
            </b>
            {service.watcher.watchedFiles !== undefined ? ` · ${service.watcher.watchedFiles}` : ''}
          </span>
        )}
      </div>

      {(service.storage || service.endpoint) && (
        <div className="mt-2 space-y-1 font-mono text-[9px] text-muted-foreground">
          {service.storage && <PathLine label="store" value={service.storage} />}
          {service.endpoint && <PathLine label="endpoint" value={service.endpoint} />}
        </div>
      )}
    </article>
  );
}

function StatusBadge({ status }: { status: ConnectionHealthService['status'] }) {
  const { t } = useAppTranslation();
  const Icon =
    status === 'healthy'
      ? CheckCircle2
      : status === 'offline' || status === 'unavailable'
        ? CircleOff
        : TriangleAlert;
  return (
    <span
      className={cn(
        'flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide',
        status === 'healthy' && 'border-success/30 bg-success/10 text-success',
        status === 'degraded' && 'border-warning/30 bg-warning/10 text-warning',
        status === 'error' && 'border-destructive/30 bg-destructive/10 text-destructive',
        (status === 'offline' || status === 'unavailable') &&
          'border-border bg-muted text-muted-foreground',
      )}
    >
      <Icon className="h-3 w-3" />
      {t(`settings:connection.healthStatus.${status}`)}
    </span>
  );
}

function SummaryPill({ tone, label }: { tone: ConnectionsHealthReport['overall']; label: string }) {
  return (
    <span
      className={cn(
        'rounded-full border px-2.5 py-1 font-semibold',
        tone === 'healthy' && 'border-success/30 bg-success/10 text-success',
        tone === 'degraded' && 'border-warning/30 bg-warning/10 text-warning',
        tone === 'error' && 'border-destructive/30 bg-destructive/10 text-destructive',
      )}
    >
      {label}
    </span>
  );
}

function PathLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 gap-2">
      <span className="shrink-0">{label}</span>
      <span className="truncate text-foreground" title={value}>
        {value}
      </span>
    </div>
  );
}

function ServiceSkeleton() {
  return (
    <div className="h-32 animate-pulse rounded-lg border border-border/60 bg-muted/30">
      <Server className="m-4 h-4 w-4 text-muted-foreground/30" />
    </div>
  );
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
