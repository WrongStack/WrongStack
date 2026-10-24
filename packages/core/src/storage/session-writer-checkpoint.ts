import * as fsp from 'node:fs/promises';
import type { SessionMetadata, SessionSummary } from '@wrongstack/contracts/types/session';
import { atomicWrite, withFileLock } from '../utils/atomic-write.js';
import { toErrorMessage } from '../utils/index.js';
import type { EventBus } from './event-bus-port.js';
import type { SessionSummaryTracker } from './session-summary-tracker.js';
import type { SessionWriteBuffer } from './session-write-buffer.js';

export interface MetadataCheckpointContext {
  sessionId: string;
  filePath: string;
  manifestFile: string;
  traceId?: string | undefined;
  events?: EventBus | undefined;
  summaryTracker: SessionSummaryTracker;
  onMetadataCheckpointCb?: ((summary: SessionSummary) => void | Promise<void>) | undefined;
}

/**
 * The name the on-disk manifest carries: `{ name }` (possibly undefined —
 * the name was cleared), or `null` when there is no readable manifest.
 *
 * A session's name is written straight into its manifest by a rename (the
 * history list, `/sessions rename`, the `session_rename` tool), never through
 * the writer, so the tracker's copy is stale the moment a live session is
 * renamed. A checkpoint that wrote its snapshot as-is erased the new name, and
 * `finalize()` — which resolves the name from this same manifest — then found
 * it gone.
 */
async function manifestName(manifestFile: string): Promise<Pick<SessionSummary, 'name'> | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(manifestFile, 'utf8');
  } catch (err) {
    // Unreadable right now is not "no manifest": writing the snapshot anyway
    // would erase a rename. Throw so the checkpoint fails and retries.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as { name?: unknown };
    return typeof parsed.name === 'string' ? { name: parsed.name } : {};
  } catch {
    return null;
  }
}

export async function runMetadataCheckpointOperation(
  ctx: MetadataCheckpointContext,
  onSuccess: () => void,
  onFailure: () => void,
): Promise<void> {
  const {
    endedAt: _priorEndedAt,
    outcome: _priorOutcome,
    ...tracked
  } = ctx.summaryTracker.snapshot();
  let snapshot: SessionSummary = tracked;

  const t0 = Date.now();
  let outcome: 'success' | 'failure' = 'success';
  let errorMsg: string | undefined;
  try {
    if (ctx.manifestFile) {
      await withFileLock(ctx.manifestFile, async () => {
        const onDisk = await manifestName(ctx.manifestFile);
        if (onDisk) {
          const { name: _trackedName, ...rest } = tracked;
          snapshot = onDisk.name !== undefined ? { ...rest, name: onDisk.name } : rest;
        }
        await atomicWrite(ctx.manifestFile, JSON.stringify(snapshot), { mode: 0o600 });
      });
    }
    onSuccess();
    await ctx.onMetadataCheckpointCb?.(snapshot);
  } catch (err) {
    outcome = 'failure';
    errorMsg = toErrorMessage(err);
    onFailure();
  } finally {
    ctx.events?.emit('storage.write', {
      sessionId: ctx.sessionId,
      store: 'session',
      filePath: ctx.manifestFile || ctx.filePath,
      operation: 'metadata_checkpoint',
      outcome,
      durationMs: Date.now() - t0,
      ...(errorMsg !== undefined ? { error: errorMsg } : {}),
      ...(ctx.traceId !== undefined ? { traceId: ctx.traceId } : {}),
    });
  }
}

export interface ClosePersistContext {
  sessionId: string;
  filePath: string;
  manifestFile: string;
  traceId?: string | undefined;
  events?: EventBus | undefined;
  onCloseCb?: ((summary: SessionSummary) => void | Promise<void>) | undefined;
  /**
   * The session name could not be read back (manifest unreadable, not missing).
   * A rename lives only in the manifest and the catalog row, so writing this
   * summary would erase it from both; skip the write and leave them as the last
   * checkpoint left them. The counters are rebuildable from the transcript.
   */
  nameUnresolved?: boolean | undefined;
}

export async function persistSessionCloseSummary(
  ctx: ClosePersistContext,
  summary: SessionSummary,
): Promise<void> {
  const manifestT0 = Date.now();
  let manifestOutcome: 'success' | 'failure' = 'success';
  let manifestError: string | undefined;
  if (ctx.nameUnresolved) {
    if (ctx.manifestFile) {
      ctx.events?.emit('storage.write', {
        sessionId: ctx.sessionId,
        store: 'session',
        filePath: ctx.manifestFile,
        operation: 'close',
        outcome: 'failure',
        durationMs: 0,
        error:
          'summary manifest unreadable at close; final summary skipped to keep the session name',
        ...(ctx.traceId !== undefined ? { traceId: ctx.traceId } : {}),
      });
    }
    return;
  }
  const idxT0 = Date.now();
  let idxOutcome: 'success' | 'failure' = 'success';
  let idxError: string | undefined;

  const persistSummary = async (): Promise<void> => {
    if (ctx.manifestFile) {
      try {
        await atomicWrite(ctx.manifestFile, JSON.stringify(summary), { mode: 0o600 });
      } catch (err) {
        manifestOutcome = 'failure';
        manifestError = toErrorMessage(err);
      }
    }
    try {
      await ctx.onCloseCb?.(summary);
    } catch (err) {
      idxOutcome = 'failure';
      idxError = toErrorMessage(err);
    }
  };

  if (ctx.manifestFile) {
    await withFileLock(ctx.manifestFile, persistSummary);
  } else {
    await persistSummary();
  }

  if (ctx.manifestFile) {
    ctx.events?.emit('storage.write', {
      sessionId: ctx.sessionId,
      store: 'session',
      filePath: ctx.manifestFile,
      operation: 'close',
      outcome: manifestOutcome,
      durationMs: Date.now() - manifestT0,
      ...(manifestError !== undefined ? { error: manifestError } : {}),
      ...(ctx.traceId !== undefined ? { traceId: ctx.traceId } : {}),
    });
  }
  ctx.events?.emit('storage.write', {
    sessionId: summary.id,
    store: 'session',
    filePath: ctx.filePath,
    operation: 'index_append',
    outcome: idxOutcome,
    durationMs: Date.now() - idxT0,
    ...(idxError !== undefined ? { error: idxError } : {}),
    ...(ctx.traceId !== undefined ? { traceId: ctx.traceId } : {}),
  });
}

export interface ClearSessionContext {
  id: string;
  filePath: string;
  meta: Omit<SessionMetadata, 'startedAt'>;
  handle: fsp.FileHandle;
  buffer: SessionWriteBuffer;
  summaryTracker: SessionSummaryTracker;
  cancelMetadataTimer: () => void;
  metadataCheckpointInFlight?: Promise<void> | null;
  scheduleMetadataCheckpoint: () => void;
  onCleared: () => void;
}

export async function executeClearSession(ctx: ClearSessionContext): Promise<void> {
  if (!ctx.filePath) return;
  ctx.buffer.cancelTimer();
  await ctx.buffer.drainFlushPromise();
  ctx.buffer.clear();
  await ctx.buffer.drainWriteChain();
  ctx.cancelMetadataTimer();
  await ctx.metadataCheckpointInFlight?.catch(() => undefined);
  const resetAt = new Date().toISOString();
  const record = `${JSON.stringify({
    type: 'session_start',
    ts: resetAt,
    id: ctx.id,
    model: ctx.meta.model ?? 'unknown',
    provider: ctx.meta.provider ?? 'unknown',
    ...(ctx.meta.checkout ? { checkout: ctx.meta.checkout } : {}),
  })}\n`;
  await ctx.handle.close();
  await atomicWrite(ctx.filePath, record, { mode: 0o600 });
  ctx.summaryTracker.reset(resetAt);
  ctx.scheduleMetadataCheckpoint();
  ctx.onCleared();
}
