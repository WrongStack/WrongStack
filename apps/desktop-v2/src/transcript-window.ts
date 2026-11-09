import { splitReferenceMessage } from './composer-resources-model';
import { displayDecimal, displayLocale } from './display-dates';
import type { EngineState } from './engine-state';

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

const isValidTime = (at: number | undefined): at is number =>
  typeof at === 'number' && Number.isFinite(at) && at > 0 && !Number.isNaN(new Date(at).getTime());

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
  if (!isValidTime(message.at)) return undefined;
  const currentNow = isValidTime(now) ? now : Date.now();
  if (isValidTime(previous?.at) && dayKey(previous.at) === dayKey(message.at)) return undefined;
  if (dayKey(message.at) === dayKey(currentNow)) return 'Today';
  // Calendar subtraction, not `now - 86_400_000`: a DST day is 23 or 25 hours.
  const yesterday = new Date(currentNow);
  yesterday.setDate(yesterday.getDate() - 1);
  if (dayKey(message.at) === dayKey(yesterday.getTime())) return 'Yesterday';
  return new Date(message.at).toLocaleDateString(displayLocale(), {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year:
      new Date(message.at).getFullYear() === new Date(currentNow).getFullYear()
        ? undefined
        : 'numeric',
  });
}

const megabytes = (bytes: number) => `${displayDecimal(bytes / (1024 * 1024), 1)} MB`;

/** How far a first read of a long conversation got, as the WebUI's restore progress says it. */
export function replayProgress(replay: { read: number; total: number }): string {
  const safeRead = Number.isFinite(replay.read) && replay.read > 0 ? replay.read : 0;
  const safeTotal = Number.isFinite(replay.total) && replay.total > 0 ? replay.total : 0;
  const percent =
    safeTotal > 0 ? Math.min(100, Math.max(0, Math.floor((safeRead / safeTotal) * 100))) : 0;
  return `${percent}% · ${megabytes(safeRead)} of ${megabytes(safeTotal)}`;
}
