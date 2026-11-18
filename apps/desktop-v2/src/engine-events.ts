import type { EngineEvent } from './engine-state-types';
import { record } from './engine-values';

/** Normalize journal input before it reaches operations or React's state updater. */
export function engineEvent(value: unknown): EngineEvent | null {
  const row = record(value);
  if (typeof row['type'] !== 'string' || !row['type']) return null;
  const at = row['at'];
  return {
    type: row['type'],
    payload: record(row['payload']),
    ...(typeof at === 'number' && at > 0 ? { at } : {}),
  };
}
/**
 * Joins runs of streamed answer text in one journal page: consecutive `provider.text_delta`
 * frames that differ only in their text become one frame with the joined text and the first
 * frame's time; `lastAt` is the run's latest time. Each delta used to copy the whole message
 * list, so reading a long conversation grew with its length squared.
 */
export function coalesceTextDeltas(
  events: readonly EngineEvent[],
): { event: EngineEvent; lastAt?: number }[] {
  const out: { event: EngineEvent; lastAt?: number; rest?: string }[] = [];
  for (const event of events) {
    const text = event.payload['text'];
    if (event.type !== 'provider.text_delta' || typeof text !== 'string') {
      out.push({ event });
      continue;
    }
    const { text: _text, ...others } = event.payload;
    const rest = JSON.stringify(others);
    const previous = out.at(-1);
    if (previous?.rest === rest) {
      previous.event = {
        ...previous.event,
        payload: {
          ...previous.event.payload,
          text: `${previous.event.payload['text'] as string}${text}`,
        },
      };
      if (event.at) previous.lastAt = event.at;
      continue;
    }
    out.push({ event, rest, ...(event.at ? { lastAt: event.at } : {}) });
  }
  return out.map(({ event, lastAt }) => (lastAt ? { event, lastAt } : { event }));
}
