/**
 * The most recent mailbox envelope in the live ring — used by the nav badge
 * and any surface that wants to show "what just arrived" without re-scanning
 * the whole events buffer at render time.
 */
import type { HqEventEnvelope, HqMailboxEventPayload } from '@wrongstack/core/hq';
import { useHqStore } from '../data/store/index.js';

export function useLatestMailboxEvent(): HqEventEnvelope<HqMailboxEventPayload> | null {
  const events = useHqStore((state) => state.events);
  for (let index = events.length - 1; index >= 0; index--) {
    const candidate = events[index];
    if (
      candidate !== undefined &&
      candidate.type === 'mailbox.event' &&
      typeof candidate.payload === 'object' &&
      candidate.payload !== null
    ) {
      return candidate as HqEventEnvelope<HqMailboxEventPayload>;
    }
  }
  return null;
}
