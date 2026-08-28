import { AlertTriangle, CheckCircle2, Clock3, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { blockingCalendarRules, ruleTarget } from '@/lib/model-calendar';
import { getWSClient } from '@/lib/ws-client';
import { useProviderStatusStore } from '@/stores';
import { useLocalPrefs } from '@/stores/local-prefs';
import { useAppTranslation } from '@/i18n';

function remaining(expiresAt: number | undefined, now: number): string {
  if (!expiresAt) return 'reset time unknown';
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  if (seconds === 0) return 'rechecking now';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatAgo(ts: number | null | undefined, now: number): string {
  if (!ts) return '';
  const seconds = Math.max(0, Math.floor((now - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
}

const SIBLING_TRIGGER_RE = /Sibling quarantine:.*?\bon\s+([^\s/]+\/\S+)/;

/**
 * For sibling-quarantined entries, the provider/model whose quota failure
 * caused the block (parsed from the tracker's sibling-quarantine message),
 * so the room can show which pair actually tripped the fan-out.
 */
export function siblingTriggerOf(entry: {
  lastErrorMessage?: string | undefined;
}): string | null {
  return SIBLING_TRIGGER_RE.exec(entry.lastErrorMessage ?? '')?.[1] ?? null;
}

export function ProviderWaitingRoom() {
  const { t } = useAppTranslation();
  const entriesByKey = useProviderStatusStore((state) => state.entries);
  const _summary = useProviderStatusStore((state) => state.summary);
  const removeEntry = useProviderStatusStore((state) => state.removeEntry);
  const calendarRules = useLocalPrefs((state) => state.modelAvailabilitySchedule);
  const [expanded, setExpanded] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const entries = useMemo(
    () =>
      Object.values(entriesByKey).sort(
        (a, b) => (a.stateExpiresAt ?? 0) - (b.stateExpiresAt ?? 0),
      ),
    [entriesByKey],
  );
  // Full snapshots may retain healthy rows for summary consistency; the room
  // itself only shows pairs that are actually waiting.
  const visible = useMemo(() => entries.filter((entry) => entry.state !== 'healthy'), [entries]);
  const activeRules = useMemo(
    () => blockingCalendarRules(calendarRules, new Date(now)),
    [calendarRules, now],
  );

  const refresh = useCallback(() => {
    getWSClient().getProviderStatus();
  }, []);

  const handleRetry = useCallback(
    (providerId: string, model: string) => {
      getWSClient().retryProviderModel(providerId, model);
      removeEntry(providerId, model);
    },
    [removeEntry],
  );

  const handleClear = useCallback(
    (providerId: string, model: string) => {
      getWSClient().clearProviderStatus(providerId, model);
      removeEntry(providerId, model);
    },
    [removeEntry],
  );

  // Auto-refresh on expand; tick countdown timer when entries exist.
  useEffect(() => {
    if (visible.length === 0 && activeRules.length === 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activeRules.length, visible.length]);

  useEffect(() => {
    if (expanded) refresh();
  }, [expanded, refresh]);

  if (visible.length === 0 && activeRules.length === 0) return null;

  const blocked = visible.filter((entry) => entry.state === 'blocked').length;
  const degraded = visible.length - blocked;
  const _selected = selectedKey ? entriesByKey[selectedKey] : null;

  return (
    <div className="mx-auto mb-2 max-w-6xl rounded-lg border border-warning/25 bg-warning/5 text-xs">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-warning/5"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <AlertTriangle className="h-3.5 w-3.5 text-warning" />
        <span className="font-medium text-foreground">{t('activity:providerWait.providerModelAvailability')}</span>
        <span className="text-muted-foreground">
          {blocked} blocked · {degraded} degraded · {activeRules.length} scheduled
        </span>
        <button
          type="button"
          className="ml-auto inline-flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation();
            refresh();
          }}
          title={t('activity:providerWait.refreshStatus')}
        >
          <RefreshCw className="h-3 w-3" />
        </button>
        <span className="text-muted-foreground">{expanded ? 'Hide' : 'Details'}</span>
      </button>
      {expanded && (
        <div className="border-t border-warning/15 px-3 py-2">
          {visible.map((entry) => {
            const key = `${entry.providerId}\u0000${entry.model}`;
            const isSelected = selectedKey === key;
            const siblingTrigger = siblingTriggerOf(entry);
            return (
              <div key={key}>
                <button
                  type="button"
                  className="flex flex-wrap cursor-pointer items-center gap-x-2 gap-y-1 py-1.5 hover:bg-warning/5"
                  onClick={() => setSelectedKey(isSelected ? null : key)}
                >
                  {entry.state === 'blocked' ? (
                    <Clock3 className="h-3.5 w-3.5 text-warning" />
                  ) : (
                    <CheckCircle2 className="h-3.5 w-3.5 text-warning" />
                  )}
                  <code className="text-foreground">
                    {entry.providerId}/{entry.model}
                  </code>
                  <span className="rounded bg-warning/10 px-1.5 py-0.5 text-warning">
                    {entry.state}
                  </span>
                  <span className="text-muted-foreground">{entry.reason.replaceAll('_', ' ')}</span>
                  {siblingTrigger && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                      via {siblingTrigger}
                    </span>
                  )}
                  <span className="ml-auto tabular-nums text-muted-foreground">
                    {remaining(entry.stateExpiresAt, now)}
                  </span>
                </button>

                {/* Expanded detail: error message, counters, logs, actions */}
                {isSelected && (
                  <div className="ml-6 mb-2 rounded border border-border/50 bg-background/50 p-2">
                    {entry.lastErrorMessage && (
                      <div className="mb-1.5 text-destructive">
                        <span className="text-muted-foreground">{t('activity:providerWait.lastError')} </span>
                        {entry.lastErrorMessage.slice(0, 300)}
                      </div>
                    )}
                    <div className="mb-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground">
                      {entry.totalFailures !== undefined && (
                        <span>failures: {entry.totalFailures}</span>
                      )}
                      {entry.rateLimitHits !== undefined && entry.rateLimitHits > 0 && (
                        <span>rate-limits: {entry.rateLimitHits}</span>
                      )}
                      {entry.consecutiveFailures !== undefined && (
                        <span>streak: {entry.consecutiveFailures}</span>
                      )}
                      {entry.lastErrorStatus !== undefined && (
                        <span>HTTP: {entry.lastErrorStatus}</span>
                      )}
                      {entry.lastSessionId && (
                        <span>session: {entry.lastSessionId.slice(0, 12)}…</span>
                      )}
                      {entry.lastAgentId && (
                        <span>agent: {entry.lastAgentId.slice(0, 16)}…</span>
                      )}
                      {entry.lastFailureAt && (
                        <span>{formatAgo(entry.lastFailureAt, now)}</span>
                      )}
                    </div>

                    {/* Recent error log */}
                    {entry.recentErrors && entry.recentErrors.length > 0 && (
                      <details className="mb-1.5">
                        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                          Error history ({entry.recentErrors.length})
                        </summary>
                        <div className="mt-1 max-h-32 overflow-y-auto text-[11px] text-muted-foreground">
                          {entry.recentErrors.map((err, idx) => (
                            <div key={idx} className="flex gap-2 border-b border-border/20 py-0.5">
                              <span className="shrink-0 tabular-nums text-warning/70">
                                {err.kind}
                              </span>
                              <span className="shrink-0 tabular-nums">HTTP {err.status}</span>
                              <span className="truncate">{err.message.slice(0, 200)}</span>
                              <span className="ml-auto shrink-0 tabular-nums">
                                {formatAgo(err.timestamp, now)}
                              </span>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}

                    {/* Actions */}
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded border border-border bg-background px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-accent"
                        onClick={() => handleRetry(entry.providerId, entry.model)}
                      >
                        <RotateCcw className="h-3 w-3" />
                        {t('activity:providerWait.reopenHalfOpenProbe')}
                      </button>
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded border border-border bg-background px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                        onClick={() => handleClear(entry.providerId, entry.model)}
                      >
                        <Trash2 className="h-3 w-3" />
                        {t('activity:providerWait.clearTracking')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {activeRules.map((rule) => (
            <div key={rule.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5">
              <Clock3 className="h-3.5 w-3.5 text-info" />
              <code className="text-foreground">{ruleTarget(rule)}</code>
              <span className="rounded bg-info/10 px-1.5 py-0.5 text-info">scheduled</span>
              <span className="text-muted-foreground">{rule.label ?? 'calendar blackout'}</span>
              <span className="ml-auto tabular-nums text-muted-foreground">
                {rule.start}–{rule.end} · {rule.timezone ?? 'local time'}
              </span>
            </div>
          ))}
          <div className="mt-1 text-[11px] text-muted-foreground">
            {t('activity:providerWait.wrongstackRoutesAroundActiveSchedulesAnd')}
          </div>
        </div>
      )}
    </div>
  );
}
