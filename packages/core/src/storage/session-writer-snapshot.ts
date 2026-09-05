import type * as fsp from 'node:fs/promises';
import type { SessionEvent, WorkspaceCheckpointRef } from '../types/session.js';
import { toErrorMessage } from '../utils/index.js';
import type { EventBus } from './event-bus-port.js';
import type { SessionCheckpointCas } from './session-checkpoint-cas.js';
import type { SessionWriteBuffer } from './session-write-buffer.js';

/**
 * Event types that must reach disk without waiting for FLUSH_SIZE /
 * FLUSH_INTERVAL_MS. Losing one of these to a SIGKILL makes a resumed
 * transcript lie about what actually happened: the user's prompt or the
 * assistant's response vanishes, or a dangling marker hides crash state
 * from recovery. Everything else keeps riding the batched buffer.
 */
export const CRITICAL_EVENT_TYPES: ReadonlySet<SessionEvent['type']> = new Set([
  'user_input',
  'llm_response',
  'checkpoint',
  'rewound',
  'in_flight_start',
  'in_flight_end',
]);

export function isCriticalEvent(event: SessionEvent): boolean {
  return CRITICAL_EVENT_TYPES.has(event.type);
}

export interface PendingFileSnapshot {
  path: string;
  action: 'created' | 'modified' | 'deleted';
  before: string | null;
  after: string | null;
}

export class SessionSnapshotTracker {
  private pending: PendingFileSnapshot[] = [];
  private pendingBytes = 0;
  static readonly MAX_ENTRIES = 256;
  static readonly MAX_BYTES = 16 * 1024 * 1024;

  get length(): number {
    return this.pending.length;
  }

  get bytes(): number {
    return this.pendingBytes;
  }

  clear(): void {
    this.pending = [];
    this.pendingBytes = 0;
  }

  takePending(): PendingFileSnapshot[] {
    const items = [...this.pending];
    this.pending = [];
    this.pendingBytes = 0;
    return items;
  }

  recordFileChange(
    sessionId: string,
    activePromptIndex: number | null,
    input: PendingFileSnapshot,
    bufferSynchronousEvent: (event: SessionEvent) => void,
  ): void {
    if (activePromptIndex === null) {
      // Compatibility path for embedders that mutate before their first
      // checkpoint. writeCheckpoint()/close() will attach these changes to the
      // first available prompt index.
      const bytes =
        Buffer.byteLength(input.path, 'utf8') +
        (input.before ? Buffer.byteLength(input.before, 'utf8') : 0) +
        (input.after ? Buffer.byteLength(input.after, 'utf8') : 0);
      if (
        this.pending.length >= SessionSnapshotTracker.MAX_ENTRIES ||
        bytes > SessionSnapshotTracker.MAX_BYTES ||
        this.pendingBytes + bytes > SessionSnapshotTracker.MAX_BYTES
      ) {
        console.warn(
          JSON.stringify({
            level: 'error',
            event: 'session.file_snapshot_buffer_overflow',
            sessionId,
            bufferedFiles: this.pending.length,
            bufferedBytes: this.pendingBytes,
            timestamp: new Date().toISOString(),
          }),
        );
        return;
      }
      this.pending.push(input);
      this.pendingBytes += bytes;
      return;
    }

    // This method is intentionally synchronous because file tools call it
    // immediately after their atomic mutation. Put the reconstruct event in
    // the writer buffer before the tool returns; agent-tools flushes the buffer
    // together with the matching tool_result boundary.
    const event: SessionEvent = {
      type: 'file_snapshot',
      ts: new Date().toISOString(),
      promptIndex: activePromptIndex,
      files: [input],
    };
    bufferSynchronousEvent(event);
  }
}

export interface SyncBufferDispatchContext {
  buffer: SessionWriteBuffer;
  closed: boolean;
  handle: fsp.FileHandle;
  sessionId: string;
}

export function dispatchSynchronousBufferEvent(
  ctx: SyncBufferDispatchContext,
  appendEvent: SessionEvent,
  critical: boolean,
): void {
  if (!ctx.buffer.push(appendEvent)) {
    // Buffer rejected the event (overflow). Drain what is there and
    // re-push; a CRITICAL event must not wait out the 500ms window just
    // because its first push lost the race against a full buffer.
    ctx.buffer.cancelTimer();
    void ctx.buffer
      .flushBuffer(ctx.closed, { datasync: true })
      .catch(() => undefined)
      .then(() => {
        if (ctx.buffer.push(appendEvent)) {
          if (!critical) return;
          ctx.buffer.cancelTimer();
          void ctx.buffer.flushBuffer(ctx.closed, { datasync: true }).catch(() => undefined);
          return;
        }
        // Buffer refilled faster than we could reclaim space: write the
        // CRITICAL event through the serialized chain directly rather than
        // dropping it (enqueueWrite preserves ordering; appendEvent is
        // already scrubbed above).
        void ctx.buffer
          .drainWriteChain()
          .then(() => ctx.buffer.enqueueWrite(`${JSON.stringify(appendEvent)}\n`))
          .then(() => {
            if (!critical) return;
            return ctx.handle.datasync().catch(() => undefined);
          })
          .catch((err) => {
            console.warn(
              JSON.stringify({
                level: 'error',
                event: 'session.sync_journal_write_failed',
                sessionId: ctx.sessionId,
                eventType: appendEvent.type,
                message: toErrorMessage(err),
                timestamp: new Date().toISOString(),
              }),
            );
          });
      });
  } else if (critical || ctx.buffer.shouldFlushNow()) {
    ctx.buffer.cancelTimer();
    void ctx.buffer.flushBuffer(ctx.closed, { datasync: true }).catch(() => {
      // Retained at the head of writeBuffer for the boundary retry.
    });
  } else {
    ctx.buffer.scheduleFlush(ctx.closed);
  }
}

export interface WriteCheckpointContext {
  sessionId: string;
  snapshotTracker: SessionSnapshotTracker;
  checkpointCas?: SessionCheckpointCas | undefined;
  events?: EventBus | undefined;
  append: (event: SessionEvent) => Promise<void>;
  writeFileSnapshot: (promptIndex: number, files: PendingFileSnapshot[]) => Promise<void>;
  setActivePromptIndex: (promptIndex: number) => void;
}

export async function writeSessionCheckpoint(
  ctx: WriteCheckpointContext,
  promptIndex: number,
  promptPreview: string,
): Promise<void> {
  const fileCount = ctx.snapshotTracker.length;
  if (fileCount > 0) {
    await ctx.writeFileSnapshot(promptIndex, ctx.snapshotTracker.takePending());
  }
  let workspaceCheckpoint: WorkspaceCheckpointRef | undefined;
  try {
    workspaceCheckpoint = await ctx.checkpointCas?.capture(ctx.sessionId, promptIndex);
  } catch (err) {
    // Conversation checkpoints remain usable when Git/CAS capture is unavailable; missing
    // workspaceCheckpoint makes the reduced guarantee explicit to fork/materialization callers.
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'session.workspace_checkpoint_capture_failed',
        sessionId: ctx.sessionId,
        promptIndex,
        message: toErrorMessage(err),
        timestamp: new Date().toISOString(),
      }),
    );
  }
  await ctx.append({
    type: 'checkpoint',
    ts: new Date().toISOString(),
    promptIndex,
    promptPreview,
    ...(workspaceCheckpoint ? { workspaceCheckpoint } : {}),
  });
  ctx.setActivePromptIndex(promptIndex);
  ctx.events?.emit('checkpoint.written', {
    sessionId: ctx.sessionId,
    promptIndex,
    promptPreview,
    ts: new Date().toISOString(),
    fileCount,
    ...(workspaceCheckpoint ? { workspaceCheckpoint } : {}),
  });
}
