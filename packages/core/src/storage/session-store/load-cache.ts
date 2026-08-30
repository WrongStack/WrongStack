import type { SessionData } from '../../types/session.js';
import type { LoadCacheEntry } from './types.js';

const LOAD_CACHE_MAX_ENTRIES = 50;
const LOAD_CACHE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Depth at which the size walk stops descending.
 *
 * Journal payloads are shallow — an event holds messages, a message holds
 * content blocks, a block holds a source object — so this is far past anything
 * real. It exists so a cyclic or pathological value cannot turn a cache insert
 * into an unbounded walk.
 */
const SIZE_WALK_MAX_DEPTH = 12;

interface FileStatSnapshot {
  mtimeMs: number;
  size: number;
}

/**
 * Roughly how much heap one cached entry holds.
 *
 * The budget used to be charged `stat.size` — the size of the JOURNAL FILE —
 * which is not what the cache stores. A session's journal is dominated by
 * superseded context snapshots and by events the loader evicts under its own
 * retention budget; what survives into `SessionData` is a small fraction of
 * it. On a real 126 MB journal the retained data was a few megabytes, and the
 * cache charged itself all 126 — over the whole-cache cap, so `set()` refused
 * the entry outright and every subsequent load re-parsed the file from byte
 * zero. The accounting inverted the cache's purpose: the entries it dropped
 * first were exactly the ones most expensive to rebuild, and a resume or a tab
 * redisplay of a long session paid seconds of parsing every single time.
 *
 * A structural walk rather than `JSON.stringify(data).length`: the answer is
 * the same order of magnitude, and stringifying a multi-megabyte transcript on
 * every load allocates a multi-megabyte string to immediately throw away.
 * String lengths are counted in UTF-16 units because that is what the engine
 * actually keeps resident — deliberately a heap estimate, not a wire size.
 */
function approximateRetainedBytes(value: unknown, depth = 0): number {
  if (value === null || value === undefined) return 0;
  const type = typeof value;
  if (type === 'string') return (value as string).length * 2;
  if (type === 'number' || type === 'boolean') return 8;
  if (type !== 'object') return 0;
  if (depth >= SIZE_WALK_MAX_DEPTH) return 0;
  if (Array.isArray(value)) {
    let bytes = 32;
    for (const item of value) bytes += approximateRetainedBytes(item, depth + 1);
    return bytes;
  }
  let bytes = 48;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    bytes += key.length * 2 + approximateRetainedBytes(child, depth + 1);
  }
  return bytes;
}

export class SessionLoadCache {
  constructor(private readonly entries = new Map<string, LoadCacheEntry>()) {}

  private bytes = 0;

  clear(sessionId?: string): void {
    if (sessionId !== undefined) {
      this.delete(sessionId);
      return;
    }
    this.entries.clear();
    this.bytes = 0;
  }

  /**
   * A hit hands back fresh `messages` / `events` arrays over the cached
   * contents.
   *
   * The entry outlives every caller, and callers treat what they get as their
   * own: `resume()` passes `messages` straight into a live conversation, and
   * anything walking `events` may splice it. Returning the cached arrays
   * themselves let one caller's edit rewrite what the next one loads. The
   * elements are still shared — copying them would defeat the cache — so
   * entries remain read-only *contents* behind private containers.
   */
  getFresh(id: string, stat: FileStatSnapshot, full: boolean): SessionData | null {
    const cached = this.entries.get(id);
    if (!cached || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
      return null;
    }
    this.entries.delete(id);
    this.entries.set(id, cached);
    return {
      ...cached.data,
      messages: full ? [...cached.data.messages] : [],
      events: [...cached.data.events],
    };
  }

  set(id: string, stat: FileStatSnapshot, data: SessionData): void {
    this.delete(id);
    // `stat` stays the freshness key — an entry is stale the moment the file
    // it came from changes — but the COST is what the entry holds. See
    // {@link approximateRetainedBytes}.
    const cost = approximateRetainedBytes(data);
    while (
      cost <= LOAD_CACHE_MAX_BYTES &&
      (this.entries.size >= LOAD_CACHE_MAX_ENTRIES || this.bytes + cost > LOAD_CACHE_MAX_BYTES)
    ) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
    if (cost <= LOAD_CACHE_MAX_BYTES) {
      this.entries.set(id, { mtimeMs: stat.mtimeMs, size: stat.size, data, bytes: cost });
      this.bytes += cost;
    }
  }

  private delete(sessionId: string): void {
    const cached = this.entries.get(sessionId);
    // `bytes` is the measured cost; `size` is the source file and is only the
    // freshness key. Refunding `size` here (as this did while the two were the
    // same field) would drift the running total away from what is held.
    if (cached) this.bytes = Math.max(0, this.bytes - (cached.bytes ?? cached.size));
    this.entries.delete(sessionId);
  }
}
