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
  ShieldCheck,
  TriangleAlert,
  Wifi,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores';
import type { ConnectionHealthService, ConnectionsHealthReport, WSServerMessage } from '@/types';
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
    Record<
      string,
      { success: boolean; message: string; tone?: 'success' | 'destructive' | 'neutral' } | null
    >
  >({});
  const [autoHealing, setAutoHealing] = useState<Set<string>>(new Set());
  // Per-service feedback timers, cleared on unmount — a `client.on` handler's
  // return value is the unsubscribe, not a cleanup, so timers created inside
  // handlers must be tracked explicitly. Keyed by serviceId so a newer event
  // for the same service cancels the previous 5s clear instead of racing it.
  // ReturnType<typeof setTimeout> is realm-agnostic (browser number vs Node
  // Timeout), which matters because vitest's jsdom project swaps globals.
  const feedbackTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

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

  // Stable indirection: the subscription effect below must not tear down and
  // re-register every WS handler when `wsConnected` or the locale flips —
  // `refresh` self-guards both conditions internally.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // Connection-state trigger: the stable-subscription effect above no longer
  // re-runs on `wsConnected` flips, so without this the panel would keep the
  // stale state until the next 15s tick — a stale healthy report after a
  // disconnect, and a stale "disconnected" error (with an empty service list)
  // after a reconnect. `refresh` self-guards both conditions internally.
  useEffect(() => {
    refreshRef.current();
  }, [wsConnected]);

  const clearFeedbackTimer = (serviceId: string): void => {
    const timers = feedbackTimersRef.current;
    const prior = timers.get(serviceId);
    if (prior !== undefined) {
      clearTimeout(prior);
      timers.delete(serviceId);
    }
  };

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
    const offResult = client.on('connections.health_result', (message) => {
      if (message.type !== 'connections.health_result') return;
      const report = message.payload;
      setReport(report);
      setLoading(false);
      setError(null);
      // Self-heal the auto-restarting badge: if the terminal auto-heal event
      // was missed (dropped frame, reconnect), a fresh report showing the
      // service actually serving again is the ground truth — a stuck badge
      // would otherwise persist for the lifetime of the panel.
      // Only healthy/degraded clear it: `offline` is what the collector
      // reports for codebase-index/sage/mailbox while their daemon is DOWN
      // MID-RESTART, so trusting it would clear the badge and re-enable the
      // manual restart button while the auto-healer is still working
      // (manual restart could then race the heal). A concluded-but-failed
      // heal is cleared by its own terminal auto_heal_status event.
      setAutoHealing((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set(prev);
        for (const service of report.services) {
          if (
            next.has(service.id) &&
            (service.status === 'healthy' || service.status === 'degraded')
          ) {
            next.delete(service.id);
          }
        }
        return next;
      });
    });
    const offError = client.on('connections.health_error', (message: WSServerMessage) => {
      if (message.type !== 'connections.health_error') return;
      setLoading(false);
      setError(message.payload.message);
    });
    const offActionResult = client.on('connections.service_action_result', (message) => {
      if (message.type !== 'connections.service_action_result') return;
      const result = message.payload;
      // Guard the phantom '' key: a malformed result with no serviceId must
      // not write a stray feedback row that no ServiceCard ever renders.
      const serviceId = result.serviceId;
      if (!serviceId) return;
      setPendingActions((prev) => {
        const next = new Set(prev);
        next.delete(serviceId);
        return next;
      });
      setActionFeedback((prev) => ({
        ...prev,
        [serviceId]: { success: result.success, message: result.message },
      }));
      // Auto-clear feedback after 5s. Keyed per service and cancels any
      // prior clear so a newer event for the same service is never wiped
      // early by an older timer.
      clearFeedbackTimer(serviceId);
      feedbackTimersRef.current.set(
        serviceId,
        setTimeout(() => {
          setActionFeedback((prev) => ({ ...prev, [serviceId]: null }));
          feedbackTimersRef.current.delete(serviceId);
        }, 5_000),
      );
      // Auto-refresh health after action
      void refreshRef.current();
    });
    const offAutoHealStatus = client.on('connections.auto_heal_status', (message) => {
      if (message.type !== 'connections.auto_heal_status') return;
      const event = message.payload;
      const serviceId = event.serviceId;
      if (!serviceId) return;
      if (event.phase === 'restarting') {
        // A new attempt supersedes any prior terminal feedback: cancel its
        // pending clear and drop the row, or the stale timer would wipe the
        // feedback while this heal is still running.
        clearFeedbackTimer(serviceId);
        setActionFeedback((prev) => ({ ...prev, [serviceId]: null }));
        // Show the "auto-restarting…" badge while the daemon is being healed.
        setAutoHealing((prev) => new Set(prev).add(serviceId));
        return;
      }
      // Terminal phase — clear the badge, surface the outcome, refresh health.
      setAutoHealing((prev) => {
        const next = new Set(prev);
        next.delete(serviceId);
        return next;
      });
      setActionFeedback((prev) => ({
        ...prev,
        [serviceId]: {
          success: event.phase === 'restarted',
          // A policy refusal is not a failure of the daemon — render neutral.
          tone: event.phase === 'refused' ? 'neutral' : undefined,
          message: event.message,
        },
      }));
      clearFeedbackTimer(serviceId);
      feedbackTimersRef.current.set(
        serviceId,
        setTimeout(() => {
          setActionFeedback((prev) => ({ ...prev, [serviceId]: null }));
          feedbackTimersRef.current.delete(serviceId);
        }, 5_000),
      );
      void refreshRef.current();
    });
    refreshRef.current();
    const timer = setInterval(() => refreshRef.current(), REFRESH_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      for (const t of feedbackTimersRef.current.values()) clearTimeout(t);
      feedbackTimersRef.current.clear();
      // Reset in-flight state tied to THIS client: when the effect tears down
      // on a client replacement, a stale `autoHealing` badge or `pendingActions`
      // entry would otherwise strand forever (phantom badge, permanently
      // disabled button) — the new connection carries no such knowledge.
      // On unmount this is a harmless no-op.
      setAutoHealing(new Set());
      setPendingActions(new Set());
      offResult();
      offError();
      offActionResult();
      offAutoHealStatus();
    };
  }, [client]);

  const services = useMemo<ConnectionHealthService[]>(() => {
    if (report) return report.services;
    if (!error) return [];
    return [
      {
        id: 'webui',
        label: t('settings:connection.webuiTransport'),
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
            autoRestarting={autoHealing.has(service.id)}
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
  autoRestarting,
  feedback,
}: {
  service: ConnectionHealthService;
  onAction?: (serviceId: string, action: 'shutdown' | 'restart') => void;
  actionPending?: boolean;
  autoRestarting?: boolean;
  feedback?:
    | {
        success: boolean;
        message: string;
        tone?: 'success' | 'destructive' | 'neutral' | undefined;
      }
    | undefined;
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
            : service.id === 'governance'
              ? ShieldCheck
              : MemoryStick;
  const displayLabel =
    service.id === 'kanban'
      ? (t('settings:connection.services.kanban.label', { defaultValue: service.label }) as string)
      : service.id === 'mailbox'
        ? (t('settings:connection.services.mailbox.label', {
            defaultValue: service.label,
          }) as string)
        : service.label;
  // The daemon's derived socket path cannot be bound on this platform (over
  // the sun_path byte limit — macOS's long per-user TMPDIR is the known
  // trigger). The service silently degrades to a process-local fallback, so
  // it deserves a louder treatment than the generic "unavailable" badge.
  const endpointInvalid = service.mode === 'endpoint-invalid';
  const endpointInvalidRemedy = t('settings:connection.endpointInvalidRemedy', {
    defaultValue:
      'The IPC socket path exceeds this platform\u2019s length limit, so the shared daemon ' +
      'cannot start. Queries fall back to a slower process-local mode. Remedy: set a shorter ' +
      'TMPDIR (e.g. export TMPDIR=/tmp) and restart WrongStack.',
  }) as string;
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
              {endpointInvalid && (
                <span
                  className="inline-flex cursor-help items-center gap-1 rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wider text-warning"
                  title={endpointInvalidRemedy}
                  data-testid="endpoint-invalid-badge"
                >
                  <TriangleAlert className="h-3 w-3" />
                  {t('settings:connection.endpointInvalidBadge', {
                    defaultValue: 'socket path too long',
                  })}
                </span>
              )}
            </div>
            <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
              {service.detail}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!isWebui && service.control !== 'none' && onAction && (
            <Button
              variant="outline"
              size="sm"
              disabled={actionPending || autoRestarting}
              onClick={() => onAction(service.id, 'restart')}
              className="h-7 px-2 text-[10px]"
              title={
                t('settings:connection.serviceActionRestart', {
                  defaultValue: `Restart ${displayLabel}`,
                  label: displayLabel,
                }) as string
              }
            >
              <RotateCcw
                className={cn('h-3 w-3', (actionPending || autoRestarting) && 'animate-spin')}
              />
            </Button>
          )}
          {autoRestarting && (
            <span
              className="flex shrink-0 items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-primary"
              data-testid="auto-restarting-badge"
              title={t('settings:connection.serviceAutoRestarting', {
                defaultValue: 'Auto-restarting…',
              })}
            >
              <RefreshCw className="h-3 w-3 animate-spin" />
              {t('settings:connection.serviceAutoRestarting', {
                defaultValue: 'Auto-restarting…',
              })}
            </span>
          )}
          <StatusBadge status={service.status} />
        </div>
      </div>

      {feedback && (
        <div
          className={cn(
            'mt-2 rounded px-2 py-1 text-[10px]',
            feedback.tone === 'neutral'
              ? 'border border-border bg-muted text-muted-foreground'
              : feedback.success
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
        {service.advisory && (
          <>
            <span>
              signal <b className="text-foreground">{service.advisory.code}</b>
            </span>
            <span>
              action <b className="text-foreground">{service.advisory.operatorAction}</b>
            </span>
            <span>
              execution <b className="text-success">{service.advisory.executionDisposition}</b>
            </span>
          </>
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
