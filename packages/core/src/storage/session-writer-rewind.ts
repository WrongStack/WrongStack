import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { SessionEvent } from '../types/session.js';
import { toErrorMessage } from '../utils/index.js';
import type { EventBus } from './event-bus-port.js';
import type { SessionSummaryTracker } from './session-summary-tracker.js';
import type { SessionWriteBuffer } from './session-write-buffer.js';
import {
  findSessionCheckpointTruncatePlan,
  rewriteSessionToCheckpoint,
} from './session-writer-truncate.js';

export async function deleteRewoundSubagentTranscripts(
  sessionId: string,
  sessionFilePath: string,
  transcriptPaths: readonly string[],
  emitEvent?: (event: string, payload: Record<string, unknown>) => void,
): Promise<void> {
  if (transcriptPaths.length === 0) return;
  const sessionsRoot = sessionId.includes('/')
    ? path.dirname(path.dirname(sessionFilePath))
    : path.dirname(sessionFilePath);
  const allowedRoot = path.join(sessionsRoot, 'subagents');
  const realAllowedRoot = await fsp.realpath(allowedRoot).catch(() => null);
  if (!realAllowedRoot) return;

  const deleted: string[] = [];
  for (const transcriptPath of transcriptPaths) {
    const resolved = path.resolve(transcriptPath);
    const relative = path.relative(realAllowedRoot, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    await fsp.rm(resolved, { force: true }).then(
      () => {
        deleted.push(resolved);
      },
      (err) => {
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'session.rewind_subagent_delete_failed',
            sessionId,
            filePath: resolved,
            error: toErrorMessage(err),
            timestamp: new Date().toISOString(),
          }),
        );
      },
    );
  }
  if (deleted.length > 0 && emitEvent) {
    emitEvent('session.rewind_subagents_deleted', {
      sessionId,
      transcriptPaths: deleted,
    });
  }
}

export interface SessionTruncateContext {
  sessionId: string;
  filePath: string;
  targetPromptIndex: number;
  revertedFiles?: readonly string[] | undefined;
  closed: boolean;
  buffer: SessionWriteBuffer;
  handle: fsp.FileHandle;
  setHandle: (handle: fsp.FileHandle) => void;
  events?: EventBus | undefined;
  summaryTracker: SessionSummaryTracker;
  append: (event: SessionEvent) => Promise<void>;
  cancelMetadataTimer: () => void;
  metadataCheckpointInFlight?: Promise<void> | null | undefined;
  scheduleMetadataCheckpoint: () => void;
  setActivePromptIndex: (index: number) => void;
}

export async function executeSessionTruncate(ctx: SessionTruncateContext): Promise<number> {
  if (!ctx.filePath) return 0;

  // Flush buffered events to disk before reading — otherwise the in-memory
  // events that haven't hit the JSONL yet would be invisible to the
  // truncation logic and would be silently dropped by the rewrite.
  ctx.buffer.cancelTimer();
  await ctx.buffer.flushBuffer(ctx.closed, { datasync: true });
  // Drain the write chain so no in-flight write straddles the close/rename/reopen.
  await ctx.buffer.drainWriteChain();
  // Stop mid-session metadata checkpointing across the file rewrite: the
  // summary counters are recomputed from disk below, and an armed timer or
  // in-flight checkpoint could write pre-rewind state over them.
  ctx.cancelMetadataTimer();
  await ctx.metadataCheckpointInFlight?.catch(() => undefined);

  const plan = await findSessionCheckpointTruncatePlan(ctx.filePath, ctx.targetPromptIndex).catch(
    (err) => {
      // Lookup failed: re-arm live checkpointing so dirty metadata is not
      // stranded until the next unrelated event.
      ctx.scheduleMetadataCheckpoint();
      throw err;
    },
  );
  if (!plan) {
    // No matching checkpoint: same re-arm obligation as the error path.
    ctx.scheduleMetadataCheckpoint();
    return 0;
  }

  // Windows EPERM fix: close the append-mode handle before replacing the
  // file. Windows rejects rename() when the destination still has an open
  // handle, even if that handle belongs to this process.
  await ctx.buffer.drainWriteChain();
  try {
    await ctx.handle.close();
  } catch {
    // Ignore — handle may already be closed (e.g. by clearSession).
  }
  try {
    await rewriteSessionToCheckpoint(ctx.filePath, plan.checkpointByteOffset);
    await deleteRewoundSubagentTranscripts(
      ctx.sessionId,
      ctx.filePath,
      plan.removedSubagentTranscriptPaths,
      (ev, payload) => ctx.events?.emit(ev, payload),
    );
    // Re-open in append mode for continued use of this file.
    ctx.setHandle(await fsp.open(ctx.filePath, 'a', 0o600));
  } catch (err) {
    ctx.setHandle(await fsp.open(ctx.filePath, 'a', 0o600).catch(() => ctx.handle));
    ctx.scheduleMetadataCheckpoint();
    throw err;
  }

  // The summary counters accumulate as events are observed and know nothing
  // about truncation, so without this `close()` would write a .summary.json —
  // and an _index.jsonl row, which list() reads — still counting the tool
  // calls, file changes and tokens of the work just rewound.
  await ctx.summaryTracker.recomputeFromDisk(ctx.filePath);

  const reverted = [...(ctx.revertedFiles ?? [])];
  await ctx.append({
    type: 'rewound',
    ts: new Date().toISOString(),
    toPromptIndex: ctx.targetPromptIndex,
    revertedFiles: reverted,
  });
  ctx.setActivePromptIndex(ctx.targetPromptIndex);

  ctx.events?.emit('session.rewound', {
    sessionId: ctx.sessionId,
    toPromptIndex: ctx.targetPromptIndex,
    revertedFiles: reverted,
    removedEvents: plan.removedCount,
  });

  return plan.removedCount;
}
