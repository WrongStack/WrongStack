/**
 * Collect fire-and-forget writes issued in the same event-loop turn and send
 * them to storage as one batch. The FIFO promise still serializes batches,
 * while drain() observes batches queued during an in-flight write as well.
 */
export class BestEffortBatchQueue<T> {
  private readonly pending: T[] = [];
  private activeWrite: Promise<void> | null = null;
  private drainScheduled = false;
  private static readonly MAX_PENDING = 10_000;

  constructor(private readonly writeBatch: (items: T[]) => Promise<void>) {}

  enqueue(item: T): void {
    if (this.pending.length >= BestEffortBatchQueue.MAX_PENDING) this.pending.shift();
    this.pending.push(item);
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => this.flushPending());
  }

  async drain(): Promise<void> {
    for (;;) {
      this.flushPending();
      const observed = this.activeWrite;
      if (observed) await observed;
      if (!this.activeWrite && this.pending.length === 0) return;
    }
  }

  private flushPending(): void {
    this.drainScheduled = false;
    if (this.activeWrite || this.pending.length === 0) return;
    const batch = this.pending.splice(0);
    const active = this.writeBatch(batch)
      .catch((err: unknown) => {
        /* best-effort: a failed batch must not break the write chain, but
         * surface the error to stderr so a silent write death is observable.
         * Programmer errors (TypeError, etc.) should not go unnoticed. */
        console.error(
          `[BestEffortBatchQueue] failed to write batch of ${batch.length} item(s):`,
          err,
        );
      })
      .finally(() => {
        if (this.activeWrite === active) this.activeWrite = null;
        if (this.pending.length > 0) this.flushPending();
      });
    this.activeWrite = active;
  }
}

/** Coalesce queued checkpoints so only the newest not-yet-started value writes. */
export class BestEffortLatestQueue<T> {
  private pending: T | undefined;
  private activeWrite: Promise<void> | null = null;
  private drainScheduled = false;

  constructor(private readonly writeLatest: (value: T) => Promise<void>) {}

  enqueue(value: T): void {
    this.pending = value;
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => this.flushPending());
  }

  async drain(): Promise<void> {
    for (;;) {
      this.flushPending();
      const observed = this.activeWrite;
      if (observed) await observed;
      if (!this.activeWrite && this.pending === undefined) return;
    }
  }

  private flushPending(): void {
    this.drainScheduled = false;
    if (this.activeWrite || this.pending === undefined) return;
    const latest = this.pending;
    this.pending = undefined;
    const active = this.writeLatest(latest)
      .catch((err: unknown) => {
        /* best-effort: a failed write must not break the write chain, but
         * surface the error to stderr so a silent write death is observable.
         * Programmer errors (TypeError, etc.) should not go unnoticed. */
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'hq.persistence_latest_write_failed',
            message: err instanceof Error ? err.message : String(err),
            timestamp: new Date().toISOString(),
          }),
        );
      })
      .finally(() => {
        if (this.activeWrite === active) this.activeWrite = null;
        if (this.pending !== undefined) this.flushPending();
      });
    this.activeWrite = active;
  }
}
