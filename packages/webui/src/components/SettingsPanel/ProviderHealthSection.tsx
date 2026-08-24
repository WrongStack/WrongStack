/**
 * ProviderHealthSection — WebUI Settings panel for the provider/model waiting room.
 * Shows every tracked provider/model pair: blocked, degraded, or healthy, with an
 * explanation of WHY each model is in that state, failure counts, and recovery time.
 *
 * Data flows from the CLI's ProviderModelStatusTracker through WS push events into
 * `provider-status-store.ts`, which this component reads directly (no WS handler here).
 *
 * The store is updated by:
 *   - `provider.status_changed`   WS push (live update on each failure/success)
 *   - `provider.status.snapshot` WS push (full refresh on connect / /provider-status)
 *   - `provider.status.result`   WS push (response to our own `provider.status.get`)
 */

import {
  AlertTriangle,
  Ban,
  ChevronDown,
  ChevronRight,
  Clock,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Wifi,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWebSocket } from '@/hooks/useWebSocket';
import { cn } from '@/lib/utils';
import { type ProviderHealthEntry, useProviderStatusStore } from '@/stores/provider-status-store';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';

/** How long until a cooldown expires, formatted compactly. */
function CooldownRemaining({ expiresAtMs }: { expiresAtMs: number }) {
  const remaining = expiresAtMs - Date.now();
  if (remaining <= 0) return null;
  const secs = Math.floor(remaining / 1000);
  const mins = Math.floor(secs / 60);
  const hours = Math.floor(mins / 60);
  if (hours > 0)
    return (
      <span>
        {hours}h {mins % 60}m
      </span>
    );
  if (mins > 0) return <span>{mins}m</span>;
  return <span>{secs}s</span>;
}

/** Human-readable explanation of WHY a model is in its current state. */
function StateExplanation({
  state,
  kind,
  statusCode,
}: {
  state: string;
  kind?: string | null;
  statusCode?: number | null;
}) {
  const { t } = useTranslation('settings');
  if (state === 'healthy') return <span>{t('connection.providerHealth.explainHealthy')}</span>;
  if (kind === 'quota_exhausted') return <span>{t('connection.providerHealth.explainQuota')}</span>;
  if (statusCode === 402) return <span>{t('connection.providerHealth.explain402')}</span>;
  if (statusCode === 403) {
    if (kind === 'auth') return <span>{t('connection.providerHealth.explain403auth')}</span>;
    return <span>{t('connection.providerHealth.explain403quota')}</span>;
  }
  if (statusCode === 429) return <span>{t('connection.providerHealth.explain429')}</span>;
  if (statusCode === 529) return <span>{t('connection.providerHealth.explain529')}</span>;
  if (statusCode !== undefined && statusCode !== null && statusCode >= 500) {
    return <span>{t('connection.providerHealth.explain5xx', { status: statusCode })}</span>;
  }
  if (kind === 'network') return <span>{t('connection.providerHealth.explainNetwork')}</span>;
  if (kind === 'timeout') return <span>{t('connection.providerHealth.explainTimeout')}</span>;
  if (kind === 'stream_hang')
    return <span>{t('connection.providerHealth.explainStreamHang')}</span>;
  return (
    <span>
      {t('connection.providerHealth.explainUnknown', {
        kind: kind ?? 'unknown',
        status: statusCode ?? '?',
      })}
    </span>
  );
}

/** Single model row — collapsible accordion */
function ModelRow({
  entry,
  onRetry,
  onClear,
}: {
  entry: ProviderHealthEntry;
  onRetry: (providerId: string, model: string) => void;
  onClear: (providerId: string, model: string) => void;
}) {
  const [expanded, setExpanded] = useExpanded(false);
  const { t } = useTranslation('settings');
  const isBlocked = entry.state === 'blocked';
  const isDegraded = entry.state === 'degraded';

  return (
    <div className="rounded-md border border-border/60 bg-card/50">
      {/* Header row */}
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50 transition-colors rounded-md"
      >
        <span className="shrink-0 text-muted-foreground">
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </span>

        {/* State icon */}
        <span
          className={cn(
            'shrink-0',
            isBlocked && 'text-destructive',
            isDegraded && 'text-warning',
            !isBlocked && !isDegraded && 'text-success',
          )}
        >
          {isBlocked ? (
            <Ban className="h-3.5 w-3.5" />
          ) : isDegraded ? (
            <AlertTriangle className="h-3.5 w-3.5" />
          ) : (
            <ShieldCheck className="h-3.5 w-3.5" />
          )}
        </span>

        {/* Provider / model */}
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          <span className="text-muted-foreground">{entry.providerId}</span>
          <span className="text-muted-foreground mx-0.5">/</span>
          <span className="text-foreground font-medium">{entry.model}</span>
        </span>

        {/* State badge */}
        <Badge
          variant={isBlocked ? 'destructive' : isDegraded ? 'outline' : 'secondary'}
          className={cn(
            'shrink-0 text-[10px]',
            isBlocked && 'bg-destructive/20 text-destructive border-destructive/40',
            isDegraded && 'bg-warning/10 text-warning border-warning/30',
          )}
        >
          {t(`connection.providerHealth.state.${entry.state}`)}
        </Badge>

        {/* Cooldown countdown */}
        {isBlocked && entry.stateExpiresAt && (
          <span className="shrink-0 flex items-center gap-1 text-[10px] text-muted-foreground">
            <Clock className="h-3 w-3" />
            <CooldownRemaining expiresAtMs={entry.stateExpiresAt} />
          </span>
        )}
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-border/40 px-3 py-2 space-y-2">
          {/* Why is it in this state? */}
          <div className="flex items-start gap-2 text-xs">
            <span className="shrink-0 mt-0.5 text-muted-foreground">
              <Zap className="h-3 w-3" />
            </span>
            <span className="text-muted-foreground flex-1 leading-relaxed">
              <StateExplanation
                state={entry.state}
                kind={entry.lastErrorKind}
                statusCode={entry.lastErrorStatus}
              />
            </span>
          </div>

          {/* Stats grid */}
          <div className="grid grid-cols-2 gap-2 text-[10px]">
            <div className="rounded bg-destructive/10 px-2 py-1 text-center">
              <div className="font-semibold text-destructive">{entry.totalFailures ?? 0}</div>
              <div className="text-muted-foreground">
                {t('connection.providerHealth.statFailures')}
              </div>
            </div>
            <div className="rounded bg-warning/10 px-2 py-1 text-center">
              <div className="font-semibold text-warning">{entry.rateLimitHits ?? 0}</div>
              <div className="text-muted-foreground">
                {t('connection.providerHealth.statRateLimits')}
              </div>
            </div>
          </div>

          {/* Consecutive failures */}
          {(entry.consecutiveFailures ?? 0) > 0 && (
            <div className="text-[10px] text-muted-foreground">
              <span className="font-medium text-destructive">{entry.consecutiveFailures}</span>{' '}
              {t('connection.providerHealth.statConsecutive')}{' '}
              {t('connection.providerHealth.statFailures')}
            </div>
          )}

          {/* Last error message */}
          {entry.lastErrorMessage && (
            <div className="rounded bg-muted/60 px-2 py-1.5">
              <div className="text-[10px] font-medium text-muted-foreground mb-0.5">
                {t('connection.providerHealth.lastError')}
              </div>
              <div className="text-[10px] font-mono text-foreground break-all">
                {entry.lastErrorMessage.slice(0, 120)}
                {entry.lastErrorMessage.length > 120 ? '…' : ''}
              </div>
              {entry.lastErrorStatus && (
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  HTTP {entry.lastErrorStatus} ·{' '}
                  <span className="font-mono">{entry.lastErrorKind}</span>
                </div>
              )}
            </div>
          )}

          {/* Auto-recovery time */}
          {isBlocked && entry.stateExpiresAt && (
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <Clock className="h-3 w-3 shrink-0" />
              <span>
                {t('connection.providerHealth.autoRecovery')}{' '}
                <span className="font-mono">
                  {new Date(entry.stateExpiresAt).toLocaleTimeString()}
                </span>
              </span>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-2 pt-1">
            {isBlocked && (
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-[10px] gap-1"
                onClick={(e) => {
                  e.stopPropagation();
                  onRetry(entry.providerId, entry.model);
                }}
              >
                <RotateCcw className="h-2.5 w-2.5" />
                {t('connection.providerHealth.retryNow')}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-6 text-[10px] gap-1"
              onClick={(e) => {
                e.stopPropagation();
                onClear(entry.providerId, entry.model);
              }}
            >
              <RefreshCw className="h-2.5 w-2.5" />
              {t('connection.providerHealth.clear')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Per-row expanded state — kept outside rows so each row manages its own toggle. */
function useExpanded(initial: boolean) {
  const [expanded, setExpanded] = useState(initial);
  return [expanded, setExpanded] as const;
}

export function ProviderHealthSection() {
  const { t } = useTranslation('settings');
  const ws = useWebSocket();
  // Provider-status methods live on the inner client, not the top-level return.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = ws as unknown as {
    on: (type: string, handler: (e: unknown) => void) => void;
    send: (msg: Record<string, unknown>) => void;
    retryProviderModel: (p: string, m: string) => void;
    clearProviderStatus: (p: string, m: string) => void;
  };
  const { entries, summary, update } = useProviderStatusStore();

  const entriesList = Object.values(entries);

  const blockedEntries = entriesList
    .filter((e) => e.state === 'blocked')
    .sort((a, b) => (a.stateExpiresAt ?? 0) - (b.stateExpiresAt ?? 0));

  const degradedEntries = entriesList
    .filter((e) => e.state === 'degraded')
    .sort((a, b) => (b.totalFailures ?? 0) - (a.totalFailures ?? 0));

  const healthyEntries = entriesList.filter((e) => e.state === 'healthy');

  const handleRetry = useCallback(
    (providerId: string, model: string) => {
      client?.retryProviderModel(providerId, model);
      // Re-fetch full snapshot after retry
      setTimeout(() => client?.send({ type: 'provider.status.get' }), 100);
    },
    [client],
  );

  const handleClear = useCallback(
    (providerId: string, model: string) => {
      client?.clearProviderStatus(providerId, model);
      // Re-fetch full snapshot after clearing
      setTimeout(() => client?.send({ type: 'provider.status.get' }), 100);
    },
    [client],
  );

  const handleRefresh = useCallback(() => {
    client?.send({ type: 'provider.status.get' });
  }, [client]);

  // Register WS push handlers so the store stays in sync with live events.
  useEffect(() => {
    if (!client) return;

    client.on('provider.status_changed', (e: unknown) => {
      const ev = e as Record<string, unknown>;
      update({
        providerId: String(ev.providerId ?? ''),
        model: String(ev.model ?? ''),
        state: (ev.state as ProviderHealthEntry['state']) ?? 'healthy',
        stateExpiresAt: ev.stateExpiresAt as number | undefined,
        consecutiveFailures: ev.consecutiveFailures as number | undefined,
        totalFailures: ev.totalFailures as number | undefined,
        rateLimitHits: ev.rateLimitHits as number | undefined,
        lastErrorMessage: ev.lastErrorMessage as string | undefined,
        lastErrorKind: ev.lastErrorKind as string | undefined,
        lastErrorStatus: ev.lastErrorStatus as number | undefined,
        reason:
          (ev.reason as string | undefined) ?? (ev.lastErrorMessage as string | undefined) ?? '',
        updatedAt: (ev.updatedAt as number | undefined) ?? Date.now(),
      });
    });

    client.on('provider.status.snapshot', (e: unknown) => {
      const ev = e as Record<string, unknown>;
      if (Array.isArray(ev.entries)) {
        const { hydrate } = useProviderStatusStore.getState();
        hydrate(ev.entries as ProviderHealthEntry[]);
      }
    });

    client.on('provider.status.result', (e: unknown) => {
      const ev = e as Record<string, unknown>;
      if (Array.isArray(ev.entries)) {
        const { hydrate } = useProviderStatusStore.getState();
        hydrate(ev.entries as ProviderHealthEntry[]);
      }
    });

    // Request initial snapshot on mount.
    client.send({ type: 'provider.status.get' });
  }, [client, update]);

  if (!client) {
    return (
      <div className="rounded-xl border border-border/70 bg-card/80 p-5 shadow-sm">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Wifi className="h-4 w-4" />
          <span>{t('settings:connection.healthDisconnected')}</span>
        </div>
      </div>
    );
  }

  const hasAny = entriesList.length > 0;

  return (
    <div className="rounded-xl border border-border/70 bg-card/80 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/40">
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Ban className="h-4 w-4 text-destructive" />
            {t('connection.providerHealth.heading')}
          </h3>
          {summary && (
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {summary.blocked} blocked · {summary.degraded} degraded · {summary.healthy} healthy
              {summary.totalFailures > 0 && (
                <span className="ml-2">
                  · <span className="text-destructive">{summary.totalFailures}</span>{' '}
                  {t('connection.providerHealth.totalFailures')}
                  {summary.totalRateLimits > 0 && (
                    <>
                      {' '}
                      &middot; <span className="text-warning">{summary.totalRateLimits}</span>{' '}
                      {t('connection.providerHealth.rateLimits')}
                    </>
                  )}
                </span>
              )}
            </p>
          )}
        </div>
        <Button size="sm" variant="ghost" className="h-7 text-[11px] gap-1" onClick={handleRefresh}>
          <RefreshCw className="h-3 w-3" />
          {t('connection.providerHealth.refresh')}
        </Button>
      </div>

      {/* Blocked models */}
      {blockedEntries.length > 0 && (
        <div className="px-3 pt-3">
          <div className="flex items-center gap-1.5 mb-2 text-[10px] font-semibold text-destructive uppercase tracking-wide">
            <Ban className="h-3 w-3" />
            {t('connection.providerHealth.blocked')} ({blockedEntries.length})
          </div>
          <div className="space-y-1">
            {blockedEntries.map((entry) => (
              <ModelRow
                key={`${entry.providerId}/${entry.model}`}
                entry={entry}
                onRetry={handleRetry}
                onClear={handleClear}
              />
            ))}
          </div>
        </div>
      )}

      {/* Degraded models */}
      {degradedEntries.length > 0 && (
        <div className="px-3 pt-3">
          <div className="flex items-center gap-1.5 mb-2 mt-2 text-[10px] font-semibold text-warning uppercase tracking-wide">
            <AlertTriangle className="h-3 w-3" />
            {t('connection.providerHealth.degraded')} ({degradedEntries.length})
          </div>
          <div className="space-y-1">
            {degradedEntries.map((entry) => (
              <ModelRow
                key={`${entry.providerId}/${entry.model}`}
                entry={entry}
                onRetry={handleRetry}
                onClear={handleClear}
              />
            ))}
          </div>
        </div>
      )}

      {/* Healthy models (collapsed by default, shown only if no blocked/degraded) */}
      {healthyEntries.length > 0 && blockedEntries.length === 0 && degradedEntries.length === 0 && (
        <div className="px-3 py-3">
          <div className="flex items-center gap-1.5 mb-2 text-[10px] font-semibold text-success uppercase tracking-wide">
            <ShieldCheck className="h-3 w-3" />
            {t('connection.providerHealth.state.healthy')} ({healthyEntries.length})
          </div>
          <div className="space-y-1">
            {healthyEntries.map((entry) => (
              <ModelRow
                key={`${entry.providerId}/${entry.model}`}
                entry={entry}
                onRetry={handleRetry}
                onClear={handleClear}
              />
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {!hasAny && (
        <div className="px-4 py-8 text-center">
          <div className="flex justify-center mb-2">
            <ShieldCheck className="h-8 w-8 text-muted-foreground/40" />
          </div>
          <p className="text-sm text-muted-foreground">{t('connection.providerHealth.empty')}</p>
        </div>
      )}
    </div>
  );
}
