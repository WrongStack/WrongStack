import type { AttachmentStore } from '@wrongstack/core/types';
import { INLINE_TOKEN_SRC } from './input-tokens.js';

/** Maximum number of retained attachment previews. */
export const TOKEN_PREVIEWS_MAX_ENTRIES = 64;
/** Maximum characters retained for one attachment preview. */
export const TOKEN_PREVIEW_MAX_CHARS = 8 * 1024;
/** Maximum content lines retained before the truncation marker. */
export const TOKEN_PREVIEW_MAX_LINES = 6;
/** Maximum characters retained across all attachment previews. */
export const TOKEN_PREVIEWS_MAX_CHARS = 256 * 1024;
/** Maximum UTF-8 bytes inlined for a text-file mention. Larger files remain
 * attachable as path references with an explicit read-until-EOF contract. */
export const TEXT_FILE_ATTACHMENT_INLINE_MAX_BYTES = 1024 * 1024;

const TRUNCATION_MARKER = '… [preview truncated]';
const ATTACHMENT_WRAPPER_RE =
  /^<(?:pasted|file(?: path="[^"]*")?)>\n([\s\S]*)\n<\/(?:pasted|file)>$/;

interface TokenPreviewBudget {
  maxEntries?: number | undefined;
  maxChars?: number | undefined;
  maxPreviewChars?: number | undefined;
  maxPreviewLines?: number | undefined;
}

/** Build an independent, hard-capped display preview from canonical content. */
export function createTokenPreview(
  value: string,
  maxChars = TOKEN_PREVIEW_MAX_CHARS,
  maxLines = TOKEN_PREVIEW_MAX_LINES,
): string {
  const charLimit = Math.max(1, Math.floor(maxChars));
  const lineLimit = Math.max(1, Math.floor(maxLines));
  let end = value.length;
  let lines = 1;
  let lineTruncated = false;

  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code !== 10 && code !== 13) continue;
    if (lines === lineLimit) {
      end = i;
      lineTruncated = true;
      break;
    }
    lines++;
    if (code === 13 && value.charCodeAt(i + 1) === 10) i++;
  }

  const visible = value.slice(0, end);
  const truncated = lineTruncated || visible.length > charLimit;
  if (!truncated) {
    // Rebuild the bounded string so a short preview cannot retain a large
    // attachment's backing store through a V8 sliced-string representation.
    return Array.from(visible).join('');
  }

  const suffix = `\n${TRUNCATION_MARKER}`;
  if (suffix.length >= charLimit) return suffix.slice(0, charLimit);
  const head = visible.slice(0, charLimit - suffix.length);
  return Array.from(`${head}${suffix}`).join('');
}

/**
 * LRU map of attachment token → bounded display preview. Canonical full
 * content remains exclusively in AttachmentStore and is resolved on demand.
 */
export class TokenPreviewStore {
  private readonly map = new Map<string, string>();
  private totalChars = 0;
  private readonly maxEntries: number;
  private readonly maxChars: number;
  private readonly maxPreviewChars: number;
  private readonly maxPreviewLines: number;

  constructor(budget: TokenPreviewBudget = {}) {
    this.maxEntries = Math.max(1, Math.floor(budget.maxEntries ?? TOKEN_PREVIEWS_MAX_ENTRIES));
    this.maxChars = Math.max(1, Math.floor(budget.maxChars ?? TOKEN_PREVIEWS_MAX_CHARS));
    this.maxPreviewChars = Math.max(
      1,
      Math.min(this.maxChars, Math.floor(budget.maxPreviewChars ?? TOKEN_PREVIEW_MAX_CHARS)),
    );
    this.maxPreviewLines = Math.max(
      1,
      Math.floor(budget.maxPreviewLines ?? TOKEN_PREVIEW_MAX_LINES),
    );
  }

  get size(): number {
    return this.map.size;
  }

  get chars(): number {
    return this.totalChars;
  }

  get(token: string): string | undefined {
    const value = this.map.get(token);
    if (value === undefined) return undefined;
    this.map.delete(token);
    this.map.set(token, value);
    return value;
  }

  has(token: string): boolean {
    return this.map.has(token);
  }

  set(token: string, value: string): void {
    const preview = createTokenPreview(value, this.maxPreviewChars, this.maxPreviewLines);
    const prev = this.map.get(token);
    if (prev !== undefined) {
      this.totalChars -= prev.length;
      this.map.delete(token);
    }
    this.map.set(token, preview);
    this.totalChars += preview.length;
    this.evict();
  }

  delete(token: string): boolean {
    const prev = this.map.get(token);
    if (prev === undefined) return false;
    this.totalChars -= prev.length;
    return this.map.delete(token);
  }

  clear(): void {
    this.map.clear();
    this.totalChars = 0;
  }

  keysOldestFirst(): string[] {
    return [...this.map.keys()];
  }

  private evict(): void {
    while (this.map.size > this.maxEntries || this.totalChars > this.maxChars) {
      const oldest = this.map.entries().next().value;
      if (oldest === undefined) break;
      const [key, value] = oldest;
      this.map.delete(key);
      this.totalChars -= value.length;
    }
  }
}

/** Resolve text/file tokens from the canonical store without caching payloads. */
export async function resolveAttachmentTokens(
  text: string,
  attachments: AttachmentStore,
): Promise<string> {
  const matches = [...text.matchAll(new RegExp(INLINE_TOKEN_SRC, 'g'))];
  if (matches.length === 0) return text;

  const replacements = await Promise.all(
    matches.map(async (match): Promise<string> => {
      const token = match[0];
      const blocks = await attachments.expand(token);
      if (blocks.some((block) => block.type !== 'text')) return token;
      const expanded = blocks.map((block) => (block.type === 'text' ? block.text : '')).join('');
      return expanded.match(ATTACHMENT_WRAPPER_RE)?.[1] ?? expanded;
    }),
  );

  let result = '';
  let lastIndex = 0;
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const replacement = replacements[i];
    if (match === undefined || replacement === undefined) continue;
    const index = match.index ?? lastIndex;
    result += text.slice(lastIndex, index) + replacement;
    lastIndex = index + match[0].length;
  }
  return result + text.slice(lastIndex);
}
