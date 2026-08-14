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
  enqueueSequence = seq;
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
