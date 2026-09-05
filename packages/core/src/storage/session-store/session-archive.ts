import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import type { SessionCatalogProjectClient } from '../../session-catalog/client.js';
import type { MaintenanceLease } from '../../session-catalog/protocol.js';
import type { SecretScrubber } from '../../types/secret-scrubber.js';
import type {
  SessionArchiveIdleResult,
  SessionArchiveResult,
  SessionStoragePolicy,
  SessionSummary,
} from '../../types/session.js';
import { atomicWrite } from '../../utils/atomic-write.js';
import { toErrorMessage } from '../../utils/index.js';
import { isColdSessionTranscriptFileName } from '../../utils/session-scoped-path.js';
import { mapWithConcurrency } from '../storage-concurrency.js';
import { collectSessionFiles as collectSessionFilesFromDirectory } from './directory-session-files.js';
import { readSessionSummaryHeader } from './summary-header.js';
import { archiveSessionTranscript, rehydrateSessionTranscript } from './transcript-archive.js';
import { locateTranscript } from './transcript-location.js';

export function archiveConcurrency(): number {
  const cpus =
    typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(2, Math.min(4, Math.max(1, cpus)));
}

export interface SessionArchiveHost {
  dir: string;
  storagePolicy: SessionStoragePolicy;
  isSessionInUse?: ((sessionId: string) => Promise<string | null>) | undefined;
  catalogClient?: SessionCatalogProjectClient | undefined;
  maintenanceHolderId: string;
  secretScrubber: SecretScrubber;
  clearLoadCache: (sessionId?: string) => void;
  sessionPath: (id: string, ext: '.jsonl' | '.jsonl.gz' | '.summary.json') => string;
  summaryFor: (id: string) => Promise<SessionSummary>;
  readSummaryManifest: (id: string) => Promise<SessionSummary | null>;
  invalidateShardManifestBySessionId: (id: string) => Promise<void>;
  appendToIndex: (summary: SessionSummary) => Promise<void>;
}

export async function executeArchive(
  host: SessionArchiveHost,
  id: string,
): Promise<SessionArchiveResult> {
  return executeArchiveCanonical(host, id);
}

export async function executeRehydrate(
  host: SessionArchiveHost,
  id: string,
): Promise<SessionArchiveResult> {
  return executeEnsureHot(host, id, true);
}

export async function executeArchiveIdle(
  host: SessionArchiveHost,
  policy: SessionStoragePolicy,
): Promise<SessionArchiveIdleResult> {
  const files = await collectSessionFilesFromDirectory(host.dir);
  const hot: Array<{ id: string; mtimeMs: number }> = [];
  for (const ref of files) {
    if (isColdSessionTranscriptFileName(ref.filePath)) continue;
    try {
      const stat = await fsp.stat(ref.filePath);
      if (!stat.isFile() || stat.size <= 0) continue;
      hot.push({ id: ref.id, mtimeMs: stat.mtimeMs });
    } catch {}
  }
  hot.sort((a, b) => b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id));
  const keep = new Set(hot.slice(0, policy.hotKeepSessions).map((row) => row.id));
  const cutoff = Date.now() - policy.archiveAfterDays * 86_400_000;
  const ignoreAge = policy.backfill === true || policy.archiveAfterDays <= 0;
  const candidates = hot.filter((row) => {
    if (keep.has(row.id)) return false;
    if (!ignoreAge && row.mtimeMs >= cutoff) return false;
    return true;
  });
  const fast = true;
  const gzipOpts = { level: 1 as const, verify: false };
  const mapped = await mapWithConcurrency(candidates, archiveConcurrency(), async (row) => {
    try {
      return await ((id, opts) => executeArchiveCanonical(host, id, opts))(row.id, {
        fast,
        gzipOpts,
        skipManifestInvalidate: true,
      });
    } catch (error) {
      return {
        id: row.id,
        action: 'skipped' as const,
        reason: toErrorMessage(error),
      };
    }
  });
  const touched = new Set(candidates.map((row) => row.id));
  for (const id of touched) {
    await host.invalidateShardManifestBySessionId(id).catch(() => undefined);
  }
  let archived = 0;
  let failed = 0;
  for (const result of mapped) {
    if (result.action === 'archived') archived++;
    else if (
      result.action === 'skipped' &&
      result.reason &&
      result.reason !== 'already-cold' &&
      !/in use|live/i.test(result.reason)
    ) {
      failed++;
    }
  }
  return {
    archived,
    skipped: hot.length - archived,
    failed,
    results: mapped,
  };
}

/** Sidecar only — never re-parse a multi-hundred-MB journal just to gzip it. */
export async function ensureArchiveSummarySidecar(
  host: SessionArchiveHost,
  id: string,
): Promise<void> {
  if (await host.readSummaryManifest(id)) return;
  const located = await locateTranscript(host.dir, id);
  if (!located) return;
  const header = await readSessionSummaryHeader(
    { id, filePath: located.filePath },
    host.secretScrubber,
  );
  if (!header) return;
  await atomicWrite(host.sessionPath(id, '.summary.json'), JSON.stringify(header), {
    mode: 0o600,
  }).catch(() => undefined);
}

export async function executeArchiveCanonical(
  host: SessionArchiveHost,
  id: string,
  opts: {
    fast?: boolean | undefined;
    gzipOpts?: { level?: number; verify?: boolean } | undefined;
    skipManifestInvalidate?: boolean | undefined;
  } = {},
): Promise<SessionArchiveResult> {
  if (host.isSessionInUse) {
    const reason = await host.isSessionInUse(id);
    if (reason) return { id, action: 'skipped', reason };
  }
  const located = await locateTranscript(host.dir, id);
  if (!located) throw new Error(`Session not found: ${id}`);
  if (located.state === 'cold') {
    return {
      id,
      action: 'already-cold',
      compressedBytes: located.size,
    };
  }
  let lease: MaintenanceLease | undefined;
  if (host.catalogClient) {
    try {
      lease = await host.catalogClient.call('acquire_maintenance', {
        sessionId: id,
        operation: 'archive',
        holderId: host.maintenanceHolderId,
        holderPid: process.pid,
      });
    } catch (error) {
      return { id, action: 'skipped', reason: toErrorMessage(error) };
    }
  }
  try {
    if (opts.fast) {
      await ensureArchiveSummarySidecar(host, id);
    } else {
      await host.summaryFor(id);
    }
    const result = await archiveSessionTranscript(
      host.dir,
      id,
      host.storagePolicy.includeSubagents,
      opts.gzipOpts,
    );
    const summary = await host.readSummaryManifest(id);
    if (summary) {
      // Sync the per-session manifest with the new tier. The shard-manifest
      // builder trusts this file verbatim (readSummaryManifest has no
      // freshness check) and scanned rows win mergeIndexWithScan, so a stale
      // hot-era manifest here hides the archive state from list() even
      // though _index.jsonl carries it.
      const coldSummary: SessionSummary = {
        ...summary,
        storageState: 'cold',
        codec: 'gzip',
        uncompressedBytes: result.uncompressedBytes,
        compressedBytes: result.compressedBytes,
        archivedAt: new Date().toISOString(),
      };
      await atomicWrite(host.sessionPath(id, '.summary.json'), JSON.stringify(coldSummary), {
        mode: 0o600,
      }).catch(() => undefined);
      if (!opts.skipManifestInvalidate) {
        await host.invalidateShardManifestBySessionId(id).catch(() => undefined);
      }
      if (host.catalogClient) {
        await host.catalogClient.call('upsert_summary', {
          summary,
          transcriptRelativePath: result.relativePath,
          summaryRelativePath: `${id}.summary.json`,
          storageState: 'cold',
          codec: 'gzip',
          uncompressedSize: result.uncompressedBytes,
          compressedSize: result.compressedBytes,
          contentSha256: result.sha256,
          archivedAt: new Date().toISOString(),
        });
      } else {
        await host.appendToIndex(coldSummary);
      }
    }
    host.clearLoadCache(id);
    return {
      id,
      action: 'archived',
      uncompressedBytes: result.uncompressedBytes,
      compressedBytes: result.compressedBytes,
    };
  } finally {
    if (host.catalogClient && lease) {
      await host.catalogClient.call('release_maintenance', { lease }).catch(() => undefined);
    }
  }
}

export async function executeEnsureHot(
  host: SessionArchiveHost,
  id: string,
  leased: boolean,
): Promise<SessionArchiveResult> {
  const located = await locateTranscript(host.dir, id);
  if (!located) throw new Error(`Session not found: ${id}`);
  if (located.state === 'hot') {
    await rehydrateSessionTranscript(host.dir, id, host.storagePolicy.includeSubagents).catch(
      () => undefined,
    );
    return { id, action: 'already-hot', uncompressedBytes: located.size };
  }
  let lease: MaintenanceLease | undefined;
  if (leased && host.catalogClient) {
    lease = await host.catalogClient.call('acquire_maintenance', {
      sessionId: id,
      operation: 'rehydrate',
      holderId: host.maintenanceHolderId,
      holderPid: process.pid,
    });
  }
  try {
    const result = await rehydrateSessionTranscript(
      host.dir,
      id,
      host.storagePolicy.includeSubagents,
    );
    const summary = await host.readSummaryManifest(id);
    if (summary) {
      // Mirror of the archive-side manifest sync: after cold -> hot the
      // manifest must stop claiming the gzip tier — the shard-manifest
      // builder reads this file verbatim and scanned rows win the
      // list() merge, so a stale cold manifest would misreport a live
      // session as archived.
      const hotSummary: SessionSummary = {
        ...summary,
        storageState: 'hot',
        uncompressedBytes: result.uncompressedBytes,
      };
      delete hotSummary.codec;
      delete hotSummary.compressedBytes;
      delete hotSummary.archivedAt;
      await atomicWrite(host.sessionPath(id, '.summary.json'), JSON.stringify(hotSummary), {
        mode: 0o600,
      }).catch(() => undefined);
      await host.invalidateShardManifestBySessionId(id).catch(() => undefined);
      if (host.catalogClient) {
        await host.catalogClient.call('upsert_summary', {
          summary,
          transcriptRelativePath: result.relativePath,
          summaryRelativePath: `${id}.summary.json`,
          storageState: 'hot',
          uncompressedSize: result.uncompressedBytes,
          compressedSize: 0,
          archivedAt: null,
        });
      }
    }
    host.clearLoadCache(id);
    return {
      id,
      action: 'rehydrated',
      uncompressedBytes: result.uncompressedBytes,
      compressedBytes: result.compressedBytes,
    };
  } finally {
    if (host.catalogClient && lease) {
      await host.catalogClient.call('release_maintenance', { lease }).catch(() => undefined);
    }
  }
}
