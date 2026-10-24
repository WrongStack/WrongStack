import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { SessionEvent } from '@wrongstack/contracts/types/session';
import { toErrorMessage } from '../utils/index.js';
import type { EventBus } from './event-bus-port.js';
import type { SessionSummaryTracker } from './session-summary-tracker.js';
import type { SessionWriteBuffer } from './session-write-buffer.js';
import {
  keptBytesForCheckpoint,
  stashRewoundTail,
  unstashRewoundTail,
} from './session-writer-redo.js';
import {
  findSessionCheckpointTruncatePlan,
  rewriteSessionToCheckpoint,
} from './session-writer-truncate.js';

/**
 * The transcript paths that resolve inside this session store's `subagents/`
 * directory. Journal content is not trusted to name files elsewhere.
 */
async function containedTranscriptPaths(
  sessionId: string,
  sessionFilePath: string,
  transcriptPaths: readonly string[],
): Promise<Array<{ resolved: string; real: string }>> {
  if (transcriptPaths.length === 0) return [];
  const sessionsRoot = sessionId.includes('/')
    ? path.dirname(path.dirname(sessionFilePath))
    : path.dirname(sessionFilePath);
  const allowedRoot = path.join(sessionsRoot, 'subagents');
  const realAllowedRoot = await fsp.realpath(allowedRoot).catch(() => null);
  if (!realAllowedRoot) return [];
  const out: Array<{ resolved: string; real: string }> = [];
  for (const transcriptPath of transcriptPaths) {
    const resolved = path.resolve(transcriptPath);
    // Containment must compare two canonical paths. On macOS os.tmpdir() is
    // `/var/folders/...`, a symlink to `/private/var/folders/...`; comparing
    // the raw resolved path against the real allowed root would always read
    // as an escape and silently skip every deletion.
    const realResolved = await fsp.realpath(resolved).catch(() => resolved);
    const relative = path.relative(realAllowedRoot, realResolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      continue;
    }
    out.push({ resolved, real: realResolved });
  }
  return out;
}

export async function deleteRewoundSubagentTranscripts(
  sessionId: string,
  sessionFilePath: string,
  transcriptPaths: readonly string[],
  emitEvent?: (event: string, payload: Record<string, unknown>) => void,
): Promise<void> {
  const contained = await containedTranscriptPaths(sessionId, sessionFilePath, transcriptPaths);
  if (contained.length === 0) return;

  const deleted: string[] = [];
  for (const { resolved, real: realResolved } of contained) {
    await fsp.rm(resolved, { force: true }).then(
      () => {
        deleted.push(realResolved);
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
  /** Prompt index before the rewind, stashed for a redo. */
  getActivePromptIndex: () => number | null;
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
    // Keep what is about to be cut so `/redo` can put it back. Best effort: a
    // failed stash only means this rewind cannot be redone.
    let stashedTranscripts: string[] = [];
    let stashed = false;
    try {
      const contained = await containedTranscriptPaths(
        ctx.sessionId,
        ctx.filePath,
        plan.removedSubagentTranscriptPaths,
      );
      stashedTranscripts = await stashRewoundTail({
        journalPath: ctx.filePath,
        keptBytes: await keptBytesForCheckpoint(ctx.filePath, plan.checkpointByteOffset),
        activePromptIndex: ctx.getActivePromptIndex(),
        toPromptIndex: ctx.targetPromptIndex,
        transcriptPaths: contained.map((c) => c.resolved),
      });
      stashed = true;
    } catch {
      /* redo unavailable for this rewind */
    }
    try {
      await rewriteSessionToCheckpoint(ctx.filePath, plan.checkpointByteOffset);
    } catch (err) {
      // The journal is unchanged, so the stash must not keep the transcripts
      // it still links (the next checkpoint's clearRedoStash would delete them).
      if (stashed) await unstashRewoundTail(ctx.filePath).catch(() => undefined);
      throw err;
    }
    await deleteRewoundSubagentTranscripts(
      ctx.sessionId,
      ctx.filePath,
      plan.removedSubagentTranscriptPaths.filter(
        (p) => !stashedTranscripts.includes(path.resolve(p)),
      ),
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
