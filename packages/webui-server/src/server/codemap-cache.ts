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

export interface CodemapCacheEntry {
  version: string;
  /** Pre-serialized JSON body — avoids re-stringify on cache hits. */
  body: string;
}

const cache = new Map<string, CodemapCacheEntry>();

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
    cache.delete(key);
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
  if (cache.has(key)) cache.delete(key);
  cache.set(key, { version, body });
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Test / process-shutdown helper. */
export function clearCodemapGraphCache(): void {
  cache.clear();
}

export function codemapGraphCacheSize(): number {
  return cache.size;
}
