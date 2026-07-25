import { closeSync, createReadStream, fsyncSync, openSync, writeSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import type { EventBus } from '../kernel/events.js';
import type { SecretScrubber } from '../types/secret-scrubber.js';
import type {
  FileSnapshot,
  SessionEvent,
  SessionMetadata,
  SessionSummary,
  SessionWriter,
  WorkspaceCheckpointRef,
} from '../types/session.js';
import { atomicWrite } from '../utils/atomic-write.js';
import { toErrorMessage } from '../utils/index.js';
import type { SessionCheckpointCas } from './session-checkpoint-cas.js';
import { userInputTitle } from './session-helpers.js';

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
  private summary: SessionSummary;
  private tokenIn = 0;
  private tokenOut = 0;
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
  private appendFailCount = 0;
  private lastAppendWarnAt = 0;
  private readonly secretScrubber?: SecretScrubber | undefined;
  private readonly checkpointCas?: SessionCheckpointCas | undefined;
  private readonly onCloseCb?: ((summary: SessionSummary) => void | Promise<void>) | undefined;
  /** Implements SessionWriter.traceId — propagated from ContextInit.traceId. */
  traceId: string | undefined;

  // ── Write buffer — batches events to reduce per-event disk I/O ──────────────
  //
  // Every append() pushes the scrubbed event into an in-memory buffer instead
  // of calling handle.appendFile() synchronously. The buffer flushes to disk
  // when it reaches FLUSH_SIZE events OR after FLUSH_INTERVAL_MS of inactivity.
  // This cuts the number of disk writes by ~95% without changing the on-disk
  // format — the JSONL is still one JSON object per line.
  private writeBuffer: SessionEvent[] = [];
  private writeBufferBytes = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly FLUSH_INTERVAL_MS = 500;
  private static readonly FLUSH_SIZE = 50;
  private static readonly WRITE_BUFFER_MAX_EVENTS = 2_000;
  private static readonly WRITE_BUFFER_MAX_BYTES = 16 * 1024 * 1024;
  private bufferOverflowCount = 0;
  private lastBufferOverflowWarnAt = 0;

  private eventBytes(event: SessionEvent): number {
    try {
      return Buffer.byteLength(JSON.stringify(event), 'utf8') + 1;
    } catch {
      return FileSessionWriter.WRITE_BUFFER_MAX_BYTES + 1;
    }
  }

  private pushWriteBuffer(event: SessionEvent): boolean {
    const bytes = this.eventBytes(event);
    if (
      this.writeBuffer.length >= FileSessionWriter.WRITE_BUFFER_MAX_EVENTS ||
      bytes > FileSessionWriter.WRITE_BUFFER_MAX_BYTES ||
      this.writeBufferBytes + bytes > FileSessionWriter.WRITE_BUFFER_MAX_BYTES
    ) {
      this.bufferOverflowCount++;
      const now = Date.now();
      if (now - this.lastBufferOverflowWarnAt > 5_000) {
        console.warn(
          JSON.stringify({
            level: 'error',
            event: 'session.buffer_overflow',
            sessionId: this.id,
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

  // ── Write serialization ─────────────────────────────────────────────────────
  //
  // All disk writes are funneled through a FIFO promise chain. Without it,
  // a timer-driven flush racing an explicit flush()/close() issues two
  // concurrent appendFile() calls on the shared O_APPEND handle — the kernel
  // may complete them out of order (chronology breaks) or, for large
  // batches, interleave partial writes (torn JSONL lines). The write chain
  // serializes handle I/O; flushPromise coalesces concurrent flush requests
  // into one drain so callers cannot create an unbounded promise chain.
  private writeChain: Promise<void> = Promise.resolve();
  private flushPromise: Promise<void> | null = null;

  /** Enqueue a write on the FIFO chain. Resolves/rejects with that write. */
  private enqueueWrite(data: string): Promise<void> {
    const write = this.writeChain.then(async () => {
      // Lazy reopen: clearSession() closes the handle to allow a subsequent
      // clearHistory() atomicWrite (tmp + rename) on the same file. If the
      // handle is still closed when the next append arrives, reopen it.
      try {
        return await this.handle.appendFile(data, 'utf8');
      } catch (err: unknown) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr?.code === 'EBADF') {
          this.handle = await fsp.open(this.filePath, 'a', 0o600);
          return await this.handle.appendFile(data, 'utf8');
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

  // ── Enriched summary tracking ───────────────────────────────────────────────
  private iterationCount = 0;
  private toolCallCount = 0;
  private toolErrorCount = 0;
  private toolBreakdown: Record<string, number> = {};
  private fileChangeCount = 0;
  private compactionCount = 0;
  private outcome: SessionSummary['outcome'] = undefined;

  /**
   * Scrub secrets out of conversation-turn events before they are observed
   * for the summary, written to the JSONL log, or surfaced on resume. Only
   * Conversation events carry free-form user/model text. Snapshot and exact
   * message-journal normalization also strips transient token-cache fields
   * even when no scrubber is set.
   */
  private scrubEvent(event: SessionEvent): SessionEvent {
    const s = this.secretScrubber;
    const persistMessage = (message: import('../types/messages.js').Message) => {
      const { _estTokens: _ignored, ...persisted } = message;
      return {
        ...persisted,
        content:
          typeof persisted.content === 'string'
            ? (s?.scrub(persisted.content) ?? persisted.content)
            : (s?.scrubObject(persisted.content) ?? persisted.content),
      };
    };
    if (event.type === 'context_snapshot' || event.type === 'messages_replaced') {
      return { ...event, messages: event.messages.map(persistMessage) };
    }
    if (event.type === 'message_appended' || event.type === 'message_updated') {
      return { ...event, message: persistMessage(event.message) };
    }
    if (!s) return event;
    if (event.type === 'user_input') {
      return {
        ...event,
        content:
          typeof event.content === 'string' ? s.scrub(event.content) : s.scrubObject(event.content),
      };
    }
    if (event.type === 'llm_response') {
      return { ...event, content: s.scrubObject(event.content) };
    }
    return event;
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
  /** Tracks open tool_use IDs during the current run to serialize on close for resume. */
  private openToolUses = new Set<string>();

  /**
   * Buffer an event from a synchronous Context callback. ensureInit() starts
   * by pushing the lifecycle preamble synchronously, so session_start always
   * precedes observations even though these callbacks cannot await append().
   */
  private bufferSynchronousEvent(event: SessionEvent): void {
    if (this.closed) return;
    void this.ensureInit();
    this.observeForSummary(event);
    this.pushWriteBuffer(event);
    if (this.writeBuffer.length >= FileSessionWriter.FLUSH_SIZE) {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      void this.flushBuffer().catch(() => {
        // Retained at the head of writeBuffer for the boundary retry.
      });
    } else {
      this.scheduleFlush();
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
    private readonly startedAt: string,
    private readonly meta: Omit<SessionMetadata, 'startedAt'>,
    private readonly events?: EventBus | undefined,
    opts: {
      resumed?: boolean | undefined;
      dir?: string | undefined;
      filePath?: string | undefined;
      secretScrubber?: SecretScrubber | undefined;
      checkpointCas?: SessionCheckpointCas | undefined;
      /** Called on close() with the finalized summary for index/sidecar writes. */
      onClose?: ((summary: SessionSummary) => void | Promise<void>) | undefined;
    } = {},
    traceId?: string | undefined,
  ) {
    this.resumed = opts.resumed ?? false;
    // id already contains a date-prefix shard (e.g. "2026-06-06/sess_<ULID>").
    // opts.dir is the shard directory — join with basename so the manifest
    // lives next to the JSONL file instead of creating a double-nested path.
    this.manifestFile = opts.dir ? path.join(opts.dir, `${path.basename(id)}.summary.json`) : '';
    this.filePath = opts.filePath ?? '';
    this.secretScrubber = opts.secretScrubber;
    this.checkpointCas = opts.checkpointCas;
    this.onCloseCb = opts.onClose;
    this.summary = {
      id,
      title: '(empty session)',
      startedAt,
      model: meta.model ?? 'unknown',
      provider: meta.provider ?? 'unknown',
      tokenTotal: 0,
    };
    // Propagated from ContextInit.traceId via SessionWriter.traceId so that
    // storage events carry the run-level trace ID without needing a Context
    // handle in every storage operation.
    this.traceId = traceId;
  }

  get pendingToolUses(): string[] {
    return Array.from(this.openToolUses);
  }

  private async writeSessionStartLazy(): Promise<void> {
    // Keep the lifecycle preamble in the same retryable buffer as every other
    // reconstruct event. Writing it through a separate one-shot append meant
    // an ENOSPC/transient handle failure could permanently lose session_start
    // while later events survived, leaving an unidentifiable transcript.
    this.pushWriteBuffer({
      type: this.resumed ? 'session_resumed' : 'session_start',
      ts: this.startedAt,
      id: this.id,
      model: this.meta.model ?? 'unknown',
      provider: this.meta.provider ?? 'unknown',
    });
  }

  async append(event: SessionEvent): Promise<void> {
    if (this.closed) return;
    await this.ensureInit();
    // Scrub before observing (the summary title is derived from user_input
    // content) and before buffering, so neither the JSONL nor the sidecar
    // ever holds a cleartext secret.
    const scrubbed = this.scrubEvent(event);
    // observeForSummary MUST run synchronously here — the summary counters
    // (toolCallCount, tokenIn/Out, outcome) drive the .summary.json sidecar
    // and the session index. Deferring observation to flush time would leave
    // the summary stale if close() fires before the next timer tick.
    this.observeForSummary(scrubbed);
    this.pushWriteBuffer(scrubbed);

    if (this.writeBuffer.length >= FileSessionWriter.FLUSH_SIZE) {
      // Buffer full — flush immediately. Cancel any pending timer so we
      // don't double-flush on the next tick.
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      await this.flushBuffer().catch(() => {
        // append() is intentionally best-effort. The failed batch remains at
        // the front of writeBuffer; an explicit boundary flush can surface the
        // error while ordinary audit appends do not abort the agent loop.
      });
    } else {
      this.scheduleFlush();
    }
  }

  async appendBatch(events: SessionEvent[]): Promise<void> {
    if (this.closed || events.length === 0) return;
    await this.ensureInit();
    for (const event of events) {
      const scrubbed = this.scrubEvent(event);
      this.observeForSummary(scrubbed);
      this.pushWriteBuffer(scrubbed);
    }
    if (this.writeBuffer.length >= FileSessionWriter.FLUSH_SIZE) {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      await this.flushBuffer().catch(() => {
        // Same best-effort append contract as append(); batch is retained.
      });
    } else {
      this.scheduleFlush();
    }
  }

  /**
   * Flush buffered events to disk immediately. Critical events
   * (user_input, llm_response) call this so they survive SIGKILL/crash
   * instead of sitting in the in-memory buffer for up to 500ms.
   *
   * Idempotent — cancels any pending timer, writes whatever has accumulated,
   * then asks the OS to synchronize the file data before resolving. Even an
   * empty-buffer flush synchronizes any earlier timer-driven append.
   */
  async flush(): Promise<void> {
    if (this.closed) return;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushBuffer();
    await this.writeChain;
    try {
      await this.handle.datasync();
    } catch (err: unknown) {
      // Handle may be closed (e.g. after clearSession with no intervening
      // append). Reopen lazily so the handle is ready for the next write.
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr?.code === 'EBADF') {
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
   * saved with a blocking append. Best-effort: an in-flight async write may
   * be cut off by the exit regardless; errors here are swallowed.
   */
  flushSync(): void {
    if (this.writeBuffer.length === 0 || !this.filePath) return;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const batch = this.writeBuffer.map((e) => JSON.stringify(e)).join('\n') + '\n';
    this.writeBuffer = [];
    this.writeBufferBytes = 0;
    let fd: number | undefined;
    try {
      fd = openSync(this.filePath, 'a');
      writeSync(fd, batch, null, 'utf8');
      fsyncSync(fd);
    } catch {
      // best-effort — the process is exiting either way
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // best-effort — the process is exiting either way
        }
      }
    }
  }

  /** Schedule a deferred flush. No-op if a timer is already pending. */
  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      /* v8 ignore start -- defensive: flushBuffer logs its own errors; this guards the timer callback */
      this.flushBuffer().catch(() => {
        // flushBuffer already logs via the throttled-warning path;
        // this catch prevents an unhandled rejection in the timer callback.
      });
      /* v8 ignore stop */
    }, FileSessionWriter.FLUSH_INTERVAL_MS);
  }

  /**
   * Flush all buffered events to disk as a single appendFile call.
   * Concurrent callers join one coalesced drain. On failure the drained batch
   * is prepended to the live buffer, preserving chronology and allowing the
   * next timer/boundary flush to retry it. Warnings retain the existing
   * throttled behavior.
   */
  private flushBuffer(): Promise<void> {
    if (this.flushPromise) return this.flushPromise;
    const flush = (async () => {
      while (this.writeBuffer.length > 0) await this.flushBufferOnce();
    })().finally(() => {
      if (this.flushPromise === flush) this.flushPromise = null;
    });
    this.flushPromise = flush;
    return flush;
  }

  private async flushBufferOnce(): Promise<void> {
    if (this.writeBuffer.length === 0) return;
    const events = this.writeBuffer;
    const eventCount = events.length;
    const eventBytes = this.writeBufferBytes;
    const batch = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    this.writeBuffer = [];
    this.writeBufferBytes = 0;
    const t0 = Date.now();
    let outcome: 'success' | 'failure' = 'success';
    let errorMsg: string | undefined;
    try {
      await this.enqueueWrite(batch);
    } catch (err) {
      outcome = 'failure';
      errorMsg = toErrorMessage(err);
      // Retain the failed prefix, then admit as much of the newer tail as the
      // hard budget allows. This preserves chronology without letting a
      // persistent ENOSPC/permission failure consume the heap indefinitely.
      const newer = this.writeBuffer;
      this.writeBuffer = events;
      this.writeBufferBytes = eventBytes;
      for (const newerEvent of newer) this.pushWriteBuffer(newerEvent);
      this.appendFailCount += eventCount;
      const now = Date.now();
      if (now - this.lastAppendWarnAt > 5000) {
        const suppressed = this.appendFailCount - 1;
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'session.flush_failed',
            sessionId: this.id,
            message: toErrorMessage(err),
            ...(suppressed > 0 ? { suppressed } : {}),
            timestamp: new Date().toISOString(),
          }),
        );
        this.lastAppendWarnAt = now;
        this.appendFailCount = 0;
      }
      if (!this.closed) this.scheduleFlush();
      throw err;
    } finally {
      this.events?.emit('storage.write', {
        sessionId: this.id,
        store: 'session',
        filePath: this.filePath,
        operation: 'flush',
        outcome,
        durationMs: Date.now() - t0,
        ...(errorMsg !== undefined ? { error: errorMsg } : {}),
        ...(eventCount !== undefined ? { eventCount } : {}),
        ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
      });
    }
  }

  /**
   * Rebuild every accumulated summary counter by replaying the JSONL as it now
   * stands on disk.
   *
   * Only truncation needs this: the counters are fed by `observeForSummary` as
   * events go by and cannot un-count. Stream the JSONL so a very long session
   * does not need a second file-sized allocation during rewind.
   *
   * `title` is deliberately re-derived too: the first surviving user_input may
   * differ once earlier prompts are gone.
   */
  private async recomputeSummaryFromDisk(): Promise<void> {
    if (!this.filePath) return;
    const accessible = await fsp
      .access(this.filePath)
      .then(() => true)
      .catch(() => false);
    if (!accessible) return;

    this.iterationCount = 0;
    this.toolCallCount = 0;
    this.toolErrorCount = 0;
    this.toolBreakdown = {};
    this.fileChangeCount = 0;
    this.compactionCount = 0;
    this.outcome = undefined;
    this.openToolUses = new Set<string>();
    this.tokenIn = 0;
    this.tokenOut = 0;
    this.summary = { ...this.summary, title: '(empty session)', tokenTotal: 0 };

    const input = createReadStream(this.filePath, { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
    try {
      for await (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          this.observeForSummary(JSON.parse(trimmed) as SessionEvent);
        } catch {
          // Skip a malformed line — the rewrite preserves it verbatim, and a
          // torn record must not abort the recount of everything after it.
        }
      }
    } finally {
      lines.close();
      input.destroy();
    }
  }

  private observeForSummary(event: SessionEvent): void {
    // Track open tool uses so we can serialize them on close for resume.
    // The authoritative source is the llm_response content (a core event,
    // always written at every audit level); the legacy 'tool_use' event is
    // kept for alternate writers that still emit it.
    if (event.type === 'llm_response') {
      for (const block of event.content) {
        if (block.type === 'tool_use') this.openToolUses.add(block.id);
      }
    }
    if (event.type === 'tool_use') {
      this.openToolUses.add(event.id);
    } else if (event.type === 'tool_call_start') {
      this.toolCallCount++;
      this.toolBreakdown[event.name] = (this.toolBreakdown[event.name] ?? 0) + 1;
    } else if (event.type === 'tool_result') {
      this.openToolUses.delete(event.id);
      if (event.isError) {
        this.toolErrorCount++;
        this.outcome = 'error';
      }
    } else if (event.type === 'file_snapshot') {
      this.fileChangeCount += event.files.length;
    } else if (event.type === 'compaction') {
      this.compactionCount++;
    }
    // Error events (provider errors, execution errors) mark the session as failed.
    if (event.type === 'error' || event.type === 'provider_error') {
      this.outcome = 'error';
    }
    if (event.type === 'user_input' && this.summary.title === '(empty session)') {
      this.summary = { ...this.summary, title: userInputTitle(event.content) };
    } else if (event.type === 'llm_response') {
      this.tokenIn += event.usage.input;
      this.tokenOut += event.usage.output;
      this.summary = { ...this.summary, tokenTotal: this.tokenIn + this.tokenOut };
    } else if (event.type === 'session_end') {
      const total = event.usage.input + event.usage.output;
      if (total > 0) this.summary = { ...this.summary, tokenTotal: total };
    } else if (event.type === 'in_flight_start') {
      this.iterationCount++;
    }
  }

  async close(): Promise<void> {
    // Idempotent AND awaitable: concurrent/repeat callers share the same
    // promise, so nobody proceeds (e.g. to tear down the session directory)
    // while the first close is still flushing.
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.doClose().catch((err) => {
      // A failed durable drain must not permanently brick the writer. Keep the
      // handle open and allow the timer or a later close() call to retry.
      this.closed = false;
      this.closePromise = null;
      if (this.writeBuffer.length > 0) this.scheduleFlush();
      throw err;
    });
    return this.closePromise;
  }

  private async doClose(): Promise<void> {
    if (this.pendingFileSnapshots.length > 0) {
      await this.writeFileSnapshot(this.activePromptIndex ?? 0, [...this.pendingFileSnapshots]);
      this.pendingFileSnapshots = [];
      this.pendingFileSnapshotBytes = 0;
    }
    this.closed = true;
    // Flush any buffered events before finalizing. The summary counters
    // (toolCallCount, tokenIn/Out, outcome) are already up to date because
    // observeForSummary runs synchronously on every append, but the JSONL
    // must have all events on disk before we write the .summary.json sidecar.
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushBuffer();
    // Drain any write enqueued outside flushBuffer (e.g. the lazy
    // session_start record) before the handle is closed.
    await this.writeChain;
    try {
      await this.handle.datasync();
    } catch (err: unknown) {
      // Handle may already be closed (e.g. clearSession closed it but no
      // append reopened). Best-effort: the fd is still valid for close().
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr?.code !== 'EBADF') throw err;
    }
    // Finalize the summary before writing.
    this.summary = {
      ...this.summary,
      endedAt: new Date().toISOString(),
      iterationCount: this.iterationCount,
      toolCallCount: this.toolCallCount,
      toolErrorCount: this.toolErrorCount,
      fileChangeCount: this.fileChangeCount,
      compactionCount: this.compactionCount > 0 ? this.compactionCount : undefined,
      toolBreakdown: { ...this.toolBreakdown },
      outcome: this.outcome ?? 'completed',
    };
    // Emit storage.write for the manifest sidecar.
    if (this.manifestFile) {
      const t0 = Date.now();
      let outcome: 'success' | 'failure' = 'success';
      let errorMsg: string | undefined;
      try {
        await atomicWrite(this.manifestFile, JSON.stringify(this.summary), { mode: 0o600 });
      } catch (err) {
        outcome = 'failure';
        errorMsg = toErrorMessage(err);
        // manifest write is best-effort
      } finally {
        this.events?.emit('storage.write', {
          sessionId: this.id,
          store: 'session',
          filePath: this.manifestFile,
          operation: 'close',
          outcome,
          durationMs: Date.now() - t0,
          ...(errorMsg !== undefined ? { error: errorMsg } : {}),
          ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
        });
      }
    }
    // Notify the store so it can update the session index. Await so the
    // index write completes before close() resolves — otherwise the
    // fire-and-forget _index.jsonl append races callers that tear down the
    // session directory right after close() (e.g. ENOTEMPTY on Windows).
    // Emit storage.write here so it carries this.traceId; the actual I/O
    // is delegated to onCloseCb (appendToIndex) which no longer emits.
    const idxT0 = Date.now();
    let idxOutcome: 'success' | 'failure' = 'success';
    let idxError: string | undefined;
    try {
      await this.onCloseCb?.(this.summary);
      /* v8 ignore start -- best-effort: appendToIndex swallows its own errors */
    } catch (err) {
      idxOutcome = 'failure';
      idxError = toErrorMessage(err);
      // best-effort
    } finally {
      /* v8 ignore stop */
      this.events?.emit('storage.write', {
        sessionId: this.summary.id,
        store: 'session',
        filePath: this.filePath,
        operation: 'index_append',
        outcome: idxOutcome,
        durationMs: Date.now() - idxT0,
        ...(idxError !== undefined ? { error: idxError } : {}),
        ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
      });
    }
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
      // Conversation checkpoints remain usable even when Git/CAS capture is
      // unavailable. The missing workspaceCheckpoint field makes the reduced
      // guarantee explicit to fork/materialization callers.
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
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushBuffer();
    // Drain the write chain so no in-flight write straddles the close/rename/reopen.
    await this.writeChain;

    // Single-pass scan: track byte offset of each line start. Stop as soon as
    // the target checkpoint is found — no I/O or parsing for post-checkpoint data.
    const CHUNK_SIZE = 65_536;
    let fd: fsp.FileHandle | undefined;
    let fileOffset = 0; // cumulative byte position of the start of the next disk read
    let pendingLine = Buffer.alloc(0); // bytes after the last newline, carried across chunks
    let checkpointByteOffset = -1; // byte offset where we will truncate the file
    let removedCount = 0;
    let targetCheckpointSeen = false; // has the target checkpoint been found yet?

    try {
      fd = await fsp.open(this.filePath, 'r', 0o600);

      while (true) {
        const buf = Buffer.alloc(CHUNK_SIZE);
        const { bytesRead } = await fd.read(buf, 0, CHUNK_SIZE, fileOffset);
        if (bytesRead === 0) break;

        const carriedBytes = pendingLine.length;
        const chunk =
          carriedBytes === 0
            ? buf.subarray(0, bytesRead)
            : Buffer.concat([pendingLine, buf.subarray(0, bytesRead)]);
        const chunkFileOffset = fileOffset - carriedBytes;
        let chunkPos = 0;
        while (chunkPos < chunk.length) {
          const idx = chunk.indexOf('\n', chunkPos);
          if (idx === -1) break;

          const lineStartOffset = chunkFileOffset + chunkPos;
          if (checkpointByteOffset !== -1) {
            // Target already found — every subsequent line is removed.
            removedCount++;
          } else {
            // Only parse lines that could precede or be the checkpoint.
            const lineBytes = chunk.subarray(chunkPos, idx);
            // eslint-disable-next-line no-sync
            const line = new TextDecoder('utf-8', { fatal: false }).decode(lineBytes);
            if (line.trim()) {
              try {
                const event = JSON.parse(line) as { type?: string; promptIndex?: number };
                if (event.type === 'checkpoint') {
                  if (event.promptIndex === targetPromptIndex) {
                    // Target found — record its byte offset and stop scanning.
                    checkpointByteOffset = lineStartOffset;
                    targetCheckpointSeen = true;
                  } else if (
                    event.promptIndex !== undefined &&
                    event.promptIndex > targetPromptIndex
                  ) {
                    // A checkpoint with a higher promptIndex means the target is absent.
                    // Truncate before this line (exclusive) — it and all following events
                    // will be replaced by the new rewinded history.
                    checkpointByteOffset = lineStartOffset;
                  }
                } else if (
                  targetCheckpointSeen &&
                  event.promptIndex !== undefined &&
                  event.promptIndex > targetPromptIndex
                ) {
                  // Post-target event with a later promptIndex — count as removed.
                  removedCount++;
                } else if (targetCheckpointSeen && event.promptIndex === undefined) {
                  // After the target checkpoint was found: remove events with no
                  // promptIndex. (In the original this is the afterTarget &&
                  // targetCheckpointLine !== -1 branch.)
                  removedCount++;
                } else if (!targetCheckpointSeen && event.promptIndex === undefined) {
                  // Past a higher checkpoint but the target checkpoint not yet found.
                  // Matches original: remove events with undefined promptIndex
                  // (malformed lines, file_snapshots, etc.) that appear after a
                  // higher checkpoint but before the target.
                  removedCount++;
                } else if (
                  !targetCheckpointSeen &&
                  event.promptIndex !== undefined &&
                  event.promptIndex > targetPromptIndex
                ) {
                  // Past a higher checkpoint but the target not yet found.
                  // Matches original: remove events with promptIndex > target that
                  // appear before the target checkpoint (e.g. user_inputs belonging
                  // to a later prompt).
                  removedCount++;
                }
                // Events with promptIndex <= targetPromptIndex (before the target is
                // found) are implicitly kept — no action needed.
              } catch {
                // Malformed JSON — matches original: keep it.
              }
            }
          }

          chunkPos = idx + 1;
        }

        pendingLine = chunk.subarray(chunkPos);
        fileOffset += bytesRead;
      }
    } finally {
      await fd?.close();
    }

    if (checkpointByteOffset === -1) return 0;

    // Windows EPERM fix: close the append-mode handle before replacing the
    // file. Windows rejects rename() when the destination still has an open
    // handle, even if that handle belongs to this process.
    await this.writeChain;
    try {
      await this.handle.close();
    } catch {
      // Ignore — handle may already be closed (e.g. by clearSession).
      // Consistent with the doClose() best-effort pattern.
    }
    const tmpPath = `${this.filePath}.rewind.tmp`;
    const src = await fsp.open(this.filePath, 'r', 0o600);
    try {
      const statResult = await src.stat();
      const totalSize = statResult.size;
      // checkpointByteOffset points to the start of the checkpoint line.
      // We want to keep everything up to and including that line's '\n'.
      // Since the file ends with '\n', keeping bytes [0 .. lineStartAfterCheckpoint]
      // means we include the trailing newline. We find that '\n' by scanning
      // from checkpointByteOffset forward (at most one chunk's worth).
      const prefixBytes = checkpointByteOffset;
      let newlineAfterCheckpoint = prefixBytes;

      if (prefixBytes < totalSize) {
        const probeBuf = Buffer.alloc(Math.min(CHUNK_SIZE, totalSize - prefixBytes));
        const { bytesRead: probeRead } = await src.read(probeBuf, 0, probeBuf.length, prefixBytes);
        if (probeRead > 0) {
          const nl = probeBuf.indexOf('\n');
          newlineAfterCheckpoint = nl !== -1 ? prefixBytes + nl + 1 : totalSize;
        }
      } else {
        newlineAfterCheckpoint = totalSize;
      }

      const writeFd = await fsp.open(tmpPath, 'w', 0o600);
      try {
        let readOffset = 0;
        while (readOffset < newlineAfterCheckpoint) {
          const toCopy = Math.min(CHUNK_SIZE, newlineAfterCheckpoint - readOffset);
          const copyBuf = Buffer.alloc(toCopy);
          const { bytesRead: r } = await src.read(copyBuf, 0, toCopy, readOffset);
          if (r === 0) break;
          await writeFd.write(copyBuf, 0, r);
          readOffset += r;
        }

        // Preserve malformed JSONL records even after the rewind target. They
        // are not replayable session events, but keeping them avoids silently
        // deleting diagnostic/corruption evidence during a truncate.
        // Stream the tail from the already-open src handle instead of
        // re-reading the entire file — the prefix was already streamed above,
        // so reading via readFile() would duplicate all of that I/O.
        let tailOffset = newlineAfterCheckpoint;
        let leftover = '';
        while (tailOffset < totalSize) {
          const toRead = Math.min(CHUNK_SIZE, totalSize - tailOffset);
          const tailBuf = Buffer.alloc(toRead);
          const { bytesRead: tr } = await src.read(tailBuf, 0, toRead, tailOffset);
          if (tr === 0) break;
          const chunk = leftover + tailBuf.subarray(0, tr).toString('utf8');
          const lastNl = chunk.lastIndexOf('\n');
          if (lastNl === -1) {
            // No complete line in this chunk — accumulate into leftover.
            leftover = chunk;
          } else {
            for (const line of chunk.slice(0, lastNl + 1).split('\n')) {
              if (!line.trim()) continue;
              try {
                JSON.parse(line);
              } catch {
                await writeFd.write(`${line}\n`, undefined, 'utf8');
              }
            }
            leftover = chunk.slice(lastNl + 1);
          }
          tailOffset += tr;
        }
        // Flush trailing partial line (file may not end with \n).
        if (leftover.trim()) {
          try {
            JSON.parse(leftover);
          } catch {
            await writeFd.write(`${leftover}\n`, undefined, 'utf8');
          }
        }
        // fsync the data to disk BEFORE the rename. Without this, a power loss
        // after the rename is journaled but before the data pages are flushed
        // can leave the whole session JSONL zero-filled on NTFS — losing the
        // entire session, not just the rewound tail.
        await writeFd.sync();
      } finally {
        await writeFd.close();
      }

      await src.close();
      await fsp.rename(tmpPath, this.filePath);
      // Re-open in append mode for continued use of this file.
      this.handle = await fsp.open(this.filePath, 'a', 0o600);
      /* v8 ignore start -- defensive: close/rename/reopen of a just-written temp file */
    } catch (err) {
      await fsp.unlink(tmpPath).catch(() => undefined);
      this.handle = await fsp.open(this.filePath, 'a', 0o600).catch(() => this.handle);
      throw err;
    }
    /* v8 ignore stop */

    // The summary counters accumulate as events are observed and know nothing
    // about truncation, so without this `close()` would write a .summary.json —
    // and an _index.jsonl row, which list() reads — still counting the tool
    // calls, file changes and tokens of the work just rewound.
    await this.recomputeSummaryFromDisk();

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
      removedEvents: removedCount,
    });

    return removedCount;
  }

  async clearSession(): Promise<void> {
    /* v8 ignore next -- defensive: filePath is always set for a live writer */
    if (!this.filePath) return;
    // Discard any buffered events — the caller is explicitly resetting the
    // session to a clean slate. Cancel the timer so it doesn't fire and
    // append stale events to the freshly-cleared file.
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    // Wait for a currently-draining batch first. If it failed and re-queued
    // itself, the explicit reset below discards it along with the rest of the
    // old conversation; if it succeeded, writeChain has already serialized it.
    await this.flushPromise?.catch(() => undefined);
    this.writeBuffer = [];
    this.writeBufferBytes = 0;
    // Let any in-flight append land first — otherwise it would re-append
    // stale events AFTER the reset record below.
    await this.writeChain;
    const record = `${JSON.stringify({
      type: 'session_start',
      ts: new Date().toISOString(),
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
    await fsp.writeFile(this.filePath, record, 'utf8');
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
