/**
 * EventTimeline — last 20 fleet events with relative timestamps.
 *
 * Renders a compact scrollable list of fleet events matching the TUI's
 * fleet event timeline for the Fleet Monitor overlay.
 */

import { i18n, useAppTranslation } from '@/i18n';
import type { FleetTimelineEvent } from '@/stores';

interface EventTimelineProps {
  events: FleetTimelineEvent[];
  /** Max events to render (default 20). */
  max?: number;
  className?: string;
}

function relTime(ts: number): string {
  const delta = Date.now() - ts;
  if (delta < 5_000) return i18n.t('common:time.justNow');
  if (delta < 60_000)
    return i18n.t('common:time.compactSecondsAgo', { count: Math.floor(delta / 1_000) });
  if (delta < 3_600_000)
    return i18n.t('common:time.compactMinutesAgo', { count: Math.floor(delta / 60_000) });
  return i18n.t('common:time.compactHoursAgo', { count: Math.floor(delta / 3_600_000) });
}

const KIND_ICONS: Record<FleetTimelineEvent['kind'], string> = {
  spawned: '🚀',
  task_started: '▶',
  tool_executed: '⚡',
  iteration_summary: '🔄',
  budget_warning: '!',
  budget_extended: '⚡',
  task_completed: '✅',
  ctx_pct: '💬',
  leader_updated: '👑',
};

export function EventTimeline({ events, max = 20, className }: EventTimelineProps) {
  const { t } = useAppTranslation();
  const visible = events.slice(0, max);

  if (visible.length === 0) {
    return (
      <div className={`py-4 text-center text-xs text-muted-foreground ${className ?? ''}`}>
        {t('activity:timeline.noEvents')}
      </div>
    );
  }

  return (
    <div className={`space-y-0.5 overflow-y-auto max-h-48 ${className ?? ''}`}>
      {visible.map((ev) => (
        <div
          key={ev.id}
          className="flex items-start gap-2 text-[10px] leading-tight py-0.5 px-1 rounded hover:bg-accent/50 transition-colors"
        >
          <span className="shrink-0 w-5 text-center" aria-hidden="true">
            {KIND_ICONS[ev.kind] ?? '·'}
          </span>
          <span className="shrink-0 w-12 text-right text-muted-foreground font-mono tabular-nums">
            {relTime(ev.timestamp)}
          </span>
          <span className="truncate text-foreground/90">{ev.message}</span>
          {ev.value !== undefined && ev.kind === 'tool_executed' && (
            <span className="ml-auto shrink-0 tabular-nums text-muted-foreground font-mono">
              {ev.value >= 1000 ? `${(ev.value / 1000).toFixed(1)}s` : `${ev.value}ms`}
            </span>
          )}
          {ev.value !== undefined && ev.kind === 'ctx_pct' && (
            <span className="ml-auto shrink-0 tabular-nums text-muted-foreground font-mono">
              {ev.value}%
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
