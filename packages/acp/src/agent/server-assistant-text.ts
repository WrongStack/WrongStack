import { stripNextStepsBlock } from '@wrongstack/core/utils/next-steps';

const TAG = /<next_?steps\b/i;
const TAG_PREFIXES = ['<nextsteps', '<next_steps'];

export function acpAssistantText(text: string): string {
  return TAG.test(text) ? stripNextStepsBlock(text, { preserveWhitespace: true }) : text;
}

/**
 * Deltas can split a tag at any character. Hold only the partial opening
 * prefix during ordinary streaming. Once a tag starts, project the remainder
 * at the response boundary using the shared fenced-code-aware parser.
 */
export function makeAcpAssistantStream(emit: (text: string) => void) {
  let raw = '';
  let sent = 0;
  let deferred = false;
  return {
    push(text: string): void {
      raw += text;
      if (deferred) return;
      const pending = raw.slice(sent);
      const tagIndex = pending.search(TAG);
      deferred = tagIndex >= 0;
      const lastOpen = pending.lastIndexOf('<');
      const partial =
        lastOpen >= 0 &&
        TAG_PREFIXES.some((prefix) => prefix.startsWith(pending.slice(lastOpen).toLowerCase()));
      const ready = pending.slice(0, deferred ? tagIndex : partial ? lastOpen : pending.length);
      sent += ready.length;
      if (ready) emit(ready);
    },
    flush(): void {
      const remainder = acpAssistantText(raw).slice(sent);
      raw = '';
      sent = 0;
      deferred = false;
      if (remainder) emit(remainder);
    },
  };
}
