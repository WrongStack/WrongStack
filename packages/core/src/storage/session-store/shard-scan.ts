import type { Dirent } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { SessionSummary } from '../../types/session.js';
import { withFileLock } from '../../utils/atomic-write.js';
import { compareSessionSummaries } from '../session-summary.js';
import { mapWithConcurrency } from '../storage-concurrency.js';
import { shouldSkipSessionDirectoryEntry } from './directory-scan.js';
import { collectSessionFiles as collectSessionFilesFromDirectory } from './directory-session-files.js';
import { readOrBuildShardManifestEntry } from './shard-manifest.js';
import type { DirectorySummaryCandidate, SessionFileRef, ShardManifestEntry } from './types.js';

export const LIST_SCAN_CONCURRENCY = 32;

export interface CachedShardManifest {
  entry: ShardManifestEntry;
  mtimeMs: number;
  size: number;
  ino: number;
}

export interface ShardScanHost {
  dir: string;
  shardManifestCache: Map<string, CachedShardManifest>;
  shardManifestPath: (shardKey: string) => string;
  readSummaryManifest: (id: string) => Promise<SessionSummary | null>;
  summaryHeaderFor: (ref: SessionFileRef) => Promise<SessionSummary | null>;
  summaryFor: (id: string) => Promise<SessionSummary>;
}

export async function collectShardKeys(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [''];
  }

  const shardKeys = [''];
  for (const entry of entries) {
    if (shouldSkipSessionDirectoryEntry(entry.name)) continue;
    if (entry.isDirectory()) shardKeys.push(entry.name);
  }
  return shardKeys;
}

export async function collectSessionFilesInShard(
  dir: string,
  shardKey: string,
): Promise<SessionFileRef[]> {
  const targetDir = shardKey ? path.join(dir, shardKey) : dir;
  const entries = await collectSessionFilesFromDirectory(targetDir, shardKey);
  return shardKey
    ? entries.filter((entry) => entry.id.startsWith(`${shardKey}/`))
    : entries.filter((entry) => !entry.id.includes('/'));
}

export async function freshShardManifestCacheEntry(
  cache: Map<string, CachedShardManifest>,
  shardKey: string,
  manifestPath: string,
): Promise<ShardManifestEntry | undefined> {
  const cached = cache.get(shardKey);
  if (!cached) return undefined;
  try {
    const stat = await fsp.stat(manifestPath);
    if (stat.mtimeMs === cached.mtimeMs && stat.size === cached.size && stat.ino === cached.ino) {
      return cached.entry;
    }
  } catch {
    // Invalidate
  }
  cache.delete(shardKey);
  return undefined;
}

export async function readOrBuildShardManifest(
  host: ShardScanHost,
  shardKey: string,
): Promise<ShardManifestEntry> {
  const manifestPath = host.shardManifestPath(shardKey);
  const cached = await freshShardManifestCacheEntry(
    host.shardManifestCache,
    shardKey,
    manifestPath,
  );
  if (cached) return cached;

  return withFileLock(manifestPath, async () => {
    const lockedCached = await freshShardManifestCacheEntry(
      host.shardManifestCache,
      shardKey,
      manifestPath,
    );
    if (lockedCached) return lockedCached;
    const entry = await readOrBuildShardManifestEntry({
      shardKey,
      manifestPath,
      concurrency: LIST_SCAN_CONCURRENCY,
      collectSessionFilesInShard: (key) => collectSessionFilesInShard(host.dir, key),
      readSummaryManifest: (id) => host.readSummaryManifest(id),
      summaryHeaderFor: (ref) => host.summaryHeaderFor(ref),
      summaryFor: (id) => host.summaryFor(id),
    });
    try {
      const stat = await fsp.stat(manifestPath);
      host.shardManifestCache.set(shardKey, {
        entry,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        ino: stat.ino,
      });
    } catch {
      host.shardManifestCache.delete(shardKey);
    }
    return entry;
  });
}

export async function listFromDirectoryScan(
  host: ShardScanHost,
  limit: number,
): Promise<SessionSummary[]> {
  const shardKeys = await collectShardKeys(host.dir);
  const shardEntries = await mapWithConcurrency(
    shardKeys,
    LIST_SCAN_CONCURRENCY,
    async (shardKey) => await readOrBuildShardManifest(host, shardKey),
  );

  const out: DirectorySummaryCandidate[] = [];
  for (const entry of shardEntries) {
    for (const summary of entry.summaries) {
      out.push({ summary, needsBackfill: false });
    }
  }
  out.sort((a, b) => compareSessionSummaries(a.summary, b.summary));

  const selected = out.slice(0, limit);
  const summaries = await mapWithConcurrency(
    selected,
    Math.min(LIST_SCAN_CONCURRENCY, Math.max(1, limit)),
    async (candidate): Promise<SessionSummary | null> => candidate.summary,
  );
  return summaries.filter((s): s is SessionSummary => s !== null);
}
