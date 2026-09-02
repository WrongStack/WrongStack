/**
 * CronJobsPanel — overlay panel that displays all scheduled cron jobs.
 *
 * Reads live data from the Zustand cronStore (populated by cron.snapshot
 * and cron.job_fired WebSocket messages wired in Phase 2). Shows a
 * summary header and a scrollable table of every job with its status,
 * interval, run count, and next/last execution times.
 *
 * Integration: rendered in App.tsx when `cronJobsOpen` is true, same
 * pattern as ProcessMonitor and QueuePanel.
 */
import { Clock, PauseCircle, PlayCircle, RotateCw } from 'lucide-react';
import { useCallback } from 'react';
import { useAppTranslation } from '@/i18n';
import { useCronStore } from '@/stores';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogHeader,
  DialogDescription,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';

// Jobs are bounded (user-defined), show all without pagination.

// ── Props ──────────────────────────────────────────────────────────────────

interface CronJobsPanelProps {
  open: boolean;
  onClose: () => void;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtInterval(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = Date.now();
  const diff = d.getTime() - now;
  const abs = Math.abs(diff);

  if (abs < 60_000) return diff >= 0 ? '<1m' : '<1m ago';
  if (abs < 3_600_000) {
    const mins = Math.round(abs / 60_000);
    return diff >= 0 ? `${mins}m` : `${mins}m ago`;
  }
  if (abs < 86_400_000) {
    const hrs = Math.round(abs / 3_600_000);
    return diff >= 0 ? `${hrs}h` : `${hrs}h ago`;
  }
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function StatusBadge({ enabled, overdue }: { enabled: boolean; overdue: boolean }) {
  const { t } = useAppTranslation();
  if (!enabled)
    return (
      <Badge variant="secondary" className="gap-1">
        <PauseCircle className="h-3 w-3" />
        {t('activity:cronJobs.statusDisabled')}
      </Badge>
    );
  if (overdue)
    return (
      <Badge variant="destructive" className="gap-1">
        <Clock className="h-3 w-3" />
        {t('activity:cronJobs.statusOverdue')}
      </Badge>
    );
  return (
    <Badge variant="outline" className="gap-1 border-success/30 bg-success/10 text-success">
      <PlayCircle className="h-3 w-3" />
      {t('activity:cronJobs.statusActive')}
    </Badge>
  );
}

// ── Component ──────────────────────────────────────────────────────────────

export function CronJobsPanel({ open, onClose }: CronJobsPanelProps): React.ReactElement | null {
  const { t } = useAppTranslation();
  const snapshot = useCronStore((s) => s.snapshot);
  const lastFiredAt = useCronStore((s) => s.lastFiredAt);
  const revision = useCronStore((s) => s.revision);

  // Cast revision to a noop usage so the hook re-renders on store changes.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  void revision;

  const jobs = snapshot?.jobs ?? [];
  const count = snapshot?.count ?? 0;
  const maxConcurrent = snapshot?.maxConcurrent ?? 0;
  const overdueCount = jobs.filter((j) => j.overdue).length;
  const enabledCount = jobs.filter((j) => j.enabled).length;
  const totalRuns = jobs.reduce((s, j) => s + j.runCount, 0);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) onClose();
    },
    [onClose],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RotateCw className="h-5 w-5" />
            {t('activity:cronJobs.heading')}
          </DialogTitle>
          <DialogDescription>{t('activity:cronJobs.subtitle')}</DialogDescription>
        </DialogHeader>

        {/* Summary bar */}
        {count > 0 && (
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground border-b border-border/70 pb-3">
            <span className="font-medium text-foreground">
              {t('activity:cronJobs.jobCount', { count })}
            </span>
            <span className="text-success">
              {t('activity:cronJobs.enabledCount', { count: enabledCount })}
            </span>
            {overdueCount > 0 && (
              <span className="text-destructive">
                {t('activity:cronJobs.overdueCount', { count: overdueCount })}
              </span>
            )}
            <span>{t('activity:cronJobs.totalRuns', { count: totalRuns })}</span>
            <span className="text-muted-foreground/60">
              {t('activity:cronJobs.maxConcurrent', { count: maxConcurrent })}
            </span>
          </div>
        )}

        {/* Empty state */}
        {count === 0 && (
          <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
            <Clock className="h-8 w-8 opacity-40" />
            <p className="text-sm">{t('activity:cronJobs.emptyTitle')}</p>
            <p className="text-xs">
              {t('activity:cronJobs.emptyUse')}{' '}
              <code className="rounded bg-muted px-1 py-0.5">cron_schedule</code>{' '}
              {t('activity:cronJobs.emptyToAdd')}
            </p>
          </div>
        )}

        {/* Job table */}
        {count > 0 && (
          <ScrollArea className="flex-1 -mx-6 px-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
                  <th className="pb-2 pr-3 font-medium">{t('activity:cronJobs.thStatus')}</th>
                  <th className="pb-2 pr-3 font-medium">{t('activity:cronJobs.thName')}</th>
                  <th className="pb-2 pr-3 font-medium">{t('activity:cronJobs.thInterval')}</th>
                  <th className="pb-2 pr-3 font-medium text-right">
                    {t('activity:cronJobs.thRuns')}
                  </th>
                  <th className="pb-2 pr-3 font-medium">{t('activity:cronJobs.thNextRun')}</th>
                  <th className="pb-2 pr-3 font-medium">{t('activity:cronJobs.thLastRun')}</th>
                  <th className="pb-2 font-medium">{t('activity:cronJobs.thAction')}</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.name} className="border-b border-border/30 last:border-0">
                    <td className="py-2.5 pr-3">
                      <StatusBadge enabled={job.enabled} overdue={job.overdue} />
                    </td>
                    <td
                      className="py-2.5 pr-3 font-mono text-xs font-medium max-w-[160px] truncate"
                      title={job.name}
                    >
                      {job.name}
                    </td>
                    <td className="py-2.5 pr-3 font-mono text-xs tabular-nums">
                      {fmtInterval(job.intervalMs)}
                    </td>
                    <td className="py-2.5 pr-3 text-right font-mono text-xs tabular-nums">
                      {job.runCount}
                      {lastFiredAt[job.name] && (
                        <span
                          className="ml-1 text-success"
                          title={t('activity:cronJobs.lastFiredAtTitle', {
                            time: lastFiredAt[job.name],
                          })}
                        >
                          ●
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 font-mono text-xs tabular-nums">
                      {fmtTime(job.nextRun)}
                    </td>
                    <td className="py-2.5 pr-3 font-mono text-xs tabular-nums">
                      {fmtTime(job.lastRun)}
                    </td>
                    <td
                      className="py-2.5 font-mono text-xs max-w-[200px] truncate text-muted-foreground"
                      title={job.action}
                    >
                      {job.action}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollArea>
        )}
        {/* Footer hint */}
        {count > 0 && (
          <p className="text-xs text-muted-foreground pt-3 border-t border-border/70">
            {t('activity:cronJobs.footerUse')}{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-[11px]">cron_schedule</code>{' '}
            {t('activity:cronJobs.footerToAdd')}
            <code className="rounded bg-muted px-1 py-0.5 text-[11px] ml-1">cron_cancel</code>{' '}
            {t('activity:cronJobs.footerToRemove')}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
