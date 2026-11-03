import { splitReferenceMessage } from './composer-resources-model';
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
