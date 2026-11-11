/**
 * Buffer-push and post-append flush steps shared by
 * `FileSessionWriter.append()` and `appendBatch()`. Split out of
 * file-session-writer.ts.
 */
import type * as fsp from 'node:fs/promises';
import type { SessionEvent } from '@wrongstack/contracts/types/session';
import type { EventBus } from './event-bus-port.js';
import type { SessionWriteBuffer } from './session-write-buffer.js';
import { isCriticalEvent } from './session-writer-snapshot.js';

export function stampBranchAndSeq(
  event: SessionEvent,
  seq: number,
  activeBranchId: string,
): SessionEvent {
  if (
    event.branchId === undefined &&
    activeBranchId !== 'main' &&
    event.type !== 'branch_created' &&
    event.type !== 'branch_switched' &&
    event.type !== 'branch_folded' &&
    event.type !== 'branch_status_changed'
  ) {
    return { ...event, seq, branchId: activeBranchId };
  }
  return { ...event, seq };
}

export function warnMissingMetadataCheckpointSink(sessionId: string): void {
  console.warn(
    JSON.stringify({
      level: 'warn',
      event: 'session.metadata_checkpoint_no_sink',
      sessionId,
      message:
        'metadataCheckpointMs set but neither onMetadataCheckpoint nor manifestFile configured; mid-session checkpoints disabled.',
      timestamp: new Date().toISOString(),
    }),
  );
}

export async function appendInFlightStart(
  sessionId: string,
  context: string,
  append: (ev: SessionEvent) => Promise<void>,
  events?: EventBus | undefined,
): Promise<void> {
  if (!context || context.length > 500) {
    throw new Error('In-flight context must be 1..500 chars');
  }
  await append({
    type: 'in_flight_start',
    ts: new Date().toISOString(),
    context,
  });
  events?.emit('in_flight.started', {
    sessionId,
    context,
    ts: new Date().toISOString(),
  });
}

export async function appendInFlightEnd(
  sessionId: string,
  reason: 'clean' | 'aborted' | 'recovered',
  append: (ev: SessionEvent) => Promise<void>,
  events?: EventBus | undefined,
): Promise<void> {
  await append({
    type: 'in_flight_end',
    ts: new Date().toISOString(),
    reason,
  });
  events?.emit('in_flight.ended', {
    sessionId,
    reason,
    ts: new Date().toISOString(),
  });
}

/**
 * Push one scrubbed event into the write buffer. When the buffer refuses it,
 * flush and retry; when it still refuses, fall back to a serialized direct
 * write (mirrors bufferSynchronousEvent): never silently drop an event after
 * an overflow flush. Critical events sync here too — the empty-buffer flush
 * after the append cannot datasync bytes that bypassed the buffer (>16MiB
 * push failure).
 *
 * `propagateCriticalFlushError` keeps appendBatch's contract: an overflow
 * flush failure on a critical event surfaces instead of being swallowed.
 */
export async function pushOrWriteThrough(
  buffer: SessionWriteBuffer,
  scrubbed: SessionEvent,
  closed: boolean,
  getHandle: () => fsp.FileHandle,
  propagateCriticalFlushError: boolean,
): Promise<void> {
  if (buffer.push(scrubbed)) return;
  buffer.cancelTimer();
  if (propagateCriticalFlushError && isCriticalEvent(scrubbed)) {
    await buffer.flushBuffer(closed, { datasync: true });
  } else {
    await buffer.flushBuffer(closed, { datasync: true }).catch(() => undefined);
  }
  if (buffer.push(scrubbed)) return;
  await buffer
    .drainWriteChain()
    .then(() => buffer.enqueueWrite(`${JSON.stringify(scrubbed)}\n`))
    .then(() => {
      if (!isCriticalEvent(scrubbed)) return;
      return getHandle()
        .datasync()
        .catch(() => undefined);
    });
}

/**
 * Flush after an append. Critical events (user_input/llm_response/checkpoint/
 * in_flight_*) and buffer-full both flush immediately; the pending timer is
 * cancelled so the next tick does not double-flush. Critical events MUST
 * reach disk — a flush failure on a user prompt or model response makes the
 * transcript unreliable for recovery, so the error propagates. Non-critical
 * flushes are best-effort: the failed batch remains at the front of the
 * buffer and an explicit boundary flush can surface the error, while ordinary
 * audit appends do not abort the agent loop.
 */
export async function flushAfterAppend(
  buffer: SessionWriteBuffer,
  closed: boolean,
  critical: boolean,
): Promise<void> {
  if (!critical && !buffer.shouldFlushNow()) {
    buffer.scheduleFlush(closed);
    return;
  }
  buffer.cancelTimer();
  if (critical) {
    await buffer.flushBuffer(closed, { datasync: true });
  } else {
    await buffer.flushBuffer(closed, { datasync: true }).catch(() => {});
  }
}
