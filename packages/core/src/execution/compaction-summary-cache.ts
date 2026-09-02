import { createHash } from 'node:crypto';
import type { ContentBlock } from '../types/blocks.js';
import type { Message } from '../types/messages.js';
import { LruCache } from '../utils/lru-cache.js';

interface CacheEntry {
  value: string;
  expiresAt: number;
}

export interface CompactionSummaryCacheOptions {
  /** Maximum distinct summaries retained in memory (default: 32). Must be a positive integer. */
  capacity?: number | undefined;
  /** Time a successful summary remains reusable (default: 1 hour). Must be finite and > 0. */
  ttlMs?: number | undefined;
}

/** Non-semantic summarizer results that must never become durable cache hits. */
export const PLACEHOLDER_SUMMARIES = Object.freeze({
  empty: '(empty)',
  emptySummary: '(empty summary)',
});

const placeholderSummaryValues: ReadonlySet<string> = new Set(Object.values(PLACEHOLDER_SUMMARIES));

export function isPlaceholderSummary(value: string): boolean {
  const summary = value.trim();
  return summary.length === 0 || placeholderSummaryValues.has(summary);
}

/**
 * Small, process-local cache for isolated compaction summaries.
 *
 * Auto-compaction and overflow recovery can race or retry against the same
 * pre-compaction history. Without a shared cache each path pays for the same
 * secondary-model request. The cache is deliberately bounded and TTL-based:
 * long-running agents cannot accumulate one entry per compaction forever.
 */
export class CompactionSummaryCache {
  private readonly entries: LruCache<string, CacheEntry>;
  private readonly pending = new Map<string, Promise<string>>();
  private readonly ttlMs: number;
  private generation = 0;

  constructor(opts: CompactionSummaryCacheOptions = {}) {
    const capacity = opts.capacity ?? 32;
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new Error(
        `CompactionSummaryCache capacity must be a positive integer, got ${capacity}`,
      );
    }
    this.entries = new LruCache(capacity);
    if (opts.ttlMs !== undefined && (!Number.isFinite(opts.ttlMs) || opts.ttlMs <= 0)) {
      throw new Error(`CompactionSummaryCache ttlMs must be finite and > 0, got ${opts.ttlMs}`);
    }
    this.ttlMs = opts.ttlMs ?? 60 * 60 * 1000;
  }

  get(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) return undefined;
    return entry.value;
  }

  set(key: string, value: string): void {
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /** Clear entries and invalidate pending creators so their results cannot repopulate the cache. */
  clear(): void {
    this.generation++;
    this.entries.clear();
    this.pending.clear();
  }

  /** Reuse both completed results and an identical call already in flight. */
  async getOrCreate(key: string, create: () => Promise<string>): Promise<string> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const running = this.pending.get(key);
    if (running) return running;

    const generation = this.generation;
    let tracked: Promise<string>;
    tracked = create().then(
      (value) => {
        // The originating call keeps provider formatting; durable cache hits use the trimmed form.
        const summary = value.trim();
        if (generation === this.generation && !isPlaceholderSummary(summary)) {
          this.set(key, summary);
        }
        if (this.pending.get(key) === tracked) this.pending.delete(key);
        return value;
      },
      (error: unknown) => {
        // Clear before rethrowing so rejection observers can retry immediately.
        if (this.pending.get(key) === tracked) this.pending.delete(key);
        throw error;
      },
    );
    this.pending.set(key, tracked);
    return tracked;
  }
}

/** Process-wide default with a 32-entry capacity and 1-hour TTL. */
export const defaultCompactionSummaryCache = new CompactionSummaryCache();

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = canonicalize(source[key]);
    return sorted;
  }
  return value;
}

function semanticBlock(block: ContentBlock): unknown {
  switch (block.type) {
    case 'text':
      return { type: block.type, text: block.text, cache_control: block.cache_control };
    case 'tool_use':
      return { type: block.type, id: block.id, name: block.name, input: block.input };
    case 'tool_result':
      return {
        type: block.type,
        tool_use_id: block.tool_use_id,
        name: block.name,
        content: block.content,
        is_error: block.is_error,
      };
    case 'image':
      return { type: block.type, source: block.source };
    case 'thinking':
      return { type: block.type, thinking: block.thinking };
  }
}

/** Stable key for a summary request; transient estimator and provider metadata are excluded. */
export function compactionSummaryKey(
  model: string,
  prompt: string,
  messages: readonly Message[],
): string {
  const hash = createHash('sha256');
  hash.update('wrongstack-compaction-summary-v2\0').update(model).update('\0').update(prompt);
  for (const message of messages) {
    hash.update('\0').update(message.role).update('\0');
    if (typeof message.content === 'string') {
      hash.update(message.content);
      continue;
    }
    hash.update(JSON.stringify(canonicalize(message.content.map(semanticBlock))));
  }
  return hash.digest('hex');
}
