import { ArrowDownAZ, ArrowUpAZ, Trash2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { type QueuedItem, type QueueMode, sortQueueForDisplay } from './lib/queue-model.js';

const MODE_TITLE: Record<QueueMode, string> = {
  btw: 'Rides alongside the run; sent at the next turn boundary',
  steer: 'Interrupts the run, then sends',
  queue: 'Held until the current run finishes',
};

interface QueuedMessagesProps {
  queue: readonly QueuedItem[];
  onClear: () => void;
  onRemove: (id: string) => void;
}

/** Pending send-queue, rendered above the textarea. */
export function QueuedMessages({ queue, onClear, onRemove }: QueuedMessagesProps) {
  const [sortDir, setSortDir] = useState<'oldest' | 'newest'>('oldest');
  // Sort a copy only. The stored order is the drain order — reordering it
  // here would change what the agent actually receives next.
  const sorted = useMemo(() => sortQueueForDisplay(queue, sortDir), [queue, sortDir]);

  if (queue.length === 0) return null;

  return (
    <section className="queue-strip" aria-label="Queued messages">
      <div className="queue-head">
        <span>QUEUED ({queue.length})</span>
        <div className="queue-head-actions">
          <button
            type="button"
            onClick={() => setSortDir((current) => (current === 'newest' ? 'oldest' : 'newest'))}
            title={sortDir === 'newest' ? 'Showing newest first' : 'Showing oldest first'}
          >
            {sortDir === 'newest' ? (
              <ArrowDownAZ size={11} aria-hidden="true" />
            ) : (
              <ArrowUpAZ size={11} aria-hidden="true" />
            )}
            {sortDir === 'newest' ? 'NEWEST' : 'OLDEST'}
          </button>
          <button type="button" onClick={onClear} title="Clear the queue">
            <Trash2 size={11} aria-hidden="true" />
            CLEAR
          </button>
        </div>
      </div>
      <ul className="queue-list">
        {sorted.map((item) => {
          // Image-only holds (F1) carry no text — describe them so the row
          // is not blank and the remove control stays labelled.
          const summary =
            item.text ||
            (item.images?.length
              ? `${item.images.length} image${item.images.length === 1 ? '' : 's'} attached`
              : '');
          return (
            <li key={item.id} data-queue-mode={item.mode}>
              <span className={`queue-tag ${item.mode}`} title={MODE_TITLE[item.mode]}>
                {item.mode}
              </span>
              <span className="queue-text">{summary}</span>
              <button
                type="button"
                onClick={() => onRemove(item.id)}
                aria-label={`Remove queued message: ${summary.slice(0, 40)}`}
              >
                <X size={11} />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
