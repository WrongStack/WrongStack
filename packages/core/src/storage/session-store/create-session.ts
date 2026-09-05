import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { SessionCatalogProjectClient } from '../../session-catalog/client.js';
import type { SecretScrubber } from '../../types/secret-scrubber.js';
import type {
  SessionArchiveIdleResult,
  SessionEvent,
  SessionMetadata,
  SessionStoragePolicy,
  SessionSummary,
  SessionWriter,
} from '../../types/session.js';
import { withFileLock } from '../../utils/atomic-write.js';
import { toErrorMessage } from '../../utils/index.js';
import type { EventBus } from '../event-bus-port.js';
import { FileSessionWriter } from '../file-session-writer.js';
import type { SessionCheckpointCas } from '../session-checkpoint-cas.js';
import { sessionContentText } from '../session-helpers.js';
import { generateSessionId } from '../session-id.js';
import { emitSessionStoreError, emitSessionStoreWrite } from './events.js';

export interface CreateSessionHost {
  dir: string;
  events?: EventBus | undefined;
  secretScrubber: SecretScrubber;
  checkpointCas?: SessionCheckpointCas | undefined;
  isSessionInUse?: ((sessionId: string) => Promise<string | null>) | undefined;
  catalogClient?: SessionCatalogProjectClient | undefined;
  indexFile: string;
  onAppend?: ((event: SessionEvent) => void) | undefined;
  onAppendBatch?: ((events: SessionEvent[]) => void) | undefined;
  storagePolicy: SessionStoragePolicy;
  autoArchive: boolean;
  logWarn: (msg: string, ctx?: Record<string, unknown>) => void;
  ensureShardDir: (id: string) => Promise<string>;
  sessionPath: (id: string, ext: '.jsonl' | '.jsonl.gz' | '.summary.json') => string;
  invalidateShardManifestBySessionId: (id: string) => Promise<void>;
  readSummaryManifest: (id: string) => Promise<SessionSummary | null>;
  persistCatalogSummary: (summary: SessionSummary) => Promise<void>;
  archiveIdle: (policy?: Partial<SessionStoragePolicy>) => Promise<SessionArchiveIdleResult>;
  onIndexAppendCreate: (id: string) => void;
  clearIndexCache: () => void;
}

export async function executeCreateSession(
  host: CreateSessionHost,
  meta: Omit<SessionMetadata, 'startedAt'>,
): Promise<SessionWriter> {
  const startedAt = new Date().toISOString();
  const id = meta.id && meta.id.length > 0 ? meta.id : generateSessionId(startedAt);
  const shardDir = await host.ensureShardDir(id);
  const file = host.sessionPath(id, '.jsonl');
  // Refuse creation over an ID another process still holds live BEFORE any
  // destructive step (registry/lease check mirrors the delete-path guard).
  const inUseBy = host.isSessionInUse ? await host.isSessionInUse(id) : null;
  // Truthiness, deliberately matching assertSessionCanBeDeleted
  // (session-store/delete-session-guards.ts): both gates read the same
  // callback, so they must agree on what counts as a reason. An
  // empty-string reason means "no reason" on BOTH paths —
  // diverging here would let an id be deleted but not recreated.
  if (inUseBy) {
    throw new Error(`Refusing to create session ${id}: in use (${inUseBy}).`);
  }
  const t0 = Date.now();
  // Failure-prone steps run BEFORE the truncating 'w' open below: once the
  // transcript is created/truncated, a later rejection could never restore
  // a prior session's bytes. Manifest invalidation therefore aborts
  // creation up-front (nothing has been destroyed yet); after the open it
  // degrades to best-effort because staleness self-heals via stat mismatch.
  try {
    await host.invalidateShardManifestBySessionId(id);
  } catch (cause) {
    throw new Error(
      `Failed to invalidate stale shard manifest for ${id}: ${toErrorMessage(cause)}`,
      { cause },
    );
  }
  // Fresh-session hygiene: drop any stale sidecar from a prior session
  // under this id so list() cannot publish old metadata before the first
  // checkpoint/close. Transcript cleanliness is guaranteed by the 'w'
  // open below (create-or-truncate).
  await fsp.unlink(host.sessionPath(id, '.jsonl.gz')).catch(() => undefined);
  const sidecar = path.join(shardDir, `${path.basename(id)}.summary.json`);
  try {
    await fsp.rm(sidecar, { force: true });
  } catch (cause) {
    emitSessionStoreError(host.events, id, sidecar, 'create', toErrorMessage(cause), true);
    // A surviving sidecar would be published as THIS session's summary
    // after the transcript is truncated. Only continue when the file is
    // actually gone (ENOENT after a racing unlink).
    try {
      await fsp.access(sidecar);
      throw new Error(
        `Failed to remove stale session sidecar for ${id}: ${toErrorMessage(cause)}`,
        { cause },
      );
    } catch (accessErr) {
      // ENOENT: the racing unlink finished — the file is gone, continue.
      // ENAMETOOLONG: the sidecar path is unrepresentable on this
      // filesystem (Linux NAME_MAX=255), which PROVES the file cannot
      // exist — absence is already established, so continuing is
      // correct. Without this branch the raw errno escapes create()
      // unwrapped on Linux while the transcript-open failure on the
      // same unrepresentable path wraps as `Failed to open session
      // file` below (the documented error contract this path follows).
      const code = (accessErr as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENAMETOOLONG') throw accessErr;
    }
  }
  // Catalog stub upsert BEFORE the truncating 'w' open below: fallible
  // remote IO must reject while prior bytes are still intact rather than
  // destroying a transcript and then failing.
  if (host.catalogClient) {
    await host.catalogClient.call('upsert_summary', {
      summary: {
        id,
        title: meta.title ?? '',
        startedAt,
        model: meta.model ?? '',
        provider: meta.provider ?? '',
        tokenTotal: 0,
        lastActivityAt: startedAt,
      },
      transcriptRelativePath: `${id}.jsonl`,
      summaryRelativePath: `${id}.summary.json`,
    });
  }
  // A deliberate new session with a reused id overrides any prior
  // tombstone — durably, and BEFORE the truncating open: the parser only
  // undeletes on `{action:'create'}`, so a failed row would otherwise
  // hide a live writer forever. In-memory eviction happens only after
  // the control row lands CONFIRMED.
  try {
    await withFileLock(host.indexFile, async () => {
      try {
        await fsp.appendFile(host.indexFile, `${JSON.stringify({ action: 'create', id })}\n`, {
          encoding: 'utf8',
          mode: 0o600,
        });
      } finally {
        // Drop the parsed snapshot whether or not the append reported
        // success. A rejection does not prove nothing landed (a short write,
        // or an error raised while closing after the bytes were already
        // durable), and a cache predating a create row would keep serving a
        // view in which this id is still tombstoned. Invalidation only costs
        // a re-parse, so it is unconditional.
        host.clearIndexCache();
      }
      // The in-memory undelete stays on the SUCCESS path only: evicting the
      // tombstone without a durable {action:'create'} row would make the id
      // look live to this process while every other reader — and this one
      // after a restart — still sees it deleted.
      host.onIndexAppendCreate(id);
    });
  } catch (cause) {
    throw new Error(
      `Failed to record session create in the index for ${id}: ${toErrorMessage(cause)}`,
      { cause },
    );
  }
  let handle: fsp.FileHandle;
  try {
    // 'w' (create-or-truncate): fresh sessions must never inherit bytes
    // from a surviving transcript under a reused id. Append-mode ('a')
    // would preserve them AND cannot be truncated later on Windows
    // (EPERM — append handles lack FILE_WRITE_DATA).
    handle = await fsp.open(file, 'w', 0o600);
  } catch (err) {
    emitSessionStoreError(host.events, id, file, 'create', toErrorMessage(err), false);
    throw new Error(`Failed to open session file: ${toErrorMessage(err)}`, { cause: err });
  }
  // Re-invalidate AFTER the open/hygiene: a concurrent list() between the
  // first invalidation and here could have rebuilt the manifest from the
  // prior session's artifacts.
  await host.invalidateShardManifestBySessionId(id).catch(() => undefined);
  try {
    const writer = new FileSessionWriter(id, handle, startedAt, meta, host.events, {
      dir: shardDir,
      filePath: file,
      secretScrubber: host.secretScrubber,
      checkpointCas: host.checkpointCas,
      onAppend: host.onAppend,
      onAppendBatch: host.onAppendBatch,
      resolveName: async () => {
        const current = await host.readSummaryManifest(id);
        if (!current) return null;
        return current.name === undefined
          ? {}
          : { name: sessionContentText(host.secretScrubber.scrub(current.name)) };
      },
      onClose: async (s) => {
        await host.persistCatalogSummary(s);
        if (host.autoArchive) void host.archiveIdle().catch(() => undefined);
      },
      // Mid-session metadata checkpoints reuse the same sink as close so
      // killed sessions leave accurate index rows / catalog entries behind.
      onMetadataCheckpoint: (s) => host.persistCatalogSummary(s),
    });
    emitSessionStoreWrite(host.events, id, file, 'create', 'success', Date.now() - t0);
    return writer;
  } catch (err) {
    await handle.close().catch((e) =>
      host.logWarn('Session handle close failed', {
        event: 'session_store.handle_close_failed',
        message: e instanceof Error ? e.message : String(e),
      }),
    );
    emitSessionStoreError(host.events, id, file, 'create', toErrorMessage(err), true);
    throw err;
  }
}
