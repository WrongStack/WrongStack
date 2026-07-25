import type { MemoryEntry } from '@wrongstack/core/types';

/**
 * Escape GLOB metacharacters (`*`, `?`, `[`, `]`) so a path fragment is treated
 * literally inside a GLOB pattern.
 */
export function escapeGlobPattern(value: string): string {
  return value.replace(/[*?[\]]/g, (ch) => `[${ch}]`);
}

/** Escape `%`, `_`, and `\` so a user query is treated literally inside LIKE. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export interface PageCursor {
  updatedAt: string;
  id: string;
}

export function formatLegacyEntry(entry: MemoryEntry): string {
  const tags = entry.tags?.length ? ` ${entry.tags.map((tag) => `#${tag}`).join(' ')}` : '';
  const type = entry.type ? ` [${entry.type}${entry.priority ? `|${entry.priority}` : ''}]` : '';
  return `- [${entry.ts}]${type} ${entry.text}${tags}`;
}

/** Decode an opaque cursor token; returns undefined for missing/malformed input. */
export function decodePageCursor(cursor: string | undefined): PageCursor | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      u?: unknown;
      i?: unknown;
    };
    if (typeof parsed.u === 'string' && typeof parsed.i === 'string') {
      return { updatedAt: parsed.u, id: parsed.i };
    }
  } catch {
    // Malformed cursor -> treat as first page.
  }
  return undefined;
}
