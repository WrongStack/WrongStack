/** Send-mode queue model — the `btw` / `steer` / `queue` trio.
 *
 * The queue is deliberately client-side: the server has no queue protocol.
 * A held message is replayed as a plain `user_message` once the in-flight
 * run reports `run.result`, so the agent sees it at a turn boundary rather
 * than mid-iteration.
 */

/** How a submitted message relates to an in-flight run.
 *
 *  - `btw`   — ride alongside without interrupting. While a run is in
 *              flight the message is held and drained at the next turn
 *              boundary; while idle it is an ordinary send.
 *  - `steer` — interrupt the run, then send, so the agent picks up the
 *              redirect immediately. While idle there is nothing to abort
 *              and it collapses to an ordinary send.
 *  - `queue` — always held, even while idle, and drained in arrival order
 *              after the next run completes.
 */
export type QueueMode = 'btw' | 'steer' | 'queue';

export interface QueuedItem {
  id: string;
  text: string;
  mode: QueueMode;
  /** Epoch ms of enqueue — drives the newest/oldest display sort. */
  addedAt: number;
  /**
   * Images attached in the composer when the message was queued. The queue
   * must carry them or a queued send silently strips the attachments; the
   * drain maps them onto the same `user_message.images` payload the direct
   * send path uses. `mediaType` is added at drain time, not stored here.
   */
  images?: { data: string; mime: string }[] | undefined;
}

/** What a submit in `mode` should do given the current run state.
 *
 *  `abort-then-enqueue-front` deliberately does NOT send inline. Aborting a
 *  run makes the server emit that run's `run.result`, which fires the drain;
 *  a message sent inline would race it and a second, queued message would go
 *  out alongside. Parking the steer at the head of the queue lets that same
 *  drain deliver it — no race, and the steer still jumps the line.
 */
export type SendPlan = 'send' | 'enqueue' | 'abort-then-enqueue-front';

/** Decide how a submit resolves. The single source of send-mode truth —
 *  the composer and its tests both read the matrix from here. */
export function resolveSendPlan(mode: QueueMode, running: boolean): SendPlan {
  if (mode === 'queue') return 'enqueue';
  // Idle: nothing to interrupt and no run.result coming, so every mode but
  // an explicit `queue` sends straight through.
  if (!running) return 'send';
  return mode === 'steer' ? 'abort-then-enqueue-front' : 'enqueue';
}

export function enqueueItem(queue: readonly QueuedItem[], item: QueuedItem): QueuedItem[] {
  return [...queue, item];
}

/** Park an item at the head so the next drain picks it first. */
export function enqueueFront(queue: readonly QueuedItem[], item: QueuedItem): QueuedItem[] {
  return [item, ...queue];
}

/** Pop the oldest item. Arrival order is the drain order — display sorting
 *  never touches the stored order. */
export function dequeueItem(queue: readonly QueuedItem[]): {
  item: QueuedItem | null;
  rest: QueuedItem[];
} {
  if (queue.length === 0) return { item: null, rest: [...queue] };
  const [first, ...rest] = queue;
  return { item: first ?? null, rest };
}

export function removeQueuedAt(queue: readonly QueuedItem[], index: number): QueuedItem[] {
  if (index < 0 || index >= queue.length) return [...queue];
  return queue.filter((_, i) => i !== index);
}

/** Sort a copy for display. The stored order stays canonical. */
export function sortQueueForDisplay(
  queue: readonly QueuedItem[],
  direction: 'oldest' | 'newest',
): QueuedItem[] {
  return [...queue].sort((a, b) =>
    direction === 'newest' ? b.addedAt - a.addedAt : a.addedAt - b.addedAt,
  );
}
