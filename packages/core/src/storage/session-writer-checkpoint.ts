import type * as fsp from 'node:fs/promises';
import type { SessionMetadata, SessionSummary } from '../types/session.js';
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

export async function runMetadataCheckpointOperation(
  ctx: MetadataCheckpointContext,
  onSuccess: () => void,
  onFailure: () => void,
): Promise<void> {
  const {
    endedAt: _priorEndedAt,
    outcome: _priorOutcome,
    ...snapshot
  } = ctx.summaryTracker.snapshot();

  const t0 = Date.now();
  let outcome: 'success' | 'failure' = 'success';
  let errorMsg: string | undefined;
  try {
    if (ctx.manifestFile) {
      await withFileLock(ctx.manifestFile, async () => {
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
}

export async function persistSessionCloseSummary(
  ctx: ClosePersistContext,
  summary: SessionSummary,
): Promise<void> {
  const manifestT0 = Date.now();
  let manifestOutcome: 'success' | 'failure' = 'success';
  let manifestError: string | undefined;
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
  })}\n`;
  await ctx.handle.close();
  await atomicWrite(ctx.filePath, record, { mode: 0o600 });
  ctx.summaryTracker.reset(resetAt);
  ctx.scheduleMetadataCheckpoint();
  ctx.onCleared();
}
