import type {
  HqClientCommandAckMessage,
  HqClientCommandPollMessage,
  HqClientEventMessage,
  HqClientHelloMessage,
} from './protocol.js';

export interface QueuedFrame {
  serialized: string;
  bytes: number;
  /**
   * State snapshots are rollups: while offline, only the newest snapshot for
   * a scope has value. Event/transcript frames intentionally have no key and
   * retain FIFO semantics.
   */
  coalesceKey?: string | undefined;
}

export function queuedFrameCoalesceKey(
  frame:
    | HqClientHelloMessage
    | HqClientEventMessage
    | HqClientCommandPollMessage
    | HqClientCommandAckMessage,
): string | undefined {
  if (frame.type !== 'client.event' || !frame.event.type.endsWith('.snapshot')) {
    return undefined;
  }
  const payload = frame.event.payload as { chunkIndex?: unknown } | undefined;
  const chunk =
    typeof payload?.chunkIndex === 'number' && Number.isFinite(payload.chunkIndex)
      ? String(payload.chunkIndex)
      : '';
  return [frame.event.type, frame.event.sessionId ?? '', frame.event.runId ?? '', chunk].join('|');
}

export interface PublisherQueueStats {
  entries: number;
  bytes: number;
  maxBytes: number;
  droppedFrames: number;
  droppedBytes: number;
  coalescedFrames: number;
  coalescedBytes: number;
}

export class PublisherQueue {
  private queue: QueuedFrame[] = [];
  private queueBytes = 0;
  private droppedFrames = 0;
  private droppedBytes = 0;
  private coalescedFrames = 0;
  private coalescedBytes = 0;

  constructor(
    public readonly maxQueuedMessages: number,
    public readonly maxQueuedBytes: number,
  ) {}

  get length(): number {
    return this.queue.length;
  }

  get bytes(): number {
    return this.queueBytes;
  }

  clear(): void {
    this.queue = [];
    this.queueBytes = 0;
  }

  enqueue(serialized: string, coalesceKey?: string): boolean {
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes > this.maxQueuedBytes) {
      this.droppedFrames += 1;
      this.droppedBytes += bytes;
      process.emitWarning(
        `HQ telemetry frame of ${bytes} bytes exceeds the ${this.maxQueuedBytes}-byte offline queue cap and was dropped.`,
        { code: 'WRONGSTACK_HQ_FRAME_TOO_LARGE' },
      );
      return false;
    }

    if (coalesceKey !== undefined) {
      let existingIndex = -1;
      for (let index = this.queue.length - 1; index >= 0; index -= 1) {
        if (this.queue[index]?.coalesceKey === coalesceKey) {
          existingIndex = index;
          break;
        }
      }
      if (existingIndex !== -1) {
        const [obsolete] = this.queue.splice(existingIndex, 1);
        if (obsolete !== undefined) {
          this.queueBytes -= obsolete.bytes;
          this.coalescedFrames += 1;
          this.coalescedBytes += obsolete.bytes;
        }
      }
    }

    while (
      (this.queue.length >= this.maxQueuedMessages ||
        this.queueBytes + bytes > this.maxQueuedBytes) &&
      this.queue.length > 0
    ) {
      const dropped = this.queue.shift();
      if (dropped !== undefined) {
        this.queueBytes -= dropped.bytes;
        this.droppedFrames += 1;
        this.droppedBytes += dropped.bytes;
      }
    }
    this.queue.push({ serialized, bytes, coalesceKey });
    this.queueBytes += bytes;
    return true;
  }

  spliceBatch(batchSize = 50): QueuedFrame[] {
    const batch = this.queue.splice(0, batchSize);
    for (const frame of batch) {
      this.queueBytes -= frame.bytes;
    }
    this.queueBytes = Math.max(0, this.queueBytes);
    return batch;
  }

  getStats(): PublisherQueueStats {
    return {
      entries: this.queue.length,
      bytes: this.queueBytes,
      maxBytes: this.maxQueuedBytes,
      droppedFrames: this.droppedFrames,
      droppedBytes: this.droppedBytes,
      coalescedFrames: this.coalescedFrames,
      coalescedBytes: this.coalescedBytes,
    };
  }
}
