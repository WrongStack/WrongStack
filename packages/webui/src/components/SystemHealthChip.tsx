/**
 * SystemHealthChip — one quiet top-bar indicator for everything that used to
 * sit there as its own chip or icon: backend WS, WebUI server RAM, the
 * codebase index server, dropped tools, WrongProxy and HQ.
 *
 * It stays grey while nothing needs attention and only takes a warning /
 * destructive tone (plus an issue count) when something does, so the bar is
 * calm in the normal case. Every figure the separate chips showed is still in
 * the popover. The separate chips are still rendered by `WorkbenchTopbar` when
 * Settings → Display → chrome is `full`.
 *
 * `ServerProcessMetrics`, `formatCompactBytes` and `useServerProcessMetrics`
 * live here (re-exported by `WorkbenchTopbar`) so the chip does not import its
 * own host.
 */

import { Activity } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { IntegrationProbeState } from '@/hooks/useIntegrationStatus';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';

export interface ServerProcessMetrics {
  pid: number;
  memoryUsage: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
  };
  heapLimit: number;
  codebaseIndexServer?:
    | {
        status:
          | 'unavailable'
          | 'offline'
          | 'connecting'
          | 'connected'
          | 'degraded'
          | 'unresponsive'
          | 'error'
          | 'stopping';
        connected: boolean;
        pid?: number | undefined;
        health?:
          | {
              status: 'healthy' | 'degraded' | 'unresponsive';
              latencyMs: number | null;
              missedHeartbeats: number;
              server?:
                | {
                    uptimeMs: number;
                    memory: { rss: number; heapUsed: number; heapTotal: number };
                    clients: number;
                    activeRequests: number;
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
}

export function formatCompactBytes(bytes: number): string {
  // Promote on the rounded value: an RSS of 1023.5 MB is "1.0 GB", not "1024 MB".
  if (Math.round(bytes / 1024 ** 2) >= 1024) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (Math.round(bytes / 1024) >= 1024) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (Math.round(bytes) >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes)} B`;
}

export function useServerProcessMetrics(): ServerProcessMetrics | null {
  const [metrics, setMetrics] = useState<ServerProcessMetrics | null>(null);

  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const response = await fetch('/debug/system', { cache: 'no-store' });
        if (!response.ok) return;
        const next = (await response.json()) as ServerProcessMetrics;
        if (!disposed && Number.isFinite(next.memoryUsage?.rss)) setMetrics(next);
      } catch {
        // Keep the rest of the workbench usable if diagnostics are unavailable.
      }
    };

    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  return metrics;
}

// ── Health model ────────────────────────────────────────────────────────────

export type HealthTone = 'ok' | 'muted' | 'warning' | 'destructive';

export interface HealthRow {
  id: 'ws' | 'server' | 'index' | 'tools' | 'wrongproxy' | 'hq';
  label: string;
  value: string;
  tone: HealthTone;
  detail?: string | undefined;
}

export interface SystemHealthInput {
  wsConnected: boolean;
  server: ServerProcessMetrics | null;
  droppedTools: number;
  wrongProxy: IntegrationProbeState;
  hq: IntegrationProbeState;
}

function integrationRow(
  id: 'wrongproxy' | 'hq',
  label: string,
  probe: IntegrationProbeState,
): HealthRow {
  switch (probe.status) {
    case 'connected':
      return {
        id,
        label,
        value: probe.latencyMs != null ? `Connected · ${probe.latencyMs}ms` : 'Connected',
        tone: 'ok',
        detail: probe.url,
      };
    case 'error':
      return {
        id,
        label,
        value: 'Unreachable',
        tone: 'destructive',
        detail: probe.error ? `${probe.url} (${probe.error})` : probe.url,
      };
    case 'checking':
      return { id, label, value: 'Checking', tone: 'muted', detail: probe.url };
    default:
      return { id, label, value: 'Disabled', tone: 'muted' };
  }
}

/**
 * Pure projection of the probes onto popover rows. Tones mirror the colours
 * the separate top-bar chips used, so `calm` and `full` agree on what counts
 * as a problem.
 */
export function summarizeSystemHealth(input: SystemHealthInput): HealthRow[] {
  const rows: HealthRow[] = [
    {
      id: 'ws',
      label: 'Backend WS',
      value: input.wsConnected ? 'Connected' : 'Disconnected',
      tone: input.wsConnected ? 'ok' : 'warning',
    },
  ];

  const server = input.server;
  if (server) {
    const heapLoad = server.memoryUsage.heapUsed / server.heapLimit;
    rows.push({
      id: 'server',
      label: 'WebUI server',
      value: `RAM ${formatCompactBytes(server.memoryUsage.rss)}`,
      tone: heapLoad >= 0.85 ? 'destructive' : heapLoad >= 0.6 ? 'warning' : 'ok',
      detail: `PID ${server.pid} · heap ${formatCompactBytes(server.memoryUsage.heapUsed)} / ${formatCompactBytes(server.heapLimit)}`,
    });
    const index = server.codebaseIndexServer;
    if (index) {
      const health = index.health;
      const metrics = health?.server;
      rows.push({
        id: 'index',
        label: 'Codebase index',
        value: health?.status ?? index.status,
        tone:
          index.status === 'connected'
            ? 'ok'
            : index.status === 'unresponsive' || index.status === 'error'
              ? 'destructive'
              : index.status === 'degraded' ||
                  index.status === 'connecting' ||
                  index.status === 'stopping'
                ? 'warning'
                : 'muted',
        detail:
          [
            index.pid ? `PID ${index.pid}` : null,
            health?.latencyMs != null ? `RTT ${health.latencyMs}ms` : null,
            metrics ? `RAM ${formatCompactBytes(metrics.memory.rss)}` : null,
            health?.missedHeartbeats ? `missed ${health.missedHeartbeats}` : null,
          ]
            .filter(Boolean)
            .join(' · ') || undefined,
      });
    }
  }

  if (input.droppedTools > 0) {
    rows.push({
      id: 'tools',
      label: 'Tools',
      value: `-${input.droppedTools} dropped`,
      tone: 'warning',
      detail: `${input.droppedTools} tool(s) dropped from provider requests due to maxTools limit`,
    });
  }

  rows.push(integrationRow('wrongproxy', 'WrongProxy', input.wrongProxy));
  rows.push(integrationRow('hq', 'HQ', input.hq));
  return rows;
}

/** The worst tone across the rows — what the chip itself shows. */
export function overallHealthTone(rows: readonly HealthRow[]): HealthTone {
  if (rows.some((r) => r.tone === 'destructive')) return 'destructive';
  if (rows.some((r) => r.tone === 'warning')) return 'warning';
  return 'ok';
}

const VALUE_TONE: Record<HealthTone, string> = {
  ok: 'text-success',
  muted: 'text-muted-foreground',
  warning: 'text-warning',
  destructive: 'text-destructive',
};

// ── Component ───────────────────────────────────────────────────────────────

export function SystemHealthChip({
  appVersion,
  onOpenIntegrations,
  ...input
}: SystemHealthInput & {
  appVersion?: string | undefined;
  onOpenIntegrations: () => void;
}) {
  const { t } = useAppTranslation();
  const rows = summarizeSystemHealth(input);
  const tone = overallHealthTone(rows);
  const issues = rows.filter((r) => r.tone === 'warning' || r.tone === 'destructive').length;
  const label =
    issues > 0
      ? t('activity:topbar.health.issues', {
          count: issues,
          defaultValue: `System: ${issues} issue(s)`,
        })
      : t('activity:topbar.health.ok', 'System: all good');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="system-health-chip"
          data-tone={tone}
          title={label}
          aria-label={label}
          className={cn(
            'relative inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs transition-colors hover:bg-accent/60',
            tone === 'ok' && 'text-muted-foreground hover:text-foreground',
            tone === 'warning' && 'bg-warning/15 text-foreground',
            tone === 'destructive' && 'bg-destructive/15 text-foreground',
          )}
        >
          <Activity
            className={cn(
              'h-3.5 w-3.5',
              tone === 'warning' && 'text-warning',
              tone === 'destructive' && 'text-destructive',
            )}
            aria-hidden
          />
          {issues > 0 ? <span className="tabular-nums font-medium">{issues}</span> : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="flex items-center justify-between">
          <span>{t('activity:topbar.health.heading', 'System health')}</span>
          {appVersion ? (
            <span className="font-mono text-[11px] font-normal text-muted-foreground">
              v{appVersion}
            </span>
          ) : null}
        </DropdownMenuLabel>
        <div className="space-y-1.5 px-2 py-1 text-xs">
          {rows.map((row) => (
            <div key={row.id} data-testid={`system-health-row-${row.id}`} title={row.detail}>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">{row.label}</span>
                <span className={cn('font-mono font-medium', VALUE_TONE[row.tone])}>
                  {row.value}
                </span>
              </div>
              {row.detail && row.tone !== 'ok' ? (
                <div className="truncate text-[11px] text-muted-foreground">{row.detail}</div>
              ) : null}
            </div>
          ))}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onOpenIntegrations}>
          {t('activity:topbar.health.openIntegrations', 'Integration settings')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
