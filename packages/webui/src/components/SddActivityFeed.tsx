import { Activity } from 'lucide-react';
import { fmtAgo, SDD_FEED_KIND } from '@/lib/sdd-theme';
import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/i18n';
import type { SddBoardFeedEntry } from '@/stores';

/**
 * SddActivityFeed — the live "what just happened" ticker: each task pickup,
 * completion, failure, retry, wave and deadlock as a timestamped line. The
 * default content of the board's side panel.
 */
export function SddActivityFeed({
  feed,
  now,
}: {
  feed: SddBoardFeedEntry[];
  now: number;
}): React.ReactElement {
  const { t } = useAppTranslation();
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-2 text-xs font-semibold text-foreground">
        <Activity className="h-3.5 w-3.5 text-warning" />
        {t('activity:sdd.activityHeading')}
      </div>
      <div className="min-h-0 min-w-0 flex-1 space-y-1 overflow-auto p-2">
        {feed.length === 0 ? (
          <p className="px-1 pt-4 text-center text-[11px] text-muted-foreground">
            {t('activity:sdd.feedEmpty')}
          </p>
        ) : (
          feed.map((e, i) => {
            const k = SDD_FEED_KIND[e.kind] ?? SDD_FEED_KIND.started;
            const Icon = k.icon;
            return (
              <div
                key={`${e.ts}-${i}`}
                className={cn(
                  'sdd-rise flex items-start gap-2 rounded-md px-2 py-1.5 text-[11px]',
                  i === 0 ? 'bg-muted' : 'hover:bg-muted',
                )}
              >
                <Icon className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', k.color)} />
                <span className="flex-1 leading-snug text-foreground">{e.text}</span>
                <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">
                  {fmtAgo(e.ts, now)}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
