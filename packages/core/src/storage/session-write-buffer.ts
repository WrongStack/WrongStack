import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import type { EventBus } from './event-bus-port.js';
import type { SessionEvent } from '../types/session.js';
import { toErrorMessage } from '../utils/index.js';

function isClosedHandleError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EBADF' || code === 'ERR_CLOSED_RESOURCE' || code === 'ERR_INVALID_HANDLE';
}

export interface SessionWriteBufferOptions {
  sessionId: string;
  filePath: string;
  getHandle: () => fsp.FileHandle;
  setHandle: (handle: fsp.FileHandle) => void;
  events?: EventBus | undefined;
  getTraceId?: () => string | undefined;
}

/**
 * Options for explicit (immediate-path) flushes.
 */
export interface FlushBufferOptions {
  /**
   * fsync-level durability after the append lands: disk-durable rather than
   * only page-cache durable (SIGKILL survives page cache; power loss does
   * not). Best-effort — a failed datasync never fails the flush itself.
   */
  datasync?: boolean;
}

/**
 * A single append handed to the write chain. It carries only what the chain
 * and `flushSync` actually read. The drained batch's events/bytes stay local
 * to `flushBufferOnce` (which owns the rollback) so no future reader can
 * mistake an `enqueueWrite` flight — which never has events — for a buffer
 * batch and silently get an empty array.
 */
interface InFlightBatch {
  data: string;
  stolen: boolean;
  started: boolean;
}

export class SessionWriteBuffer {
  private static readonly FLUSH_INTERVAL_MS = 500;
  private static readonly FLUSH_SIZE = 50;
  private static readonly WRITE_BUFFER_MAX_EVENTS = 2_000;
  private static readonly WRITE_BUFFER_MAX_BYTES = 16 * 1024 * 1024;
  /**
   * Absolute ceiling for ONE event, even via the empty-buffer exemption in
   * `push`. That exemption exists so a legitimately huge user prompt is
   * persisted instead of silently dropped (its bytes are already resident —
   * accepting it costs one reference, not a copy); without a ceiling an
   * unbounded payload could pin memory and stall the event loop on
   * stringify. 64MiB is 4x the retention budget and far above any real
   * prompt, so it only fires on pathological input.
   */
  private static readonly MAX_SINGLE_EVENT_BYTES = 64 * 1024 * 1024;
  private writeBuffer: SessionEvent[] = [];
  private writeBufferBytes = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private bufferOverflowCount = 0;
  private lastBufferOverflowWarnAt = 0;
  private appendFailCount = 0;
  private lastAppendWarnAt = 0;
  private invalidEventCount = 0;
  private lastInvalidEventWarnAt = 0;

  private writeChain: Promise<void> = Promise.resolve();
  private flushPromise: Promise<void> | null = null;
  /**
   * Batch currently inside enqueueWrite. `flushSync` may steal it if the
   * async append has not started, so a dying process writes in-flight +
   * remaining buffer as one ordered append instead of racing a second fd.
   */
  private inFlight: InFlightBatch | null = null;

  constructor(private readonly opts: SessionWriteBufferOptions) {}

  get isClosed(): boolean {
    return false;
  }

  get length(): number {
    return this.writeBuffer.length;
  }

  private eventBytes(event: SessionEvent): number {
    try {
      return Buffer.byteLength(JSON.stringify(event), 'utf8') + 1;
    } catch {
      return Number.NaN;
    }
  }

  push(event: SessionEvent): boolean {
    const bytes = this.eventBytes(event);
    if (!Number.isFinite(bytes)) {
      // JSON.stringify threw (circular/self-referential payload): the event
      // cannot be journaled. Drop it, but never silently — a counter-only
      // drop made this failure invisible to operators. Rate-limited the same
      // way as buffer_overflow so a hostile event stream cannot spam logs.
      this.invalidEventCount++;
      const now = Date.now();
      if (now - this.lastInvalidEventWarnAt > 5_000) {
        this.lastInvalidEventWarnAt = now;
        console.warn(
          JSON.stringify({
            level: 'error',
            event: 'session.buffer_push_invalid',
            sessionId: this.opts.sessionId,
            reason: 'event is not JSON-serializable',
            droppedEvents: this.invalidEventCount,
            timestamp: new Date().toISOString(),
          }),
        );
      }
      return false;
    }
    const oversizedSingleEvent =
      bytes > SessionWriteBuffer.WRITE_BUFFER_MAX_BYTES &&
      bytes <= SessionWriteBuffer.MAX_SINGLE_EVENT_BYTES &&
      this.writeBuffer.length === 0;
    if (
      this.writeBuffer.length >= SessionWriteBuffer.WRITE_BUFFER_MAX_EVENTS ||
      (!oversizedSingleEvent &&
        (bytes > SessionWriteBuffer.WRITE_BUFFER_MAX_BYTES ||
          this.writeBufferBytes + bytes > SessionWriteBuffer.WRITE_BUFFER_MAX_BYTES))
    ) {
      this.bufferOverflowCount++;
      const now = Date.now();
      if (now - this.lastBufferOverflowWarnAt > 5_000) {
        console.warn(
          JSON.stringify({
            level: 'error',
            event: 'session.buffer_overflow',
            sessionId: this.opts.sessionId,
            bufferedEvents: this.writeBuffer.length,
            bufferedBytes: this.writeBufferBytes,
            droppedEvents: this.bufferOverflowCount,
            timestamp: new Date().toISOString(),
          }),
        );
        this.bufferOverflowCount = 0;
        this.lastBufferOverflowWarnAt = now;
      }
      return false;
    }
    this.writeBuffer.push(event);
    this.writeBufferBytes += bytes;
    return true;
  }

  enqueueWrite(data: string): Promise<void> {
    return this.enqueueFlight({ data, stolen: false, started: false });
  }

  private enqueueFlight(flight: InFlightBatch): Promise<void> {
    const write = this.writeChain.then(async () => {
      if (flight.stolen) return;
      flight.started = true;
      if (flight.stolen) return;
      try {
        await this.opts.getHandle().appendFile(flight.data, 'utf8');
      } catch (err: unknown) {
        if (isClosedHandleError(err)) {
          const reloaded = await fsp.open(this.opts.filePath, 'a', 0o600);
          this.opts.setHandle(reloaded);
          return await reloaded.appendFile(flight.data, 'utf8');
        }
        throw err;
      }
    });
    this.writeChain = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }

  scheduleFlush(isClosed = false): void {
    // Timer-driven flushes intentionally run page-cache-only (no datasync):
    // by the time the 500ms window elapses the batch holds only non-critical
    // events (critical types flush immediately with datasync), so bytes are
    // SIGKILL-durable but not power-loss durable. That tradeoff keeps fsync
    // I/O off the hot path — power-loss durability is reserved for the
    // critical immediate routes.
    if (this.flushTimer || isClosed) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushBuffer(isClosed).catch(() => {});
    }, SessionWriteBuffer.FLUSH_INTERVAL_MS);
  }

  cancelTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  async flushBuffer(isClosed = false, opts: FlushBufferOptions = {}): Promise<void> {
    if (this.flushPromise) {
      const joined = this.flushPromise;
      // A join can land after the in-flight loop has already drained its
      // snapshot. Events pushed in that window (including critical ones
      // that cancelled the timer) would otherwise sit unflushed. Always
      // continue if the buffer is still dirty once the owner settles.
      const continueIfDirty = (): Promise<void> => {
        if (this.writeBuffer.length === 0) return Promise.resolve();
        return this.flushBuffer(isClosed, opts);
      };
      if (opts.datasync === true) {
        // Durability upgrade on join: the in-flight timer batch may already
        // be written page-cache-only, so sync the handle once it settles
        // (merging into the running loop cannot retroactively sync bytes
        // flushed before the upgrade arrived).
        return joined.then(() =>
          this.opts
            .getHandle()
            .datasync()
            .catch(() => undefined)
            .then(continueIfDirty),
        );
      }
      return joined.then(continueIfDirty);
    }
    const flush = (async () => {
      while (this.writeBuffer.length > 0) await this.flushBufferOnce(isClosed, opts);
    })().finally(() => {
      if (this.flushPromise === flush) this.flushPromise = null;
    });
    this.flushPromise = flush;
    return flush;
  }

  private async flushBufferOnce(isClosed: boolean, opts?: FlushBufferOptions): Promise<void> {
    if (this.writeBuffer.length === 0) return;
    const events = this.writeBuffer;
    const eventCount = events.length;
    const eventBytes = this.writeBufferBytes;
    const batch = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    this.writeBuffer = [];
    this.writeBufferBytes = 0;
    const flight: InFlightBatch = { data: batch, stolen: false, started: false };
    this.inFlight = flight;
    const t0 = Date.now();
    let outcome: 'success' | 'failure' = 'success';
    let errorMsg: string | undefined;
    try {
      await this.enqueueFlight(flight);
      if (flight.stolen) {
        return;
      }
      // Disk-durability upgrade when the caller marks this flush critical:
      // bytes are already on disk at this point, so a datasync failure is
      // best-effort — page-cache durability still holds for SIGKILL, and the
      // next flush retries the sync.
      if (opts?.datasync === true) {
        await this.opts
          .getHandle()
          .datasync()
          .catch(() => undefined);
      }
    } catch (err) {
      if (flight.stolen) return;
      outcome = 'failure';
      errorMsg = toErrorMessage(err);
      const newer = this.writeBuffer;
      this.writeBuffer = events;
      this.writeBufferBytes = eventBytes;
      for (const newerEvent of newer) this.push(newerEvent);
      this.appendFailCount += eventCount;
      const now = Date.now();
      if (now - this.lastAppendWarnAt > 5000) {
        const suppressed = this.appendFailCount - 1;
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'session.flush_failed',
            sessionId: this.opts.sessionId,
            message: toErrorMessage(err),
            ...(suppressed > 0 ? { suppressed } : {}),
            timestamp: new Date().toISOString(),
          }),
        );
        this.lastAppendWarnAt = now;
        this.appendFailCount = 0;
      }
      if (!isClosed) this.scheduleFlush(isClosed);
      throw err;
    } finally {
      this.opts.events?.emit('storage.write', {
        sessionId: this.opts.sessionId,
        store: 'session',
        filePath: this.opts.filePath,
        operation: 'flush',
        outcome,
        durationMs: Date.now() - t0,
        ...(errorMsg !== undefined ? { error: errorMsg } : {}),
        ...(eventCount !== undefined ? { eventCount } : {}),
        ...(this.opts.getTraceId?.() ? { traceId: this.opts.getTraceId()! } : {}),
      });
      if (this.inFlight === flight) this.inFlight = null;
    }
  }

  async drainWriteChain(): Promise<void> {
    await this.writeChain;
  }

  async drainFlushPromise(): Promise<void> {
    await this.flushPromise?.catch(() => undefined);
  }

  /**
   * Last-gasp synchronous append (SIGKILL/SIGTERM traps, `process.on('exit')`).
   *
   * If an async append is actively writing when teardown arrives, flushSync
   * must not open a second append descriptor and race it. It defers with a
   * structured `session.flush_sync_deferred` warning, leaving the buffer
   * untouched for the already-running flush loop to drain if the process
   * survives.
   *
   * Failure contract: nothing is discarded before the write is known to have
   * landed. Buffered events stay in `writeBuffer` — it is cleared only after
   * `fsyncSync` returns — and a stolen in-flight batch is handed back to the
   * async write chain, so a survivable failure (EACCES, ENOSPC, EMFILE) loses
   * nothing. Failure is never silent: a structured `session.flush_sync_failed`
   * warning names exactly what was still pending, which is what SIGKILL-trap
   * tests assert against.
   */
  flushSync(): void {
    if (!this.opts.filePath) return;
    this.cancelTimer();
    const chunks: string[] = [];
    const flight = this.inFlight;
    // Steal a batch that is queued but has not started writing so this
    // sync append is the only writer and preserves order (in-flight first).
    // `started` cannot flip while this synchronous method runs (it is set in a
    // microtask), so `stole` stays an accurate record for the rollback below.
    const stole = flight !== null && !flight.started && !flight.stolen;
    if (flight?.started && !flight.stolen) {
      // A started async append owns the file until it settles, and a
      // synchronous teardown function cannot wait for it: waiting requires
      // event-loop progress, which cannot happen while this call blocks the
      // main thread. Deferring keeps the write chain the single serializer —
      // a surviving process drains the buffer in order; the durable
      // teardown contract is `await drainWriteChain()` before exit, not a
      // sync spin here.
      console.warn(
        JSON.stringify({
          level: 'error',
          event: 'session.flush_sync_deferred',
          sessionId: this.opts.sessionId,
          filePath: this.opts.filePath,
          message:
            'in-flight async append already started; sync append deferred to avoid write race',
          pendingEvents: this.writeBuffer.length,
          pendingBytes: this.writeBufferBytes,
          timestamp: new Date().toISOString(),
        }),
      );
      return;
    }
    if (stole && flight) {
      flight.stolen = true;
      chunks.push(flight.data);
    }
    const events = this.writeBuffer;
    if (events.length > 0) {
      chunks.push(events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    }
    if (chunks.length === 0) return;
    let fd: number | undefined;
    try {
      fd = openSync(this.opts.filePath, 'a');
      writeSync(fd, chunks.join(''), null, 'utf8');
      fsyncSync(fd);
      if (this.writeBuffer === events) {
        this.writeBuffer = [];
        this.writeBufferBytes = 0;
      }
    } catch (err) {
      // Give the stolen batch back to the async chain: if the process survives
      // this failure, `enqueueFlight` still writes it. `writeBuffer` was never
      // swapped, so the buffered events need no restoration — they are already
      // where the next flush looks. Report the window so a dying process is
      // not silent about what it could not persist.
      if (stole && flight) flight.stolen = false;
      console.warn(
        JSON.stringify({
          level: 'error',
          event: 'session.flush_sync_failed',
          sessionId: this.opts.sessionId,
          filePath: this.opts.filePath,
          message: toErrorMessage(err),
          pendingEvents: events.length,
          pendingBytes: this.writeBufferBytes,
          hadInFlightBatch: stole,
          timestamp: new Date().toISOString(),
        }),
      );
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // best-effort
        }
      }
    }
  }

  clear(): void {
    this.cancelTimer();
    this.writeBuffer = [];
    this.writeBufferBytes = 0;
    this.appendFailCount = 0;
    this.lastAppendWarnAt = 0;
    this.bufferOverflowCount = 0;
    this.lastBufferOverflowWarnAt = 0;
  }

  shouldFlushNow(): boolean {
    return (
      this.writeBuffer.length >= SessionWriteBuffer.FLUSH_SIZE ||
      this.writeBufferBytes >= SessionWriteBuffer.WRITE_BUFFER_MAX_BYTES
    );
  }
}
