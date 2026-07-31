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

export interface CodemapCacheEntry {
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

/** Filesystem fingerprint of the index DB used as the cache generation key. */
export function indexDbVersion(projectRoot: string, indexDir?: string): string {
  try {
    const dir = resolveIndexDir(projectRoot, indexDir);
    const st = fs.statSync(path.join(dir, DB_FILE));
    return `${st.mtimeMs}:${st.size}`;
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

export function getCachedCodemapBody(
  key: string,
  version: string,
): string | undefined {
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

export function setCachedCodemapBody(
  key: string,
  version: string,
  body: string,
): void {
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
