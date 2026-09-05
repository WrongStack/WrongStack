import type { WSClientMessage } from '../types';

export interface QueueState {
  messageQueue: WSClientMessage[];
  messageQueueChars: number;
  messageQueueWeights: WeakMap<object, number>;
}

/**
 * FIFO-drop oldest by both count and serialized size. A count-only cap
 * still allows a disconnected tab to retain hundreds of multi-megabyte
 * image messages.
 */
export function enqueueMessage(
  queueState: QueueState,
  message: WSClientMessage,
  serialized: string,
  maxQueuedMessages: number,
  maxQueuedChars: number,
): boolean {
  let firstDropped: WSClientMessage | undefined;
  while (
    queueState.messageQueue.length > 0 &&
    (queueState.messageQueue.length >= maxQueuedMessages ||
      queueState.messageQueueChars + serialized.length > maxQueuedChars)
  ) {
    const dropped = queueState.messageQueue.shift();
    if (!dropped) break;
    firstDropped ??= dropped;
    const weight =
      queueState.messageQueueWeights.get(dropped as object) ?? JSON.stringify(dropped).length;
    queueState.messageQueueChars = Math.max(0, queueState.messageQueueChars - weight);
    queueState.messageQueueWeights.delete(dropped as object);
  }
  if (firstDropped) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'ws_client.message_queue_full',
        cap: maxQueuedMessages,
        charCap: maxQueuedChars,
        droppedType: firstDropped.type,
        timestamp: new Date().toISOString(),
      }),
    );
  }
  queueState.messageQueue.push(message);
  queueState.messageQueueWeights.set(message as object, serialized.length);
  queueState.messageQueueChars += serialized.length;
  return true;
}

/**
 * Drain the offline queue onto a freshly-opened socket.
 * Local array drain makes the loop finite even if socket state changes.
 */
export function flushMessageQueueHelper(
  queueState: QueueState,
  sendFn: (msg: WSClientMessage) => void,
): void {
  const pending = queueState.messageQueue.splice(0);
  queueState.messageQueueChars = 0;
  for (const msg of pending) {
    try {
      sendFn(msg);
    } catch (err) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'ws.flush_failed',
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
}
