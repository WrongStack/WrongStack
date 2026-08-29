import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { SecretScrubber } from '../types/secret-scrubber.js';
import type {
  FileSnapshot,
  SessionEvent,
  SessionMetadata,
  SessionSummary,
  SessionWriter,
  WorkspaceCheckpointRef,
} from '../types/session.js';
import { atomicWrite, withFileLock } from '../utils/atomic-write.js';
import { toErrorMessage } from '../utils/index.js';
import type { EventBus } from './event-bus-port.js';
import type { SessionCheckpointCas } from './session-checkpoint-cas.js';
import { SessionSummaryTracker } from './session-summary-tracker.js';
import { SessionWriteBuffer } from './session-write-buffer.js';
import { scrubSessionWriterEvent } from './session-writer-scrubber.js';
import {
  findSessionCheckpointTruncatePlan,
  rewriteSessionToCheckpoint,
} from './session-writer-truncate.js';

/** Node has used more than one code for operations on an already-closed FileHandle. */
function isClosedHandleError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EBADF' || code === 'ERR_CLOSED_RESOURCE' || code === 'ERR_INVALID_HANDLE';
}

/**
 * Event types that must reach disk without waiting for FLUSH_SIZE /
 * FLUSH_INTERVAL_MS. Losing one of these to a SIGKILL makes a resumed
 * transcript lie about what actually happened: the user's prompt or the
 * assistant's response vanishes, or a dangling marker hides crash state
 * from recovery. Everything else keeps riding the batched buffer.
 */
const CRITICAL_EVENT_TYPES: ReadonlySet<SessionEvent['type']> = new Set([
  'user_input',
  'llm_response',
  'checkpoint',
  'in_flight_start',
  'in_flight_end',
]);

function isCriticalEvent(event: SessionEvent): boolean {
  return CRITICAL_EVENT_TYPES.has(event.type);
}

/** Default throttle for mid-session metadata checkpoints (sidecar + index refresh). */
const METADATA_CHECKPOINT_INTERVAL_MS = 10_000;

/**
 * Append-mode JSONL session writer with batched writes, write serialization,
 * and enriched summary tracking.
 *
 * Extracted from session-store.ts to keep each module focused: this class
 * owns the per-session write path (append/flush/close/checkpoint/truncate),
 * while `DefaultSessionStore` owns the store-level read/list/index/delete path.
 */
export class FileSessionWriter implements SessionWriter {
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private manifestFile: string;
  private readonly summaryTracker: SessionSummaryTracker;
  private readonly buffer: SessionWriteBuffer;
  private readonly filePath: string;
  get transcriptPath(): string | undefined {
    return this.filePath || undefined;
  }
  /**
   * Lazy session_start/session_resumed init, shared by all appenders.
   * A single promise (not a boolean) so a second append racing the first
   * can't push its event into the buffer BEFORE the first append's event —
   * every appender awaits the same init and resumes in FIFO call order.
   */
  private initPromise: Promise<void> | null = null;
  private ensureInit(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.writeSessionStartLazy();
    return this.initPromise;
  }
  private readonly resumed: boolean;
  private readonly lifecyclePreambleTs: string;
  private readonly secretScrubber?: SecretScrubber | undefined;
  private readonly checkpointCas?: SessionCheckpointCas | undefined;
  /** Mutable slot for onAppend callback — constructor opts seed it, setOnAppend replaces it. */
  private _onAppend: ((event: SessionEvent) => void) | undefined;
  /** Implements SessionWriter.onAppend — public getter/setter for direct property access. */
  get onAppend(): ((event: SessionEvent) => void) | undefined {
    return this._onAppend;
  }
  set onAppend(cb: ((event: SessionEvent) => void) | undefined) {
    this._onAppend = cb;
  }
  /** Mutable slot for onAppendBatch callback. */
  private _onAppendBatch: ((events: SessionEvent[]) => void) | undefined;
  /** Implements SessionWriter.onAppendBatch — public getter/setter for direct property access. */
  get onAppendBatch(): ((events: SessionEvent[]) => void) | undefined {
    return this._onAppendBatch;
  }
  set onAppendBatch(cb: ((events: SessionEvent[]) => void) | undefined) {
    this._onAppendBatch = cb;
  }
  private readonly onCloseCb?: ((summary: SessionSummary) => void | Promise<void>) | undefined;
  /** Mid-session metadata checkpoint throttle. 0 disables checkpointing. */
  private readonly metadataCheckpointMs: number;
  /** One-shot guard for the "interval set but no sink" warning below. */
  private _checkpointNoSinkWarned = false;
  private readonly onMetadataCheckpointCb?:
    | ((summary: SessionSummary) => void | Promise<void>)
    | undefined;
  /** Set whenever summary counters changed since the last metadata checkpoint. */
  private metadataDirty = false;
  private metadataTimer: ReturnType<typeof setTimeout> | null = null;
  private metadataCheckpointInFlight: Promise<void> | null = null;
  /** Implements SessionWriter.traceId — propagated from ContextInit.traceId. */
  traceId: string | undefined;

  /**
   * Set or replace the onAppend callback. Used by telemetry bridges that
   * receive the writer as an already-constructed dependency.
   */
  setOnAppend(cb: ((event: SessionEvent) => void) | undefined): void {
    this._onAppend = cb;
  }

  /**
   * Set or replace the onAppendBatch callback.
   */
  setOnAppendBatch(cb: ((events: SessionEvent[]) => void) | undefined): void {
    this._onAppendBatch = cb;
  }

  private pendingFileSnapshots: Array<{
    path: string;
    action: 'created' | 'modified' | 'deleted';
    before: string | null;
    after: string | null;
  }> = [];
  private pendingFileSnapshotBytes = 0;
  private static readonly PENDING_FILE_SNAPSHOT_MAX_ENTRIES = 256;
  private static readonly PENDING_FILE_SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;
  /** Prompt whose tool work is currently executing. Set by writeCheckpoint. */
  private activePromptIndex: number | null = null;

  /**
   * Buffer an event from a synchronous Context callback. ensureInit() starts
   * by pushing the lifecycle preamble synchronously, so session_start always
   * precedes observations even though these callbacks cannot await append().
   */
  private bufferSynchronousEvent(event: SessionEvent): void {
    if (this.closed) return;
    void this.ensureInit();
    // Keep this path equivalent to append(): synchronous callbacks must not
    // bypass scrubbing merely because they cannot await the writer.
    const appendEvent = scrubSessionWriterEvent(event, this.secretScrubber);
    this.summaryTracker.observe(appendEvent);
    this.metadataDirty = true;
    this.scheduleMetadataCheckpoint();
    // Fire the onAppend callback so synchronous observations reach the HQ
    // bridge without a disk read-back. The scrubbed event is pushed to the
    // JSONL buffer so secrets never persist at rest, matching append().
    try {
      this._onAppend?.(appendEvent);
    } catch {
      /* best-effort */
    }
    const critical = isCriticalEvent(appendEvent);
    if (!this.buffer.push(appendEvent)) {
      // Buffer rejected the event (overflow). Drain what is there and
      // re-push; a CRITICAL event must not wait out the 500ms window just
      // because its first push lost the race against a full buffer.
      this.buffer.cancelTimer();
      void this.buffer
        .flushBuffer(this.closed, { datasync: true })
        .catch(() => undefined)
        .then(() => {
          if (this.buffer.push(appendEvent)) {
            if (!critical) return;
            this.buffer.cancelTimer();
            void this.buffer.flushBuffer(this.closed, { datasync: true }).catch(() => undefined);
            return;
          }
          // Buffer refilled faster than we could reclaim space: write the
          // CRITICAL event through the serialized chain directly rather than
          // dropping it (enqueueWrite preserves ordering; appendEvent is
          // already scrubbed above).
          void this.buffer
            .drainWriteChain()
            .then(() => this.buffer.enqueueWrite(`${JSON.stringify(appendEvent)}\n`))
            .then(() => {
              if (!critical) return;
              return this.handle.datasync().catch(() => undefined);
            })
            .catch((err) => {
              console.warn(
                JSON.stringify({
                  level: 'error',
                  event: 'session.sync_journal_write_failed',
                  sessionId: this.id,
                  eventType: appendEvent.type,
                  message: toErrorMessage(err),
                  timestamp: new Date().toISOString(),
                }),
              );
            });
        });
    } else if (critical || this.buffer.shouldFlushNow()) {
      this.buffer.cancelTimer();
      void this.buffer.flushBuffer(this.closed, { datasync: true }).catch(() => {
        // Retained at the head of writeBuffer for the boundary retry.
      });
    } else {
      this.buffer.scheduleFlush(this.closed);
    }
  }

  recordFileChange(input: {
    path: string;
    action: 'created' | 'modified' | 'deleted';
    before: string | null;
    after: string | null;
  }): void {
    if (this.closed) return;
    if (this.activePromptIndex === null) {
      // Compatibility path for embedders that mutate before their first
      // checkpoint. writeCheckpoint()/close() will attach these changes to the
      // first available prompt index.
      const bytes =
        Buffer.byteLength(input.path, 'utf8') +
        (input.before ? Buffer.byteLength(input.before, 'utf8') : 0) +
        (input.after ? Buffer.byteLength(input.after, 'utf8') : 0);
      if (
        this.pendingFileSnapshots.length >= FileSessionWriter.PENDING_FILE_SNAPSHOT_MAX_ENTRIES ||
        bytes > FileSessionWriter.PENDING_FILE_SNAPSHOT_MAX_BYTES ||
        this.pendingFileSnapshotBytes + bytes > FileSessionWriter.PENDING_FILE_SNAPSHOT_MAX_BYTES
      ) {
        console.warn(
          JSON.stringify({
            level: 'error',
            event: 'session.file_snapshot_buffer_overflow',
            sessionId: this.id,
            bufferedFiles: this.pendingFileSnapshots.length,
            bufferedBytes: this.pendingFileSnapshotBytes,
            timestamp: new Date().toISOString(),
          }),
        );
        return;
      }
      this.pendingFileSnapshots.push(input);
      this.pendingFileSnapshotBytes += bytes;
      return;
    }

    // This method is intentionally synchronous because file tools call it
    // immediately after their atomic mutation. Put the reconstruct event in
    // the writer buffer before the tool returns; agent-tools flushes the buffer
    // together with the matching tool_result boundary.
    const event: SessionEvent = {
      type: 'file_snapshot',
      ts: new Date().toISOString(),
      promptIndex: this.activePromptIndex,
      files: [input],
    };
    this.bufferSynchronousEvent(event);
  }

  recordFileObservation(input: {
    path: string;
    hash: string;
    mtimeMs: number;
    source: 'user' | 'write';
  }): void {
    if (!input.path || !/^[a-f\d]{64}$/i.test(input.hash) || !Number.isFinite(input.mtimeMs))
      return;
    this.bufferSynchronousEvent({
      type: 'file_observation',
      ts: new Date().toISOString(),
      path: input.path,
      hash: input.hash.toLowerCase(),
      mtimeMs: input.mtimeMs,
      source: input.source,
    });
  }

  recordSideEffect(input: {
    toolUseId: string;
    toolName: string;
    input: Record<string, unknown>;
    outcome?: string | undefined;
    risk: 'fs.write' | 'shell' | 'package' | 'network' | 'config';
  }): void {
    // Fire-and-forget — side-effect recording must never block tool execution.
    this.append({
      type: 'side_effect',
      ts: new Date().toISOString(),
      toolUseId: input.toolUseId,
      toolName: input.toolName,
      input: input.input,
      outcome: input.outcome,
      risk: input.risk,
    }).catch(() => {
      /* best-effort */
    });
  }

  constructor(
    public readonly id: string,
    private handle: fsp.FileHandle,
    public readonly startedAt: string,
    private readonly meta: Omit<SessionMetadata, 'startedAt'>,
    private readonly events?: EventBus | undefined,
    opts: {
      resumed?: boolean | undefined;
      dir?: string | undefined;
      filePath?: string | undefined;
      secretScrubber?: SecretScrubber | undefined;
      checkpointCas?: SessionCheckpointCas | undefined;
      /** Called synchronously after each event is scrubbed + observed, before it enters the write buffer. */
      onAppend?: ((event: SessionEvent) => void) | undefined;
      /** Batch variant called after all events in the batch have been scrubbed + observed. */
      onAppendBatch?: ((events: SessionEvent[]) => void) | undefined;
      /** Existing cumulative summary when reopening a persisted session. */
      initialSummary?: SessionSummary | undefined;
      /** Called on close() with the finalized summary for index/sidecar writes. */
      onClose?: ((summary: SessionSummary) => void | Promise<void>) | undefined;
      /** Reconcile an explicit name changed while this writer remained open. */
      resolveName?: (() => Promise<Pick<SessionSummary, 'name'> | null>) | undefined;
      /**
       * Mid-session metadata checkpoint throttle (ms). While the session is
       * live and dirty, the summary sidecar + index row are refreshed at most
       * this often, so a SIGKILLed process still leaves accurate listing
       * metadata instead of its create-time stub. 0 disables checkpointing —
       * killed sessions then stay visible through the store's list()-union
       * scan, but only with analyzer-derived metadata rather than tracked
       * counters. Default 10_000.
       */
      metadataCheckpointMs?: number | undefined;
      /**
       * Persists a mid-session summary snapshot (store-level index row /
       * catalog upsert). The sidecar file itself is written by the writer
       * under its manifest lock; this callback covers the index side.
       */
      onMetadataCheckpoint?: ((summary: SessionSummary) => void | Promise<void>) | undefined;
    } = {},
    traceId?: string | undefined,
  ) {
    this.resumed = opts.resumed ?? false;
    this.lifecyclePreambleTs = this.resumed ? new Date().toISOString() : startedAt;
    // id already contains a date-prefix shard (e.g. "2026-06-06/sess_<ULID>").
    // opts.dir is the shard directory — join with basename so the manifest
    // lives next to the JSONL file instead of creating a double-nested path.
    this.manifestFile = opts.dir ? path.join(opts.dir, `${path.basename(id)}.summary.json`) : '';
    this.filePath = opts.filePath ?? '';
    this.secretScrubber = opts.secretScrubber;
    this.checkpointCas = opts.checkpointCas;
    this._onAppend = opts.onAppend;
    this._onAppendBatch = opts.onAppendBatch;
    this.onCloseCb = opts.onClose;
    this.onMetadataCheckpointCb = opts.onMetadataCheckpoint;
    this.metadataCheckpointMs = opts.metadataCheckpointMs ?? METADATA_CHECKPOINT_INTERVAL_MS;
    this.summaryTracker = new SessionSummaryTracker({
      id,
      startedAt,
      meta,
      resumed: this.resumed,
      initialSummary: opts.initialSummary,
      resolveName: opts.resolveName,
    });
    this.buffer = new SessionWriteBuffer({
      sessionId: id,
      filePath: this.filePath,
      getHandle: () => this.handle,
      setHandle: (h) => {
        this.handle = h;
      },
      events: this.events,
      getTraceId: () => this.traceId,
    });
    // Propagated from ContextInit.traceId via SessionWriter.traceId so that
    // storage events carry the run-level trace ID without needing a Context
    // handle in every storage operation.
    this.traceId = traceId;
  }

  get pendingToolUses(): string[] {
    return this.summaryTracker.pendingToolUses;
  }

  private async writeSessionStartLazy(): Promise<void> {
    // Keep the lifecycle preamble in the same retryable buffer as every other
    // reconstruct event. Writing it through a separate one-shot append meant
    // an ENOSPC/transient handle failure could permanently lose session_start
    // while later events survived, leaving an unidentifiable transcript.
    this.buffer.push({
      type: this.resumed ? 'session_resumed' : 'session_start',
      ts: this.lifecyclePreambleTs,
      id: this.id,
      model: this.meta.model ?? 'unknown',
      provider: this.meta.provider ?? 'unknown',
    });
  }

  /**
   * Arm the mid-session metadata checkpoint timer if it is not already armed.
   * Called after every observed event; the timer itself is unref'd so an idle
   * session never keeps the process alive for a cosmetic sidecar refresh.
   */
  private scheduleMetadataCheckpoint(): void {
    if (this.closed || this.metadataTimer) return;
    if (this.metadataCheckpointMs <= 0) return;
    if (!this.onMetadataCheckpointCb && !this.manifestFile) {
      // One-time diagnostic: an interval was configured but nothing can
      // consume checkpoints, so arming a timer would be a silent no-op
      // (chimera HIGH — foot-gun where callers believe durability exists).
      if (!this._checkpointNoSinkWarned) {
        this._checkpointNoSinkWarned = true;
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'session.metadata_checkpoint_no_sink',
            sessionId: this.id,
            message:
              'metadataCheckpointMs set but neither onMetadataCheckpoint nor manifestFile configured; mid-session checkpoints disabled.',
            timestamp: new Date().toISOString(),
          }),
        );
      }
      return;
    }
    this.metadataTimer = setTimeout(() => {
      this.metadataTimer = null;
      void this.runMetadataCheckpoint();
    }, this.metadataCheckpointMs);
    this.metadataTimer.unref?.();
  }

  /**
   * Persist a mid-session summary snapshot: the `.summary.json` sidecar under
   * the manifest lock, then the store-level index row / catalog upsert via
   * `onMetadataCheckpoint`. Runs at most once per throttle interval and only
   * when summary counters changed since the last checkpoint; a failed
   * checkpoint stays dirty and retries on the next armed tick.
   */
  private runMetadataCheckpoint(): Promise<void> {
    if (this.closed || !this.metadataDirty) return Promise.resolve();
    if (this.metadataCheckpointInFlight) return this.metadataCheckpointInFlight;
    // Snapshot BEFORE any await so events observed during the write land in
    // the NEXT checkpoint instead of racing this one. snapshot() materializes
    // every live counter — currentSummary alone leaves counters stale until
    // finalize().
    // Resumed sessions seed the tracker from the PRIOR run's manifest, so
    // snapshot() would carry stale endedAt/outcome:'completed' into live
    // sidecar/catalog rows — making a running or SIGKILLed session look
    // cleanly ended with a pre-resume timestamp. Strip terminal fields here;
    // close-time finalize() re-stamps the real values.
    const {
      endedAt: _priorEndedAt,
      outcome: _priorOutcome,
      ...snapshot
    } = this.summaryTracker.snapshot();
    const run = (async () => {
      const t0 = Date.now();
      let outcome: 'success' | 'failure' = 'success';
      let errorMsg: string | undefined;
      try {
        if (this.manifestFile) {
          await withFileLock(this.manifestFile, async () => {
            await atomicWrite(this.manifestFile, JSON.stringify(snapshot), { mode: 0o600 });
          });
        }
        // Sidecar reached disk: clear dirty only NOW. A SIGKILL during the
        // write leaves the flag true so the next observation re-arms instead
        // of silently losing the counter mutation.
        this.metadataDirty = false;
        await this.onMetadataCheckpointCb?.(snapshot);
        // Events observed while persisting re-arm the next tick.
        if (this.metadataDirty && !this.closed) this.scheduleMetadataCheckpoint();
      } catch (err) {
        outcome = 'failure';
        errorMsg = toErrorMessage(err);
        this.metadataDirty = true;
        this.scheduleMetadataCheckpoint();
      } finally {
        this.metadataCheckpointInFlight = null;
        this.events?.emit('storage.write', {
          sessionId: this.id,
          store: 'session',
          filePath: this.manifestFile || this.filePath,
          operation: 'metadata_checkpoint',
          outcome,
          durationMs: Date.now() - t0,
          ...(errorMsg !== undefined ? { error: errorMsg } : {}),
          ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
        });
      }
    })();
    this.metadataCheckpointInFlight = run;
    return run;
  }

  async append(event: SessionEvent): Promise<void> {
    if (this.closed) return;
    await this.ensureInit();
    // Scrub before observing (the summary title is derived from user_input
    // content) and before buffering, so neither the JSONL nor the sidecar
    // ever holds a cleartext secret.
    const scrubbed = scrubSessionWriterEvent(event, this.secretScrubber);
    // observe MUST run synchronously here — the summary counters
    // (toolCallCount, tokenIn/Out, outcome) drive the .summary.json sidecar
    // and the session index. Deferring observation to flush time would leave
    // the summary stale if close() fires before the next timer tick.
    this.summaryTracker.observe(scrubbed);
    this.metadataDirty = true;
    this.scheduleMetadataCheckpoint();
    // Fire the onAppend callback with the scrubbed event so the HQ bridge
    // can stream it without reading it back from disk. Synchronous and
    // best-effort — the callback must not throw.
    try {
      this._onAppend?.(scrubbed);
    } catch {
      /* best-effort */
    }
    let pushed = this.buffer.push(scrubbed);
    if (!pushed) {
      this.buffer.cancelTimer();
      await this.buffer.flushBuffer(this.closed, { datasync: true }).catch(() => undefined);
      pushed = this.buffer.push(scrubbed);
      if (!pushed) {
        // Serialized direct-write fallback (mirrors bufferSynchronousEvent /
        // appendBatch): never silently drop an event after an overflow flush.
        // Critical events sync here too — the empty-buffer flush below cannot
        // datasync bytes that bypassed the buffer (>16MiB push failure).
        await this.buffer
          .drainWriteChain()
          .then(() => this.buffer.enqueueWrite(`${JSON.stringify(scrubbed)}\n`))
          .then(() => {
            if (!isCriticalEvent(scrubbed)) return;
            return this.handle.datasync().catch(() => undefined);
          });
      }
    }

    if (isCriticalEvent(scrubbed) || this.buffer.shouldFlushNow()) {
      // Critical events (user_input/llm_response/checkpoint/in_flight_*) and
      // buffer-full both flush immediately. Cancel any pending timer so we
      // don't double-flush on the next tick.
      this.buffer.cancelTimer();
      await this.buffer.flushBuffer(this.closed, { datasync: true }).catch(() => {
        // append() is intentionally best-effort. The failed batch remains at
        // the front of writeBuffer; an explicit boundary flush can surface the
        // error while ordinary audit appends do not abort the agent loop.
      });
    } else {
      this.buffer.scheduleFlush(this.closed);
    }
  }

  async appendBatch(events: SessionEvent[]): Promise<void> {
    if (this.closed || events.length === 0) return;
    await this.ensureInit();
    const scrubbedBatch: SessionEvent[] = [];
    for (const event of events) {
      const scrubbed = scrubSessionWriterEvent(event, this.secretScrubber);
      this.summaryTracker.observe(scrubbed);
      // Fire the per-event callback so subscribers to onAppend (rather than
      // onAppendBatch) also receive batch events individually.
      try {
        this._onAppend?.(scrubbed);
      } catch {
        /* best-effort */
      }
      let pushed = this.buffer.push(scrubbed);
      if (!pushed) {
        this.buffer.cancelTimer();
        await this.buffer.flushBuffer(this.closed, { datasync: true }).catch(() => undefined);
        pushed = this.buffer.push(scrubbed);
        if (!pushed) {
          // Serialized direct-write fallback (mirrors bufferSynchronousEvent):
          // never silently drop an event after an overflow flush. Batch-level
          // critical handling below supplies datasync when applicable.
          await this.buffer
            .drainWriteChain()
            .then(() => this.buffer.enqueueWrite(`${JSON.stringify(scrubbed)}\n`))
            .then(() => {
              if (!isCriticalEvent(scrubbed)) return;
              return this.handle.datasync().catch(() => undefined);
            });
        }
      }
      scrubbedBatch.push(scrubbed);
    }
    if (scrubbedBatch.length > 0) {
      this.metadataDirty = true;
      this.scheduleMetadataCheckpoint();
    }
    // Fire the batch callback with all scrubbed events so the HQ bridge
    // can stream them without reading them back from disk.
    try {
      this._onAppendBatch?.(scrubbedBatch);
    } catch {
      /* best-effort */
    }
    // One critical event makes the whole batch durable immediately — flushing
    // only part of it would strand earlier events behind the 500ms timer.
    const hasCritical = scrubbedBatch.some(isCriticalEvent);
    if (hasCritical || this.buffer.shouldFlushNow()) {
      this.buffer.cancelTimer();
      await this.buffer.flushBuffer(this.closed, { datasync: true }).catch(() => {
        // Same best-effort append contract as append(); batch is retained.
      });
    } else {
      this.buffer.scheduleFlush(this.closed);
    }
  }

  /**
   * Flush buffered events to disk immediately. Critical events
   * (user_input, llm_response, checkpoint, in_flight_*) already flush
   * themselves inside append()/appendBatch(), so calling this matters for
   * non-critical tails that would otherwise sit in the in-memory buffer
   * for up to 500ms.
   *
   * Idempotent — cancels any pending timer, writes whatever has accumulated,
   * then asks the OS to synchronize the file data before resolving. Even an
   * empty-buffer flush synchronizes any earlier timer-driven append.
   */
  async flush(): Promise<void> {
    if (this.closed) return;
    this.buffer.cancelTimer();
    await this.buffer.flushBuffer(this.closed, { datasync: true });
    await this.buffer.drainWriteChain();
    try {
      await this.handle.datasync();
    } catch (err: unknown) {
      // Handle may be closed (e.g. after clearSession with no intervening
      // append). Reopen lazily so the handle is ready for the next write.
      if (isClosedHandleError(err)) {
        this.handle = await fsp.open(this.filePath, 'a', 0o600);
        return;
      }
      throw err;
    }
  }

  /**
   * Last-gasp synchronous drain for hard-exit paths (process.exit after
   * rapid Ctrl+C). The async write chain cannot be awaited when the process
   * is about to die, but whatever still sits in the in-memory buffer CAN be
   * saved with a blocking append. A failed sync append leaves the buffer
   * intact so a subsequent close()/flush() can retry. An in-flight async
   * write may still be cut off by a hard exit.
   */
  flushSync(): void {
    this.buffer.flushSync();
  }

  async close(): Promise<void> {
    // Idempotent AND awaitable: concurrent/repeat callers share the same
    // promise, so nobody proceeds (e.g. to tear down the session directory)
    // while the first close is still flushing.
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.doClose().catch(async (err) => {
      // Reconcile mid-session checkpointing: an armed timer scheduled against
      // the closing state must not survive as a phantom. Any in-flight
      // checkpoint is legitimate (the writer is still open after this
      // rollback) and finishes on its own.
      if (this.metadataTimer) {
        clearTimeout(this.metadataTimer);
        this.metadataTimer = null;
      }
      await this.metadataCheckpointInFlight?.catch(() => undefined);
      // A failed durable drain must not permanently brick the writer. Keep the
      // handle open and allow the timer or a later close() call to retry.
      this.closed = false;
      this.closePromise = null;
      if (this.buffer.length > 0) this.buffer.scheduleFlush(this.closed);
      // Re-arm metadata checkpointing ONLY when counters are actually dirty:
      // an unconditional arm would leave an idle session with a hot 10s timer
      // until the next unrelated event (chimera MED).
      if (this.metadataDirty) this.scheduleMetadataCheckpoint();
      throw err;
    });
    return this.closePromise;
  }

  private async doClose(): Promise<void> {
    // Stop mid-session metadata checkpointing FIRST so nothing re-arms while
    // we materialize. Pending file snapshots still require an OPEN writer —
    // writeFileSnapshot delegates to append(), whose closed guard would
    // silently drop them — so `closed` flips only after they are written,
    // followed by a second metadata stop for anything the snapshot appends
    // re-armed.
    if (this.metadataTimer) {
      clearTimeout(this.metadataTimer);
      this.metadataTimer = null;
    }
    await this.metadataCheckpointInFlight?.catch(() => undefined);
    // Session creation opens the transcript eagerly, but its lifecycle
    // preamble is lazy. Materialize it even for an otherwise idle session so
    // a valid JSONL never becomes a zero-byte/headerless transcript.
    await this.ensureInit();
    if (this.pendingFileSnapshots.length > 0) {
      await this.writeFileSnapshot(this.activePromptIndex ?? 0, [...this.pendingFileSnapshots]);
      this.pendingFileSnapshots = [];
      this.pendingFileSnapshotBytes = 0;
    }
    // Flip closed only after every write that requires an open writer.
    this.closed = true;
    if (this.metadataTimer) {
      clearTimeout(this.metadataTimer);
      this.metadataTimer = null;
    }
    await this.metadataCheckpointInFlight?.catch(() => undefined);
    // Flush any buffered events before finalizing. The summary counters
    // (toolCallCount, tokenIn/Out, outcome) are already up to date because
    // observeForSummary runs synchronously on every append, but the JSONL
    // must have all events on disk before we write the .summary.json sidecar.
    this.buffer.cancelTimer();
    await this.buffer.flushBuffer(this.closed, { datasync: true });
    // Drain any write enqueued outside flushBuffer (e.g. the lazy
    // session_start record) before the handle is closed.
    await this.buffer.drainWriteChain();
    try {
      await this.handle.datasync();
    } catch (err: unknown) {
      // Handle may already be closed (e.g. clearSession closed it but no
      // append reopened). Best-effort: the fd is still valid for close().
      if (!isClosedHandleError(err)) throw err;
    }

    const summary = await this.summaryTracker.finalize();

    const manifestT0 = Date.now();
    let manifestOutcome: 'success' | 'failure' = 'success';
    let manifestError: string | undefined;
    const idxT0 = Date.now();
    let idxOutcome: 'success' | 'failure' = 'success';
    let idxError: string | undefined;
    const persistSummary = async (): Promise<void> => {
      if (this.manifestFile) {
        try {
          await atomicWrite(this.manifestFile, JSON.stringify(summary), { mode: 0o600 });
        } catch (err) {
          manifestOutcome = 'failure';
          manifestError = toErrorMessage(err);
        }
      }
      try {
        await this.onCloseCb?.(summary);
        /* v8 ignore start -- best-effort: appendToIndex swallows its own errors */
      } catch (err) {
        idxOutcome = 'failure';
        idxError = toErrorMessage(err);
        /* v8 ignore stop */
      }
    };
    if (this.manifestFile) await withFileLock(this.manifestFile, persistSummary);
    else await persistSummary();

    if (this.manifestFile) {
      this.events?.emit('storage.write', {
        sessionId: this.id,
        store: 'session',
        filePath: this.manifestFile,
        operation: 'close',
        outcome: manifestOutcome,
        durationMs: Date.now() - manifestT0,
        ...(manifestError !== undefined ? { error: manifestError } : {}),
        ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
      });
    }
    this.events?.emit('storage.write', {
      sessionId: summary.id,
      store: 'session',
      filePath: this.filePath,
      operation: 'index_append',
      outcome: idxOutcome,
      durationMs: Date.now() - idxT0,
      ...(idxError !== undefined ? { error: idxError } : {}),
      ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
    });
    try {
      await this.handle.close();
    } catch {
      // ignore
    }
  }

  async writeCheckpoint(promptIndex: number, promptPreview: string): Promise<void> {
    const fileCount = this.pendingFileSnapshots.length;
    if (fileCount > 0) {
      await this.writeFileSnapshot(promptIndex, [...this.pendingFileSnapshots]);
      this.pendingFileSnapshots = [];
      this.pendingFileSnapshotBytes = 0;
    }
    let workspaceCheckpoint: WorkspaceCheckpointRef | undefined;
    try {
      workspaceCheckpoint = await this.checkpointCas?.capture(this.id, promptIndex);
    } catch (err) {
      // Conversation checkpoints remain usable when Git/CAS capture is unavailable; missing
      // workspaceCheckpoint makes the reduced guarantee explicit to fork/materialization callers.
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'session.workspace_checkpoint_capture_failed',
          sessionId: this.id,
          promptIndex,
          message: toErrorMessage(err),
          timestamp: new Date().toISOString(),
        }),
      );
    }
    await this.append({
      type: 'checkpoint',
      ts: new Date().toISOString(),
      promptIndex,
      promptPreview,
      ...(workspaceCheckpoint ? { workspaceCheckpoint } : {}),
    });
    this.activePromptIndex = promptIndex;
    this.events?.emit('checkpoint.written', {
      sessionId: this.id,
      promptIndex,
      promptPreview,
      ts: new Date().toISOString(),
      fileCount,
      ...(workspaceCheckpoint ? { workspaceCheckpoint } : {}),
    });
  }

  async writeFileSnapshot(promptIndex: number, files: FileSnapshot[]): Promise<void> {
    await this.append({
      type: 'file_snapshot',
      ts: new Date().toISOString(),
      promptIndex,
      files,
    });
  }

  /**
   * Truncate the session file to the checkpoint with the given promptIndex,
   * removing all events that follow it. Uses a single-pass byte-offset scan
   * so post-checkpoint content is never read or parsed — O(1) memory instead
   * of O(N) JSON.parse calls over the full file.
   */
  async truncateToCheckpoint(
    targetPromptIndex: number,
    revertedFiles: readonly string[] = [],
  ): Promise<number> {
    /* v8 ignore next -- defensive: filePath is always set for a live writer */
    if (!this.filePath) return 0;

    // Flush buffered events to disk before reading — otherwise the in-memory
    // events that haven't hit the JSONL yet would be invisible to the
    // truncation logic and would be silently dropped by the rewrite.
    this.buffer.cancelTimer();
    await this.buffer.flushBuffer(this.closed, { datasync: true });
    // Drain the write chain so no in-flight write straddles the close/rename/reopen.
    await this.buffer.drainWriteChain();
    // Stop mid-session metadata checkpointing across the file rewrite: the
    // summary counters are recomputed from disk below, and an armed timer or
    // in-flight checkpoint could write pre-rewind state over them.
    if (this.metadataTimer) {
      clearTimeout(this.metadataTimer);
      this.metadataTimer = null;
    }
    await this.metadataCheckpointInFlight?.catch(() => undefined);

    const plan = await findSessionCheckpointTruncatePlan(this.filePath, targetPromptIndex).catch(
      (err) => {
        // Lookup failed: re-arm live checkpointing so dirty metadata is not
        // stranded until the next unrelated event.
        this.scheduleMetadataCheckpoint();
        throw err;
      },
    );
    if (!plan) {
      // No matching checkpoint: same re-arm obligation as the error path.
      this.scheduleMetadataCheckpoint();
      return 0;
    }

    // Windows EPERM fix: close the append-mode handle before replacing the
    // file. Windows rejects rename() when the destination still has an open
    // handle, even if that handle belongs to this process.
    await this.buffer.drainWriteChain();
    try {
      await this.handle.close();
    } catch {
      // Ignore — handle may already be closed (e.g. by clearSession).
      // Consistent with the doClose() best-effort pattern.
    }
    try {
      await rewriteSessionToCheckpoint(this.filePath, plan.checkpointByteOffset);
      // Re-open in append mode for continued use of this file.
      this.handle = await fsp.open(this.filePath, 'a', 0o600);
      /* v8 ignore start -- defensive: close/rename/reopen of a just-written temp file */
    } catch (err) {
      this.handle = await fsp.open(this.filePath, 'a', 0o600).catch(() => this.handle);
      // Re-arm live checkpointing so a failed rewrite does not strand dirty
      // metadata until the next unrelated event (mirrors the lookup / no-plan
      // exits above, which both re-arm before returning).
      this.scheduleMetadataCheckpoint();
      throw err;
    }
    /* v8 ignore stop */

    // The summary counters accumulate as events are observed and know nothing
    // about truncation, so without this `close()` would write a .summary.json —
    // and an _index.jsonl row, which list() reads — still counting the tool
    // calls, file changes and tokens of the work just rewound.
    await this.summaryTracker.recomputeFromDisk(this.filePath);

    const reverted = [...revertedFiles];
    await this.append({
      type: 'rewound',
      ts: new Date().toISOString(),
      toPromptIndex: targetPromptIndex,
      revertedFiles: reverted,
    });
    this.activePromptIndex = targetPromptIndex;

    this.events?.emit('session.rewound', {
      sessionId: this.id,
      toPromptIndex: targetPromptIndex,
      revertedFiles: reverted,
      removedEvents: plan.removedCount,
    });

    return plan.removedCount;
  }

  async clearSession(): Promise<void> {
    /* v8 ignore next -- defensive: filePath is always set for a live writer */
    if (!this.filePath) return;
    // Discard any buffered events — the caller is explicitly resetting the
    // session to a clean slate. Cancel the timer so it doesn't fire and
    // append stale events to the freshly-cleared file.
    this.buffer.cancelTimer();
    // Wait for a currently-draining batch first. If it failed and re-queued
    // itself, the explicit reset below discards it along with the rest of the
    // old conversation; if it succeeded, writeChain has already serialized it.
    await this.buffer.drainFlushPromise();
    this.buffer.clear();
    // Let any in-flight append land first — otherwise it would re-append
    // stale events AFTER the reset record below.
    await this.buffer.drainWriteChain();
    // Same for an in-flight metadata checkpoint: stop the timer and drain it
    // BEFORE the transcript is rewritten, so pre-reset summary state can
    // never land on top of the freshly cleared files.
    if (this.metadataTimer) {
      clearTimeout(this.metadataTimer);
      this.metadataTimer = null;
    }
    await this.metadataCheckpointInFlight?.catch(() => undefined);
    const resetAt = new Date().toISOString();
    const record = `${JSON.stringify({
      type: 'session_start',
      ts: resetAt,
      id: this.id,
      model: this.meta.model ?? 'unknown',
      provider: this.meta.provider ?? 'unknown',
    })}\n`;
    // Windows EPERM fix: close the append-mode handle before replacing the
    // file. Windows rejects rename() when the destination still has an open
    // handle, even if that handle belongs to this process. The caller
    // (/clear → buildClearCommand) may also call clearHistory which uses
    // atomicWrite (tmp + rename) — so we do NOT reopen here. The handle is
    // lazily reopened in enqueueWrite on the next append.
    await this.handle.close();
    // Atomic replace (tmp + rename): a crash mid-write must never leave a
    // torn transcript behind — /clear is destructive by intent, not by
    // accident. Matches clearHistory's durability discipline above.
    await atomicWrite(this.filePath, record, { mode: 0o600 });
    this.summaryTracker.reset(resetAt);
    // Mark dirty and re-arm immediately: if a SIGKILL lands before the next
    // observed append, the sidecar still holds PRE-reset counters while the
    // JSONL is already clean — the scheduled checkpoint heals them (~10s).
    // (No trailing dirty-clear here: it would self-cancel the armed timer.)
    this.metadataDirty = true;
    this.scheduleMetadataCheckpoint();
    this.activePromptIndex = null;
    this.pendingFileSnapshots = [];
    this.pendingFileSnapshotBytes = 0;
  }

  /**
   * Write an in-flight marker. The agent loop should call
   * this at the start of each long-running operation; a matching
   * `clearInFlightMarker` follows on clean exit. A stale marker
   * (no end) is what `SessionRecovery.detectStale` looks for.
   */
  async writeInFlightMarker(context: string): Promise<void> {
    if (!context || context.length > 500) {
      throw new Error('In-flight context must be 1..500 chars');
    }
    await this.append({
      type: 'in_flight_start',
      ts: new Date().toISOString(),
      context,
    });
    this.events?.emit('in_flight.started', {
      sessionId: this.id,
      context,
      ts: new Date().toISOString(),
    });
  }

  /**
   * Close the in-flight marker. Idempotent in spirit
   * (you can call it after a successful iteration even if you
   * didn't open one this round) — but the session log records
   * every call so postmortem tooling can see "the agent finished
   * cleanly X times, then died without finishing Y".
   */
  async clearInFlightMarker(reason: 'clean' | 'aborted' | 'recovered'): Promise<void> {
    if (this.pendingFileSnapshots.length > 0) {
      await this.writeFileSnapshot(this.activePromptIndex ?? 0, [...this.pendingFileSnapshots]);
      this.pendingFileSnapshots = [];
      this.pendingFileSnapshotBytes = 0;
    }
    await this.append({
      type: 'in_flight_end',
      ts: new Date().toISOString(),
      reason,
    });
    this.events?.emit('in_flight.ended', {
      sessionId: this.id,
      reason,
      ts: new Date().toISOString(),
    });
  }
}
