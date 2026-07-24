/**
 * CronTrigger — compact topbar button showing active cron count.
 *
 * Reads the Zustand cronStore snapshot and displays the number of active
 * (enabled + not overdue) jobs. When an overdue job exists, shows a
 * warning-style badge. Clicking the button opens the CronJobsPanel overlay.
 */
import { RotateCw } from 'lucide-react';
import { useCronStore, useUIStore } from '@/stores';
import { cn } from '@/lib/utils';

export function CronTrigger(): React.ReactElement | null {
  const snapshot = useCronStore((s) => s.snapshot);
  const setCronJobsOpen = useUIStore((s) => s.setCronJobsOpen);

  const jobs = snapshot?.jobs ?? [];
  const overdueCount = jobs.filter((j) => j.overdue).length;
  const activeCount = jobs.filter((j) => j.enabled && !j.overdue).length;
  const total = jobs.length;

  if (total === 0) return null;

  return (
    <button
      type="button"
      onClick={() => setCronJobsOpen(true)}
      className={cn(
        'relative inline-flex h-8 items-center gap-1.5 rounded-md border px-2 text-xs transition-colors',
        overdueCount > 0
          ? 'border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/15'
          : 'border-border/70 bg-background/60 text-muted-foreground hover:bg-accent/60 hover:text-foreground',
      )}
      title={`${total} cron job${total !== 1 ? 's' : ''}${overdueCount > 0 ? `, ${overdueCount} overdue` : ''}`}
    >
      <RotateCw className="h-3.5 w-3.5" />
      <span className="hidden lg:inline">
        {activeCount}/{total}
      </span>
      {overdueCount > 0 ? (
        <span className="min-w-4 bg-destructive/15 px-1 text-[10px] font-semibold tabular-nums text-destructive">
          {overdueCount > 99 ? '99+' : overdueCount}
        </span>
      ) : null}
    </button>
  );
}
