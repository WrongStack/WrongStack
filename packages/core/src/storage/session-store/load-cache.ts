import type { SessionData } from '../../types/session.js';
import type { LoadCacheEntry } from './types.js';

const LOAD_CACHE_MAX_ENTRIES = 50;
const LOAD_CACHE_MAX_BYTES = 64 * 1024 * 1024;

interface FileStatSnapshot {
  mtimeMs: number;
  size: number;
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
    while (
      stat.size <= LOAD_CACHE_MAX_BYTES &&
      (this.entries.size >= LOAD_CACHE_MAX_ENTRIES || this.bytes + stat.size > LOAD_CACHE_MAX_BYTES)
    ) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
    if (stat.size <= LOAD_CACHE_MAX_BYTES) {
      this.entries.set(id, { mtimeMs: stat.mtimeMs, size: stat.size, data });
      this.bytes += stat.size;
    }
  }

  private delete(sessionId: string): void {
    const cached = this.entries.get(sessionId);
    if (cached) this.bytes = Math.max(0, this.bytes - cached.size);
    this.entries.delete(sessionId);
  }
}
