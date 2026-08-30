import * as fsp from 'node:fs/promises';
import { SECRET_FILE_MODE } from '../../security/file-permissions.js';
import type { SessionSummary } from '../../types/session.js';
import { atomicWrite, ensureDir, withFileLock } from '../../utils/atomic-write.js';
import { compareSessionSummaries } from '../session-summary.js';
import { applySessionIndexLines, readFileRange } from './index-reader.js';
import type { IndexCacheEntry } from './types.js';

export const COMPACT_EVERY = 30;

/** Shared empty set for files that cannot contain tombstones (missing/unreadable). */
const NO_DELETED_IDS: ReadonlySet<string> = new Set<string>();

export async function appendToIndexStrict(
  dir: string,
  indexFile: string,
  summary: SessionSummary,
  invalidateShard: (id: string) => Promise<void>,
  onAppended: () => { shouldCompact: boolean },
  compactInner: () => Promise<void>,
): Promise<void> {
  await ensureDir(dir);
  let shouldCompact = false;
  await withFileLock(indexFile, async () => {
    await invalidateShard(summary.id);
    const line = JSON.stringify(summary) + '\n';
    await fsp.appendFile(indexFile, line, { encoding: 'utf8', mode: SECRET_FILE_MODE });
    const res = onAppended();
    shouldCompact = res.shouldCompact;
  });
  if (shouldCompact) {
    await withFileLock(indexFile, () => compactInner());
  }
}

export async function writeTombstone(
  dir: string,
  indexFile: string,
  id: string,
  invalidateShard: (id: string) => Promise<void>,
  onTombstone: () => void,
): Promise<void> {
  try {
    await ensureDir(dir);
    await withFileLock(indexFile, async () => {
      const line = JSON.stringify({ action: 'delete', id }) + '\n';
      await fsp.appendFile(indexFile, line, { encoding: 'utf8', mode: SECRET_FILE_MODE });
      onTombstone();
      await invalidateShard(id);
    });
  } catch {
    // best-effort
  }
}

export async function readIndexFile(
  indexFile: string,
  currentCache: IndexCacheEntry | null,
): Promise<{
  summaries: readonly SessionSummary[];
  deletedIds: ReadonlySet<string>;
  cache: IndexCacheEntry | null;
}> {
  let stat: { mtimeMs: number; size: number; ino: number; birthtimeMs: number };
  try {
    const s = await fsp.stat(indexFile);
    stat = { mtimeMs: s.mtimeMs, size: s.size, ino: s.ino, birthtimeMs: s.birthtimeMs };
  } catch {
    return { summaries: [], deletedIds: NO_DELETED_IDS, cache: null };
  }

  if (
    currentCache !== null &&
    currentCache.mtimeMs === stat.mtimeMs &&
    currentCache.size === stat.size &&
    currentCache.ino === stat.ino &&
    currentCache.birthtimeMs === stat.birthtimeMs
  ) {
    return {
      summaries: currentCache.summaries,
      deletedIds: currentCache.deleted,
      cache: currentCache,
    };
  }

  const cached = currentCache;
  const sameFile =
    cached !== null && cached.ino === stat.ino && cached.birthtimeMs === stat.birthtimeMs;
  if (cached && sameFile && stat.size > cached.size) {
    const appended = await readFileRange(indexFile, cached.size, stat.size);
    if (appended !== null) {
      applySessionIndexLines(appended.raw, cached.byId, cached.deleted);
      const summaries = Array.from(cached.byId.values()).sort(compareSessionSummaries);
      const nextCache: IndexCacheEntry = {
        ...stat,
        size: appended.end,
        summaries,
        byId: cached.byId,
        deleted: cached.deleted,
      };
      return { summaries, deletedIds: cached.deleted, cache: nextCache };
    }
  }

  let raw: string;
  try {
    raw = await fsp.readFile(indexFile, 'utf8');
  } catch {
    return { summaries: [], deletedIds: NO_DELETED_IDS, cache: null };
  }
  const deleted = new Set<string>();
  const byId = new Map<string, SessionSummary>();
  applySessionIndexLines(raw, byId, deleted);
  const summaries = Array.from(byId.values());
  summaries.sort(compareSessionSummaries);
  const nextCache: IndexCacheEntry = { ...stat, summaries, byId, deleted };
  return { summaries, deletedIds: deleted, cache: nextCache };
}

export async function compactIndexInner(
  indexFile: string,
  entries: readonly SessionSummary[],
  deletedIds?: ReadonlySet<string>,
): Promise<void> {
  const parts: string[] = entries.map((s) => JSON.stringify(s));
  if (deletedIds) {
    // Tombstones are load-bearing: mergeIndexWithScan relies on them to keep
    // deleted sessions hidden even when their JSONL outlives best-effort
    // file cleanup. Dropping them here would resurrect those sessions on the
    // next listing pass.
    for (const id of deletedIds) {
      parts.push(JSON.stringify({ action: 'delete', id }));
    }
  }
  if (parts.length === 0) {
    await atomicWrite(indexFile, '', { mode: 0o600 });
    return;
  }
  const lines = parts.join('\n') + '\n';
  await atomicWrite(indexFile, lines, { mode: 0o600 });
}
