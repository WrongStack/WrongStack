import { ArrowDownAZ, ArrowUpAZ, Check, ListOrdered, Trash2, X } from 'lucide-react';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { useActiveSessionId, useChatStore } from '@/stores';
import { onLaneDisposed } from '@/stores/chat-lanes';
import type { QueuedItem, QueueMode } from '@/stores/chat-store';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';

type SortDir = 'oldest' | 'newest';

const MODE_META: Record<QueueMode, { label: string; titleKey: string; tone: string }> = {
  btw: {
    label: 'btw',
    titleKey: 'btwTitle',
    tone: 'bg-primary/10 text-primary border-primary/30',
  },
  steer: {
    label: 'steer',
    titleKey: 'steerTitle',
    tone: 'bg-warning/10 text-warning border-warning/35',
  },
  queue: {
    label: 'queue',
    titleKey: 'queueTitle',
    tone: 'bg-info/10 text-info border-info/30',
  },
};

const QUEUE_PANEL_NO_SESSION = '__no_session__';
const queueSortBySession = new Map<string, SortDir>();
const disposedQueuePanelSessions = new Set<string>();

onLaneDisposed((sessionId) => {
  queueSortBySession.delete(sessionId);
  disposedQueuePanelSessions.add(sessionId);
});

/** Queue Panel overlay — triggered by /queue slash command.
 *  Shows the pending message queue and lets users dequeue or clear items. */
export interface QueuePanelProps {
  open: boolean;
  onClose: () => void;
  className?: string;
}

export function QueuePanel({
  open,
  onClose,
  className,
}: QueuePanelProps): React.ReactElement | null {
  const { t } = useAppTranslation();
  const queue = useChatStore((s) => s.queue);
  const removeQueued = useChatStore((s) => s.removeQueued);
  const clearQueue = useChatStore((s) => s.clearQueue);
  const [sortDir, setSortDir] = useState<SortDir>('oldest');
  const sessionId = useActiveSessionId();
  const sortSessionRef = useRef<string>(sessionId ?? QUEUE_PANEL_NO_SESSION);

  useLayoutEffect(() => {
    if (!disposedQueuePanelSessions.has(sortSessionRef.current)) {
      queueSortBySession.set(sortSessionRef.current, sortDir);
    }
    const next = sessionId ?? QUEUE_PANEL_NO_SESSION;
    disposedQueuePanelSessions.delete(next);
    setSortDir(queueSortBySession.get(next) ?? 'oldest');
    sortSessionRef.current = next;
  }, [sessionId]);

  const handleRemove = useCallback(
    (index: number) => {
      removeQueued(index);
    },
    [removeQueued],
  );

  // Display the queue in the user's chosen order. Sorting never mutates
  // the underlying store — we only reorder a local copy for rendering.
  // The store keeps items in arrival order; only this view flips them.
  //
  // Thread the source index alongside each item so the render loop can use
  // it directly for removal without an O(n) `indexOf` per row. Without
  // this, the render loop is O(n²) for queue length.
  const sortedQueue = useMemo(() => {
    // Copy first because Array#sort mutates in place, and the store array
    // is shared by reference with the rest of the app. Pair each item
    // with its index in the ORIGINAL array so removal still targets the
    // correct entry after sort.
    const indexed = queue.map((item, sourceIdx) => ({ item, sourceIdx }));
    indexed.sort((a, b) =>
      sortDir === 'newest' ? b.item.addedAt - a.item.addedAt : a.item.addedAt - b.item.addedAt,
    );
    return indexed;
  }, [queue, sortDir]);
  // Queue is bounded (user-queued items), show all without pagination.

  // Hide the destructive "Clear all" button when EVERY queued item has
  // already been wire-dispatched: clearing them locally cannot retract the
  // mailbox note the agent will already act on. With mixed queues the
  // button stays available so the user can drop the still-pending items.
  const allDispatched = queue.length > 0 && queue.every((q) => q.alreadyDispatched);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent
        className={cn(
          'max-w-lg gap-0 overflow-hidden border-border/80 bg-card p-0 pt-[10dvh] flex flex-col max-h-[70dvh]',
          className,
        )}
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">{t('activity:queue.heading')}</DialogTitle>
        <DialogDescription className="sr-only">
          {t('activity:queue.subtitle', { count: queue.length })}
        </DialogDescription>
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/70 bg-card/95 px-4 py-3 shrink-0">
          <div className="flex items-center gap-2.5">
            <span className="flex items-center justify-center w-8 h-8 rounded-md border border-primary/20 bg-primary/10 text-primary">
              <ListOrdered className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-sm font-semibold">{t('activity:queue.heading')}</h2>
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {t('activity:queue.subtitle', { count: queue.length })}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setSortDir((d) => (d === 'newest' ? 'oldest' : 'newest'))}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs transition-colors font-medium',
                'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
              title={
                sortDir === 'newest'
                  ? t('activity:queue.sortNewestTitle')
                  : t('activity:queue.sortOldestTitle')
              }
              data-testid="queue-sort-toggle"
            >
              {sortDir === 'newest' ? (
                <ArrowDownAZ className="h-3 w-3" />
              ) : (
                <ArrowUpAZ className="h-3 w-3" />
              )}
              {sortDir === 'newest' ? t('activity:queue.newest') : t('activity:queue.oldest')}
            </button>
            {queue.length > 0 && !allDispatched && (
              <button
                type="button"
                onClick={() => clearQueue()}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs text-destructive hover:bg-destructive/10 transition-colors font-medium"
                title={t('activity:queue.clearDispatchedTitle')}
                data-testid="queue-clear-all"
              >
                <Trash2 className="h-3 w-3" />
                {t('activity:queue.clear')}
              </button>
            )}
          </div>
        </div>

        {/* Queue list */}
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain">
          {queue.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
              <ListOrdered className="h-10 w-10 opacity-15" />
              <p className="text-sm font-medium">{t('activity:queue.emptyTitle')}</p>
              <p className="text-xs text-center max-w-xs">{t('activity:queue.emptyBody')}</p>
            </div>
          ) : (
            <ul className="divide-y divide-border/60" data-testid="queue-list">
              {sortedQueue.map(({ item, sourceIdx }, idx) => {
                // sourceIdx was threaded through the sort so removal
                // targets the correct entry in the underlying store.
                const meta = MODE_META[item.mode];
                const dispatched = item.alreadyDispatched === true;
                return (
                  <li
                    key={`${item.addedAt}-${sourceIdx}`}
                    className={cn(
                      'flex items-start justify-between gap-3 px-4 py-3 text-xs transition-colors',
                      dispatched
                        ? 'bg-muted/30 text-muted-foreground hover:bg-muted/40'
                        : 'hover:bg-muted/35',
                    )}
                    data-testid="queue-item"
                    data-dispatched={dispatched ? 'true' : undefined}
                  >
                    <div className="flex items-start gap-3 min-w-0 flex-1">
                      <span className="mt-1 text-[10px] font-mono text-muted-foreground shrink-0 w-5 text-right tabular-nums">
                        {idx + 1}.
                      </span>
                      <span
                        className={cn(
                          'shrink-0 inline-flex items-center justify-center rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase',
                          meta.tone,
                          dispatched && 'opacity-60',
                        )}
                        title={t(`activity:queue.${meta.titleKey}`)}
                        data-testid={`queue-mode-${item.mode}`}
                      >
                        {meta.label}
                      </span>
                      <p className="text-sm leading-relaxed min-w-0 break-words flex-1">
                        {item.text.length > 120 ? `${item.text.slice(0, 117)}…` : item.text}
                      </p>
                      {dispatched && (
                        <span
                          className="shrink-0 mt-0.5 inline-flex items-center gap-1 text-[10px] font-semibold uppercase text-success"
                          title={t('activity:queue.dispatchedTitle')}
                          data-testid={`queue-dispatched-${sourceIdx}`}
                        >
                          <Check className="h-3 w-3" />
                          {t('activity:queue.dispatchedLabel')}
                        </span>
                      )}
                    </div>
                    {!dispatched && (
                      <button
                        type="button"
                        onClick={() => handleRemove(sourceIdx)}
                        className="ml-1 p-1.5 rounded-md shrink-0 hover:bg-destructive/10 hover:text-destructive transition-colors"
                        title={t('activity:queue.removeTitle')}
                        data-testid={`queue-remove-${sourceIdx}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Footer hint */}
        {queue.length > 0 && (
          <div className="border-t border-border/70 bg-muted/20 px-4 py-2.5 shrink-0">
            <p className="text-[10px] text-muted-foreground text-center">
              {t('activity:queue.footer')}
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// Re-export for tests that want to inspect the item shape without
// importing the store directly.
export type { QueuedItem };
