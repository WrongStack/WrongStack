import * as fsp from 'node:fs/promises';
import type {
  SessionArchiveIdleResult,
  SessionMoveResult,
  SessionMoveTarget,
  SessionStoragePolicy,
  SessionSummary,
} from '@wrongstack/contracts/types/session';
import { sessionContentText } from './session-helpers.js';
import { executeMoveSession } from './session-store/move-session.js';
import { pruneSessionFiles } from './session-store/prune-helpers.js';
import { executeRenameSession } from './session-store/rename-session.js';
import { executeArchiveIdle } from './session-store/session-archive.js';
import { executeClearSessionHistory } from './session-store/session-store-clear.js';
import { locateTranscript } from './session-store/transcript-location.js';
import { archivePolicyKey, assertRetentionDays } from './session-store-retention-support.js';

export interface SessionStoreRetentionHost {
  asArchiveHost: () => import('./session-store/session-archive.js').SessionArchiveHost;
  projectRoot: string | undefined;
  deleteSession: (id: string) => Promise<void>;
  resolveId: (query: string) => Promise<string>;
  _indexCache: import('./session-store/types.js').IndexCacheEntry | null;
  catalogClient: import('../session-catalog/client.js').SessionCatalogProjectClient | undefined;
  secretScrubber: import('@wrongstack/contracts/types/secret-scrubber').SecretScrubber;
  clearLoadCache: (sessionId?: string | undefined) => void;
  sessionPath: (id: string, ext: '.jsonl' | '.jsonl.gz' | '.summary.json') => string;
  dir: string;
  events: import('./event-bus-port.js').EventBus | undefined;
  readSummaryManifest: (
    id: string,
    startTime?: number,
  ) => Promise<import('@wrongstack/contracts/types/session').SessionSummary | null>;
  summaryFor: (id: string) => Promise<import('@wrongstack/contracts/types/session').SessionSummary>;
  appendToIndexStrict: (
    summary: import('@wrongstack/contracts/types/session').SessionSummary,
  ) => Promise<void>;
  isSessionInUse: ((sessionId: string) => Promise<string | null>) | undefined;
  maintenanceHolderId: `${string}-${string}-${string}-${string}-${string}`;
  compactIndex: () => Promise<void>;
  ensureShardDir: (id: string) => Promise<string>;
  storagePolicy: import('@wrongstack/contracts/types/session-storage').SessionStoragePolicy;
  archiveIdleInFlight: {
    key: string;
    promise: Promise<
      import('@wrongstack/contracts/types/session-storage').SessionArchiveIdleResult
    >;
  } | null;
  archiveIdle: (
    policy?:
      | Partial<import('@wrongstack/contracts/types/session-storage').SessionStoragePolicy>
      | undefined,
  ) => Promise<import('@wrongstack/contracts/types/session-storage').SessionArchiveIdleResult>;
}

export async function move(
  this: SessionStoreRetentionHost,
  id: string,
  target: SessionMoveTarget,
): Promise<SessionMoveResult> {
  const host = { ...this.asArchiveHost(), projectRoot: this.projectRoot };
  const deleteLocal = (sid: string) => this.deleteSession(sid);
  const result = await executeMoveSession(
    { ...host, deleteLocal },
    await this.resolveId(id),
    target,
  );
  this._indexCache = null;
  return result;
}

export async function rename(
  this: SessionStoreRetentionHost,
  id: string,
  name: string,
): Promise<SessionSummary> {
  const canonical = await this.resolveId(id);
  if (this.catalogClient) {
    const summary = await this.catalogClient.call('rename', {
      sessionId: canonical,
      name: sessionContentText(this.secretScrubber.scrub(name)),
    });
    this.clearLoadCache(canonical);
    if (id !== canonical) this.clearLoadCache(id);
    return summary;
  }
  const manifest = this.sessionPath(canonical, '.summary.json');
  const located = await locateTranscript(this.dir, canonical);
  const jsonlPath = located?.filePath ?? this.sessionPath(canonical, '.jsonl');
  const updated = await executeRenameSession({
    id: canonical,
    name,
    manifest,
    jsonlPath,
    events: this.events,
    secretScrubber: this.secretScrubber,
    readSummaryManifest: (sid) => this.readSummaryManifest(sid),
    summaryFor: (sid) => this.summaryFor(sid),
    appendToIndexStrict: (sum) => this.appendToIndexStrict(sum),
    isSessionInUse: this.isSessionInUse,
  });
  this.clearLoadCache(canonical);
  if (id !== canonical) this.clearLoadCache(id);
  return updated;
}

export async function prune(this: SessionStoreRetentionHost, maxAgeDays = 30): Promise<number> {
  // Same rejection as the catalog prune. A NaN or negative cutoff compares
  // false against every mtime and deletes the young sessions it should keep.
  const ageDays = assertRetentionDays(maxAgeDays);
  if (this.catalogClient) {
    return this.catalogClient.call('prune', {
      maxAgeDays: ageDays,
      holderId: this.maintenanceHolderId,
    });
  }
  const deleted = await pruneSessionFiles(
    this.dir,
    ageDays,
    (id) => this.deleteSession(id),
    this.isSessionInUse,
  );
  if (deleted > 0) {
    await this.compactIndex().catch(() => undefined);
  }
  return deleted;
}

export async function clearHistory(this: SessionStoreRetentionHost, id: string): Promise<void> {
  // Leaf and prefix references resolve with or without the catalog daemon.
  // Skipping that step wrote a new transcript under the query and left the
  // real session's history in place.
  const canonical = await this.resolveId(id);
  await executeClearSessionHistory({
    id,
    canonical,
    catalogClient: this.catalogClient,
    maintenanceHolderId: this.maintenanceHolderId,
    ensureShardDir: (sid) => this.ensureShardDir(sid),
    sessionPath: (sid, ext) => this.sessionPath(sid, ext),
  });
  if (!this.catalogClient) {
    await this.appendToIndexStrict(await this.summaryFor(canonical));
  }
  this.clearLoadCache(canonical);
  // loadInternal() caches under the id it was called with, so a session
  // previously loaded via an alias would keep a raw-keyed entry after a
  // canonical-only clear. Delete both keys; Map.delete no-ops on a miss.
  if (id !== canonical) this.clearLoadCache(id);
  await fsp.unlink(this.sessionPath(canonical, '.jsonl.gz')).catch(() => undefined);
}

export async function archiveIdle(
  this: SessionStoreRetentionHost,
  policy?: Partial<SessionStoragePolicy>,
): Promise<SessionArchiveIdleResult> {
  const requested: SessionStoragePolicy = { ...this.storagePolicy, ...policy };
  const key = archivePolicyKey(requested);
  const current = this.archiveIdleInFlight;
  if (current?.key === key) return current.promise;
  // A backfill (or any other policy) that arrives while a narrower pass is
  // running must not adopt that pass's result. Wait it out, then run.
  if (current) {
    await current.promise.catch(() => undefined);
    return this.archiveIdle(policy);
  }
  // Companion journals are chosen from the host policy. Without this
  // override, includeSubagents on the call is ignored and the store
  // default gzips them anyway.
  const promise = executeArchiveIdle(
    { ...this.asArchiveHost(), storagePolicy: requested },
    requested,
  ).finally(() => {
    if (this.archiveIdleInFlight?.promise === promise) this.archiveIdleInFlight = null;
  });
  this.archiveIdleInFlight = { key, promise };
  return promise;
}
