import { splitReferenceMessage } from './composer-resources-model';
import { displayLocale } from './display-dates';
import type { EngineState } from './engine-state';

/** Messages rendered at once in a conversation; each "Show earlier" adds this many. */
export const TRANSCRIPT_WINDOW = 150;

/** How many of the oldest messages stay unrendered when `shown` newest ones are rendered. */
export function hiddenMessageCount(total: number, shown: number): number {
  return Math.max(0, total - Math.max(0, shown));
}

/** One searchable line per message: its visible text, without the file-reference block. */
export function transcriptSearchText(
  messages: readonly Pick<EngineState['messages'][number], 'role' | 'text'>[],
) {
  return messages
    .map((message) =>
      (message.role === 'user' ? splitReferenceMessage(message.text).text : message.text).replace(
        /\s+/g,
        ' ',
      ),
    )
    .join('\n');
}

const dayKey = (at: number) => new Date(at).toDateString();

/**
 * The day separator before `message`: its day when the message before it was written on another
 * day (or has no time), so a long conversation reads by day as in the WebUI. Messages without a
 * time (older journals) get none.
 */
export function dayLabel(
  message: { at?: number | undefined },
  previous: { at?: number | undefined } | undefined,
  now = Date.now(),
): string | undefined {
  if (!message.at) return undefined;
  if (previous?.at && dayKey(previous.at) === dayKey(message.at)) return undefined;
  if (dayKey(message.at) === dayKey(now)) return 'Today';
  if (dayKey(message.at) === dayKey(now - 86_400_000)) return 'Yesterday';
  return new Date(message.at).toLocaleDateString(displayLocale(), {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year:
      new Date(message.at).getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric',
  });
}

const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** How far a first read of a long conversation got, as the WebUI's restore progress says it. */
export function replayProgress(replay: { read: number; total: number }): string {
  const percent = Math.min(100, Math.floor((replay.read / replay.total) * 100));
  return `${percent}% · ${megabytes(replay.read)} of ${megabytes(replay.total)}`;
}
