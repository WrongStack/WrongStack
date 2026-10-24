import * as fsp from 'node:fs/promises';
import type { SessionSummary } from '@wrongstack/contracts/types/session';
import { SECRET_FILE_MODE } from '../../security/file-permissions.js';
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

/**
 * True when a range that was read from ONE BYTE BEFORE the intended boundary
 * starts on a newline — i.e. the intended boundary really was a line start.
 *
 * The incremental path reads `[cached.size, stat.size)`. A cached size that
 * lands mid-row therefore makes the range begin with the TAIL of a JSON
 * object: that fragment does not parse, `applySessionIndexLines` drops it, and
 * the cache then advances past the whole row. The row is gone from the index
 * for good, because compaction writes the parsed rows back over the file — so
 * a dropped row is persisted, not merely missed until the next read.
 *
 * A crash-truncated append is how a mid-row cached size arises. The first read
 * stamps the cache with the file's size including the partial row, and the
 * writer's remaining bytes land after that boundary, so the row straddles it.
 *
 * `readFileRange` guards an incomplete line at the END of a range; nothing
 * guarded the START, which is what this probe is for.
 */
function boundaryByteIsNewline(raw: string): boolean {
  return raw.charCodeAt(0) === 0x0a;
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
    // The range starts ONE BYTE EARLY, at the last byte already accounted for,
    // so that byte doubles as the alignment probe. Checking alignment with a
    // separate `open` + pread first was measured at +39.4% on this path
    // (~512 us per incremental read, .temp_files/bench_F4_alignment_guard_cost.ts),
    // and an incremental read happens on every session append. Folding the probe
    // into the range reads one extra byte instead, and the difference from the
    // unguarded path falls to +1.4% — inside the harness's own 19-23% run spread.
    //
    // When that byte is a newline the boundary is a line start and the extra
    // byte is a harmless empty leading line, which `applySessionIndexLines`
    // skips. When it is not, `cached.size` landed mid-row: fall through to the
    // full read below, BEFORE anything is applied, so the cache never advances
    // past a row it only half-read.
    const probe = cached.size > 0 ? cached.size - 1 : 0;
    const appended = await readFileRange(indexFile, probe, stat.size);
    if (appended !== null && boundaryByteIsNewline(appended.raw)) {
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
