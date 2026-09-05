import { ArrowDownAZ, ArrowUpAZ, Check, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import type { QueuedItem, QueueMode } from '@/stores/chat-store';

type SortDir = 'oldest' | 'newest';

const MODE_META: Record<QueueMode, { label: string; tone: string; titleKey: string }> = {
  btw: {
    label: 'btw',
    tone: 'bg-primary/10 text-primary border-primary/30',
    titleKey: 'btwTitle',
  },
  steer: {
    label: 'steer',
    tone: 'bg-warning/10 text-warning border-warning/30',
    titleKey: 'steerTitle',
  },
  queue: {
    label: 'queue',
    tone: 'bg-info/10 text-info border-info/30',
    titleKey: 'queueTitle',
  },
};

interface QueuedMessagesProps {
  queue: readonly QueuedItem[];
  onClear: () => void;
  onRemove: (index: number) => void;
}

export function QueuedMessages({ queue, onClear, onRemove }: QueuedMessagesProps) {
  const { t } = useAppTranslation();
  const [sortDir, setSortDir] = useState<SortDir>('oldest');

  // Sort a copy so the underlying store stays in arrival order.
  // The store order matters for the drain loop in run.result — sorting
  // here for display must never disturb the actual send order.
  const sortedQueue = useMemo(() => {
    const copy = queue.slice();
    copy.sort((a, b) => (sortDir === 'newest' ? b.addedAt - a.addedAt : a.addedAt - b.addedAt));
    return copy;
  }, [queue, sortDir]);

  if (queue.length === 0) return null;

  // `alreadyDispatched` items have already been wire-sent — removing or
  // clearing them from the UI cannot retract the note the agent will
  // already act on. Hide the "Clear all" affordance when EVERY item is
  // dispatched (clearing already-sent chips alone is pointless); while any
  // pending item is present the button clears the WHOLE queue via `onClear`
  // (the store's `clearQueue` resets the queue, dispatched items included).
  const allDispatched = queue.every((q) => q.alreadyDispatched);

  return (
    <div className="rounded-lg border bg-muted/30 p-2 text-xs" data-testid="inline-queue">
      <div className="flex items-center justify-between mb-1.5 gap-2">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium shrink-0">
          {t('activity:queue.heading')} ({queue.length})
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setSortDir((d) => (d === 'newest' ? 'oldest' : 'newest'))}
            className={cn(
              'inline-flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors px-1.5 py-0.5 rounded text-[10px]',
              'hover:bg-muted',
            )}
            title={
              sortDir === 'newest'
                ? t('activity:queue.sortNewestTitle')
                : t('activity:queue.sortOldestTitle')
            }
            data-testid="inline-queue-sort"
          >
            {sortDir === 'newest' ? (
              <ArrowDownAZ className="h-3 w-3" />
            ) : (
              <ArrowUpAZ className="h-3 w-3" />
            )}
            {sortDir === 'newest' ? t('activity:queue.newest') : t('activity:queue.oldest')}
          </button>
          {!allDispatched && (
            <button
              type="button"
              onClick={onClear}
              className="inline-flex items-center gap-1 text-muted-foreground hover:text-destructive transition-colors px-1.5 py-0.5 rounded text-[10px]"
              title={t('activity:queue.clearDispatchedTitle')}
              data-testid="inline-queue-clear-all"
            >
              <Trash2 className="h-3 w-3" />
              {t('activity:queue.clear')}
            </button>
          )}
        </div>
      </div>
      <ul className="space-y-1">
        {sortedQueue.map((item) => {
          const sourceIdx = queue.indexOf(item);
          const meta = MODE_META[item.mode];
          const dispatched = item.alreadyDispatched === true;
          return (
            <li
              // The addedAt+sourceIdx pair uniquely identifies the item even
              // if two items happen to share the same addedAt ms (rare but
              // possible under synthetic timers in tests).
              key={`${item.addedAt}-${sourceIdx}`}
              className={cn(
                'flex items-start justify-between gap-2 rounded border px-2 py-1',
                dispatched
                  ? 'bg-muted/40 border-dashed text-muted-foreground'
                  : 'bg-background/60 border-solid',
              )}
              data-testid="inline-queue-item"
              data-queue-mode={item.mode}
              data-dispatched={dispatched ? 'true' : undefined}
            >
              <div className="flex items-start gap-1.5 min-w-0 flex-1">
                <span
                  className={cn(
                    'shrink-0 inline-flex items-center justify-center text-[9px] font-semibold uppercase tracking-wider px-1 py-px rounded border mt-0.5',
                    meta.tone,
                    dispatched && 'opacity-60',
                  )}
                  title={t(`activity:queue.${meta.titleKey}`)}
                >
                  {meta.label}
                </span>
                <span className="truncate flex-1 min-w-0">{item.text}</span>
                {dispatched && (
                  <span
                    className="shrink-0 inline-flex items-center gap-0.5 text-[9px] font-semibold uppercase tracking-wider text-success mt-0.5"
                    title={t('activity:queue.dispatchedTitle')}
                    data-testid={`inline-queue-dispatched-${sourceIdx}`}
                  >
                    <Check className="h-2.5 w-2.5" />
                    {t('activity:queue.dispatchedLabel')}
                  </span>
                )}
              </div>
              {!dispatched && (
                <button
                  type="button"
                  onClick={() => onRemove(sourceIdx)}
                  className="text-muted-foreground hover:text-destructive shrink-0"
                  title={t('activity:queue.removeTitle')}
                  data-testid={`inline-queue-remove-${sourceIdx}`}
                >
                  ×
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
