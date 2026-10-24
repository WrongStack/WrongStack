import { isTextBlock } from '@wrongstack/contracts/types/blocks';
import type { Message } from '@wrongstack/contracts/types/messages';

// A hint starts only at a run boundary and segments are bounded to a
// filename's length (255): otherwise every start offset inside a long
// word-character run re-scanned it to the end (O(n^2) on one tool result).
const PATH_HINT_PATTERN =
  /(?<![\w@.-])(?:(?:[A-Za-z]:)?[./\\]?[\w@.-]{1,255}(?:[\\/][\w@(). -]{1,255})+\.[A-Za-z0-9]{1,12})/g;
const PATH_BACKSLASH_PATTERN = /\\/g;
const PATH_TRIM_PATTERN = /^["'`]+|["'`),;:]+$/g;
const ERROR_LINE_PATTERN =
  /\b(error|exception|failed|failure|fatal|panic|timeout|denied|enoent|eacces|eperm)\b/i;
const NEWLINE_SPLIT_PATTERN = /\r?\n/;
const WHITESPACE_COLLAPSE_PATTERN = /\s+/g;

/**
 * Compact, information-dense representation of one message for selector and
 * summarizer calls. Kept in the neutral utils layer so models do not depend
 * on execution at runtime.
 */
export function buildCompactionPreview(message: Message, maxChars = 600): string {
  if (maxChars <= 0) return '';
  if (typeof message.content === 'string') {
    return truncatePreview(message.content, maxChars);
  }

  const parts: string[] = [];
  for (const block of message.content) {
    if (isTextBlock(block)) {
      const text = truncatePreview(block.text, maxChars);
      if (text) parts.push(text);
      continue;
    }
    if (block.type === 'tool_use') {
      const input = truncatePreview(safePreviewString(block.input), 220);
      parts.push(`[tool_use: ${block.name}${input ? `; input=${input}` : ''}]`);
      continue;
    }
    if (block.type === 'tool_result') {
      const raw = safePreviewString(block.content);
      const details: string[] = [block.is_error ? 'error' : 'ok'];
      if (block.name) details.push(`tool=${block.name}`);
      const files = extractPathHints(raw).slice(0, 5);
      if (files.length > 0) details.push(`files=${files.join(', ')}`);
      const error = firstErrorLine(raw);
      if (error) details.push(`error=${error}`);
      const sample = truncatePreview(raw, 260);
      if (sample) details.push(`sample=${sample}`);
      parts.push(`[tool_result: ${details.join('; ')}]`);
      continue;
    }
    parts.push(`[${block.type}]`);
  }
  return truncatePreview(parts.join(' '), maxChars);
}

function safePreviewString(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    // JSON.stringify yields undefined (not a string) for undefined/functions.
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

function truncatePreview(value: string, maxChars: number): string {
  const compact = value.replace(WHITESPACE_COLLAPSE_PATTERN, ' ').trim();
  if (compact.length <= maxChars) return compact;
  // Never cut a surrogate pair: previews are sent to selector/summarizer models.
  let end = Math.max(0, maxChars - 1);
  if (end > 0 && /[\uD800-\uDBFF]/.test(compact[end - 1]!)) end--;
  return `${compact.slice(0, end)}…`;
}

function extractPathHints(content: unknown): string[] {
  const text = safePreviewString(content);
  const out = new Set<string>();
  for (const match of text.matchAll(PATH_HINT_PATTERN)) {
    const clean = match[0]?.replace(PATH_BACKSLASH_PATTERN, '/').replace(PATH_TRIM_PATTERN, '');
    if (clean) out.add(clean);
  }
  return [...out];
}

function firstErrorLine(content: unknown): string | undefined {
  const text = safePreviewString(content);
  for (const line of text.split(NEWLINE_SPLIT_PATTERN)) {
    if (!ERROR_LINE_PATTERN.test(line)) continue;
    const trimmed = line.replace(WHITESPACE_COLLAPSE_PATTERN, ' ').trim();
    if (trimmed) return truncatePreview(trimmed, 220);
  }
  return undefined;
}
