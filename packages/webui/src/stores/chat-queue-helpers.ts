import type { QueuedItem } from './chat-store-types';

export const dispatchedGraceTimers = new Map<number, ReturnType<typeof setTimeout>>();

export function cancelDispatchedGraceTimer(itemId: number): void {
  const handle = dispatchedGraceTimers.get(itemId);
  if (handle === undefined) return;
  clearTimeout(handle);
  dispatchedGraceTimers.delete(itemId);
}

export let enqueueSequence = 0;

export function setEnqueueSequence(seq: number): void {
  enqueueSequence = Number.isFinite(seq) ? Math.max(0, Math.floor(seq)) : 0;
}

export function nextQueueItemId(): number {
  enqueueSequence += 1;
  return enqueueSequence;
}

export function normalizeQueuedItem(value: unknown): QueuedItem | null {
  if (typeof value !== 'object' || value === null) return null;
  const item = value as Partial<QueuedItem>;
  if (
    typeof item.text !== 'string' ||
    (item.mode !== 'btw' && item.mode !== 'steer' && item.mode !== 'queue') ||
    typeof item.addedAt !== 'number' ||
    !Number.isFinite(item.addedAt)
  ) {
    return null;
  }
  const itemId =
    typeof item.itemId === 'number' && Number.isSafeInteger(item.itemId) && item.itemId > 0
      ? item.itemId
      : nextQueueItemId();
  enqueueSequence = Math.max(enqueueSequence, itemId);
  return {
    text: item.text,
    mode: item.mode,
    addedAt: item.addedAt,
    itemId,
    ...(item.images ? { images: item.images } : {}),
  };
}

export const BTW_DISPATCH_GRACE_MS = 1_800;

/**
 * Hands a `queue`-mode prompt to the server's session queue. Returns false
 * when the server cannot take it (older server, disconnected, no session yet),
 * and the lane then keeps it locally the way it always has.
 */
export type RemotePromptQueue = (
  sessionId: string,
  text: string,
  images: QueuedItem['images'],
) => boolean;

let remotePromptQueue: RemotePromptQueue | null = null;

/** Installed by the WebSocket layer, which knows whether the server has a queue. */
export function setRemotePromptQueue(queue: RemotePromptQueue | null): void {
  remotePromptQueue = queue;
}

export function getRemotePromptQueue(): RemotePromptQueue | null {
  return remotePromptQueue;
}
