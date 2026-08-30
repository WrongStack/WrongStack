import type { ContentBlock } from '../types/blocks.js';

export { captureCheckpoint, materializeCheckpoint } from './session-workspace-checkpoints.js';

function consumeControlString(value: string, start: number): number {
  let index = start;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code === 0x07 || code === 0x9c) return index;
    if (code === 0x1b && value.charCodeAt(index + 1) === 0x5c) return index + 1;
    index++;
  }
  return value.length;
}

function consumeCsi(value: string, start: number): number {
  let index = start;
  while (index < value.length && value.charCodeAt(index) < 0x40) index++;
  return index;
}

function stripTerminalControls(value: string): string {
  let out = '';
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0x1b) {
      const family = value.charCodeAt(index + 1);
      if (family === 0x5b) index = consumeCsi(value, index + 2);
      else if ([0x5d, 0x50, 0x58, 0x5e, 0x5f].includes(family)) {
        index = consumeControlString(value, index + 2);
      } else index++;
      continue;
    }
    if (code === 0x9b) {
      index = consumeCsi(value, index + 1);
      continue;
    }
    if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) {
      index = consumeControlString(value, index + 1);
      continue;
    }
    if (
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      (code >= 0x7f && code <= 0x9f)
    ) {
      continue;
    }
    out += value[index];
  }
  return out;
}

/**
 * Derive a short title from a user_input event's content. Used by both
 * `DefaultSessionStore.summarize()` (offline summary rebuild) and
 * `FileSessionWriter.observeForSummary()` (live tracking), so it lives
 * here to avoid a bidirectional import between those two modules.
 */
export function sessionContentText(content: string | ContentBlock[]): string {
  if (!content) return '';
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .filter(
              (b): b is { type: 'text'; text: string } =>
                Boolean(b && b.type === 'text' && typeof b.text === 'string'),
            )
            .map((b) => b.text)
            .join(' ')
        : String(content);
  return stripTerminalControls(text).trim().replace(/\s+/g, ' ');
}

export function sessionContentPreview(content: string | ContentBlock[], maxLength = 160): string {
  const text = sessionContentText(content) || '(non-text input)';
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

export function userInputTitle(content: string | ContentBlock[]): string {
  return sessionContentPreview(content, 60);
}
