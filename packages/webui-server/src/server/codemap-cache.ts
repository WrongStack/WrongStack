/**
 * In-process CodeMap graph cache.
 *
 * Graph queries hit SQLite and can be expensive on monorepos. Package/file/symbol
 * drill-downs are pure functions of the index DB contents, so we cache the
 * pre-serialized JSON body keyed by scope and invalidate when `index.db`
 * mtime/size changes (indexer writes bump mtime).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveIndexDir } from '@wrongstack/tools/codebase-index/index';

const DB_FILE = 'index.db';
/** Soft cap — symbol-level scopes can proliferate during live agent sessions. */
const MAX_CACHE_ENTRIES = 128;
/** One pathological graph must not occupy the whole server heap. */
const MAX_CACHE_BODY_CHARS = 4 * 1024 * 1024;
/** JS strings may use two bytes per code unit, so this is roughly a 32 MiB heap budget. */
const MAX_CACHE_TOTAL_CHARS = 16 * 1024 * 1024;

interface CodemapCacheEntry {
  version: string;
  /** Pre-serialized JSON body — avoids re-stringify on cache hits. */
  body: string;
}

const cache = new Map<string, CodemapCacheEntry>();
let cacheChars = 0;

function deleteCachedCodemapBody(key: string): boolean {
  const entry = cache.get(key);
  if (!entry) return false;
  cacheChars = Math.max(0, cacheChars - entry.body.length);
  return cache.delete(key);
}

/**
 * Filesystem fingerprint of the index DB used as the cache generation key.
 *
 * The index uses WAL mode (`PRAGMA journal_mode = WAL`), so indexer writes land
 * in `index.db-wal` and only move into `index.db` on a checkpoint. Fingerprinting
 * `index.db` alone returns the same mtime/size across an entire indexing run,
 * which makes a stale empty-graph response cached before the first successful
 * index look like a permanent cache hit — the CodeMap canvas shows
 * "No indexed nodes at this level" indefinitely.
 *
 * Including the WAL file's mtime/size (and falling back gracefully when no WAL
 * exists yet) ensures the fingerprint changes as soon as the indexer writes.
 */
export async function indexDbVersion(projectRoot: string, indexDir?: string): Promise<string> {
  try {
    const dir = resolveIndexDir(projectRoot, indexDir);
    const st = await fs.promises.stat(path.join(dir, DB_FILE));
    // Fold the WAL fingerprint in so WAL-mode writes invalidate the cache even
    // when the main DB file hasn't been checkpointed. A missing WAL (pre-write
    // or post-checkpoint) is harmless — the main DB stat already covers those.
    let wal = '';
    try {
      const walSt = await fs.promises.stat(path.join(dir, `${DB_FILE}-wal`));
      wal = `:${walSt.mtimeMs}:${walSt.size}`;
    } catch {
      /* WAL not present — main DB fingerprint is sufficient */
    }
    return `${st.mtimeMs}:${st.size}${wal}`;
  } catch {
    return 'missing';
  }
}

export function codemapCacheKey(
  projectRoot: string,
  indexDir: string | undefined,
  scope: string,
): string {
  return `${projectRoot}\0${indexDir ?? ''}\0${scope}`;
}

export function getCachedCodemapBody(key: string, version: string): string | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.version !== version) {
    deleteCachedCodemapBody(key);
    return undefined;
  }
  // Refresh LRU order (Map insertion order).
  cache.delete(key);
  cache.set(key, entry);
  return entry.body;
}

export function setCachedCodemapBody(key: string, version: string, body: string): void {
  if (cache.has(key)) deleteCachedCodemapBody(key);
  if (body.length > MAX_CACHE_BODY_CHARS) return;
  cache.set(key, { version, body });
  cacheChars += body.length;
  while (cache.size > MAX_CACHE_ENTRIES || cacheChars > MAX_CACHE_TOTAL_CHARS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    deleteCachedCodemapBody(oldest);
  }
}

/** Test / process-shutdown helper. */
export function clearCodemapGraphCache(): void {
  cache.clear();
  cacheChars = 0;
}

export function codemapGraphCacheSize(): number {
  return cache.size;
}

export function codemapGraphCacheChars(): number {
  return cacheChars;
}
