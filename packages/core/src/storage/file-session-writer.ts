import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { SecretScrubber } from '../types/secret-scrubber.js';
import type {
  FileSnapshot,
  SessionEvent,
  SessionMetadata,
  SessionSummary,
  SessionWriter,
} from '../types/session.js';
import type { EventBus } from './event-bus-port.js';
import type { SessionCheckpointCas } from './session-checkpoint-cas.js';
import { SessionSummaryTracker } from './session-summary-tracker.js';
import { SessionWriteBuffer } from './session-write-buffer.js';
import { isClosedHandleError } from './session-writer/session-writer-flush.js';
import {
  executeClearSession,
  persistSessionCloseSummary,
  runMetadataCheckpointOperation,
} from './session-writer-checkpoint.js';
import { executeSessionTruncate } from './session-writer-rewind.js';
import { scrubSessionWriterEvent } from './session-writer-scrubber.js';
import {
  dispatchSynchronousBufferEvent,
  isCriticalEvent,
  SessionSnapshotTracker,
  writeSessionCheckpoint,
} from './session-writer-snapshot.js';

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

  private readonly snapshotTracker = new SessionSnapshotTracker();
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
    dispatchSynchronousBufferEvent(
      {
        buffer: this.buffer,
        closed: this.closed,
        handle: this.handle,
        sessionId: this.id,
      },
      appendEvent,
      critical,
    );
  }

  recordFileChange(input: {
    path: string;
    action: 'created' | 'modified' | 'deleted';
    before: string | null;
    after: string | null;
  }): void {
    if (this.closed) return;
    this.snapshotTracker.recordFileChange(this.id, this.activePromptIndex, input, (ev) =>
      this.bufferSynchronousEvent(ev),
    );
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
    const run = runMetadataCheckpointOperation(
      {
        sessionId: this.id,
        filePath: this.filePath,
        manifestFile: this.manifestFile,
        traceId: this.traceId,
        events: this.events,
        summaryTracker: this.summaryTracker,
        onMetadataCheckpointCb: this.onMetadataCheckpointCb,
      },
      () => {
        this.metadataDirty = false;
        if (this.metadataDirty && !this.closed) this.scheduleMetadataCheckpoint();
      },
      () => {
        this.metadataDirty = true;
        this.scheduleMetadataCheckpoint();
      },
    ).finally(() => {
      this.metadataCheckpointInFlight = null;
    });
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
    if (this.snapshotTracker.length > 0) {
      await this.writeFileSnapshot(this.activePromptIndex ?? 0, this.snapshotTracker.takePending());
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

    await persistSessionCloseSummary(
      {
        sessionId: this.id,
        filePath: this.filePath,
        manifestFile: this.manifestFile,
        traceId: this.traceId,
        events: this.events,
        onCloseCb: this.onCloseCb,
      },
      summary,
    );
    try {
      await this.handle.close();
    } catch {
      // ignore
    }
  }

  async writeCheckpoint(promptIndex: number, promptPreview: string): Promise<void> {
    await writeSessionCheckpoint(
      {
        sessionId: this.id,
        snapshotTracker: this.snapshotTracker,
        checkpointCas: this.checkpointCas,
        events: this.events,
        append: (ev) => this.append(ev),
        writeFileSnapshot: (idx, files) => this.writeFileSnapshot(idx, files),
        setActivePromptIndex: (idx) => {
          this.activePromptIndex = idx;
        },
      },
      promptIndex,
      promptPreview,
    );
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
    return executeSessionTruncate({
      sessionId: this.id,
      filePath: this.filePath,
      targetPromptIndex,
      revertedFiles,
      closed: this.closed,
      buffer: this.buffer,
      handle: this.handle,
      setHandle: (h) => {
        this.handle = h;
      },
      events: this.events,
      summaryTracker: this.summaryTracker,
      append: (ev) => this.append(ev),
      cancelMetadataTimer: () => {
        if (this.metadataTimer) {
          clearTimeout(this.metadataTimer);
          this.metadataTimer = null;
        }
      },
      metadataCheckpointInFlight: this.metadataCheckpointInFlight,
      scheduleMetadataCheckpoint: () => this.scheduleMetadataCheckpoint(),
      setActivePromptIndex: (idx) => {
        this.activePromptIndex = idx;
      },
    });
  }

  async clearSession(): Promise<void> {
    await executeClearSession({
      id: this.id,
      filePath: this.filePath,
      meta: this.meta,
      handle: this.handle,
      buffer: this.buffer,
      summaryTracker: this.summaryTracker,
      cancelMetadataTimer: () => {
        if (this.metadataTimer) {
          clearTimeout(this.metadataTimer);
          this.metadataTimer = null;
        }
      },
      metadataCheckpointInFlight: this.metadataCheckpointInFlight,
      scheduleMetadataCheckpoint: () => this.scheduleMetadataCheckpoint(),
      onCleared: () => {
        this.metadataDirty = true;
        this.activePromptIndex = null;
        this.snapshotTracker.clear();
      },
    });
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
    if (this.snapshotTracker.length > 0) {
      await this.writeFileSnapshot(this.activePromptIndex ?? 0, this.snapshotTracker.takePending());
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
