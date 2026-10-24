import type {
  ForkedSession,
  ResumedSession,
  SessionData,
  SessionForkOptions,
  SessionMetadata,
  SessionSummary,
  WorkspaceCheckpointRef,
  WorkspaceMaterializationResult,
} from './session.js';
import type { SessionEvent } from './session-events.js';

/**
 * Byte-level progress for a session JSONL load. `loadedBytes` counts raw
 * source bytes consumed so far (newline-inclusive approximation) and
 * `totalBytes` is the source file size at load start.
 */
export interface SessionLoadProgress {
  loadedBytes: number;
  totalBytes: number;
}

export interface SessionStoragePolicy {
  /** Most-recent sessions (by lastActivity) that stay uncompressed. */
  hotKeepSessions: number;
  /** Archive when last activity is older than this many days AND outside keep-N. */
  archiveAfterDays: number;
  /** Gzip subagent journals with the leader. */
  includeSubagents: boolean;
  /**
   * Compress every hot transcript outside keep-N immediately, ignoring
   * `archiveAfterDays`. Used to drain an existing JSONL pile on boot.
   */
  backfill?: boolean | undefined;
}

export interface SessionArchiveResult {
  id: string;
  action: 'archived' | 'rehydrated' | 'already-hot' | 'already-cold' | 'skipped';
  reason?: string | undefined;
  uncompressedBytes?: number | undefined;
  compressedBytes?: number | undefined;
}

export interface SessionArchiveIdleResult {
  archived: number;
  skipped: number;
  failed: number;
  results: SessionArchiveResult[];
}

/** Where `SessionStore.move` puts a session. */
export interface SessionMoveTarget {
  /** Store of the destination; the same store for a worktree of this repository. */
  store: Required<Pick<SessionStore, 'sessionsDir' | 'adoptMovedSession'>>;
  /** Checkout directory the session belongs to from now on. */
  checkout: string;
}

export interface SessionMoveResult {
  id: string;
  /** `worktree`: re-stamped in place. `project`: moved to another project's store. */
  kind: 'worktree' | 'project';
  checkout: string;
  /** Project the session came from, for a `project` move. */
  fromProject?: string | undefined;
  summary: SessionSummary;
}

export interface SessionStore {
  create(meta: Omit<SessionMetadata, 'startedAt'>): Promise<SessionWriter>;
  /**
   * Read a session without claiming it for writing.
   *
   * `onLoadProgress` mirrors {@link SessionStore.resume} — the implementation
   * has always accepted it, but the interface did not declare it, so the only
   * caller that can stream progress for a read-only view (a resume falling
   * back to showing the transcript it could not attach to) had to drop it and
   * leave the user staring at a frozen screen for the length of a 131 MB
   * parse. Implementations may ignore it.
   */
  load(id: string, onLoadProgress?: (progress: SessionLoadProgress) => void): Promise<SessionData>;
  /**
   * Open an existing session for append, returning both a writer that
   * continues writing to the same JSONL file and the replayed state
   * (messages + usage) so the caller can hydrate a Context. A
   * `session_resumed` marker is appended for audit. New writers may also
   * persist the exact conversation journal (`message_*` events); legacy logs
   * containing only user/assistant/tool events remain replayable.
   *
   * Optional `onLoadProgress` streams byte-level parse progress for large
   * journals so callers can surface a live indicator; implementations may
   * ignore it, and a warm load cache reports a single completed event.
   */
  resume(
    id: string,
    onLoadProgress?: (progress: SessionLoadProgress) => void,
  ): Promise<ResumedSession>;
  /**
   * Create a non-destructive child journal from a persisted parent boundary.
   * Parent file snapshots are intentionally not inherited as rewind authority;
   * filesystem isolation is the caller's worktree/CAS responsibility.
   */
  fork?(id: string, opts?: SessionForkOptions): Promise<ForkedSession>;
  /** Capture a content-addressed identity for the current project workspace. */
  captureWorkspaceCheckpoint?(
    sessionId: string,
    promptIndex: number,
  ): Promise<WorkspaceCheckpointRef | undefined>;
  /** Apply a captured workspace manifest to an already-isolated checkout. */
  materializeWorkspaceCheckpoint?(
    checkpoint: WorkspaceCheckpointRef,
    targetRoot: string,
  ): Promise<WorkspaceMaterializationResult>;
  list(limit?: number): Promise<SessionSummary[]>;
  /**
   * Resolve an exact, leaf-only, or unique-prefix reference to a canonical
   * persisted id. Implementations that omit this method require exact ids.
   */
  resolveId?(query: string): Promise<string>;
  /**
   * Set or clear a user-supplied name on a session. An empty/whitespace
   * `name` clears the field (the summary's auto-derived `title` remains).
   * Persists the change to the `.summary.json` sidecar and updates the
   * `_index.jsonl` cache so subsequent `list()` calls reflect it.
   * Returns the refreshed summary. Throws if the session does not exist.
   */
  rename(id: string, name: string): Promise<SessionSummary>;
  /**
   * Move a session that is not open anywhere to another checkout: a git
   * worktree of this repository (same store; the session is re-stamped) or
   * another project (the journal moves to that project's store). Refuses a
   * live session.
   */
  move?(id: string, target: SessionMoveTarget): Promise<SessionMoveResult>;
  /** This store's journal directory; `move` compares stores by it. */
  readonly sessionsDir?: string;
  /** Index a session a move just placed in this store (see `move`). */
  adoptMovedSession?(id: string, name: string | undefined): Promise<SessionSummary>;
  /**
   * Return true only when the persisted journal is strictly readable and
   * contains lifecycle envelope events but no messages or other session content.
   * Implementations should fail closed (false) for malformed or unknown events.
   * Optional stores that cannot make this guarantee must omit the method.
   */
  isEmpty?(id: string): Promise<boolean>;
  delete(id: string): Promise<void>;
  /**
   * Rewrite the session JSONL file to contain only a fresh session_start
   * event, effectively clearing all conversation history for that session.
   * Called by /clear to wipe persistent chat history.
   */
  clearHistory(id: string): Promise<void>;
  /**
   * Delete sessions whose JSONL file mtime is older than maxAgeDays.
   * Also removes associated summary files, plan/todos sidecars, and
   * session directories. Returns the count of deleted sessions.
   * Live sessions are protected by the host's SessionRegistry-backed
   * `isSessionInUse` guard.
   */
  prune(maxAgeDays?: number): Promise<number>;
  /**
   * Lossless-gzip a closed session transcript. Live sessions are refused.
   * Resume rehydrates automatically; this is the explicit maintenance path.
   */
  archive?(id: string): Promise<SessionArchiveResult>;
  /** Expand a gzip archive back to appendable JSONL. */
  rehydrate?(id: string): Promise<SessionArchiveResult>;
  /**
   * Archive sessions outside the keep-N / age window. Does not delete.
   * `/prune` remains the delete path.
   */
  archiveIdle?(policy?: Partial<SessionStoragePolicy>): Promise<SessionArchiveIdleResult>;
  /**
   * Rebuild the session index from disk. Scans all session directories,
   * computes summaries, and writes a fresh _index.jsonl. Returns the
   * number of sessions indexed.
   */
  rebuildIndex?(): Promise<number>;
  /** Release project-daemon connections owned by this store. */
  dispose?(): Promise<void>;
  /**
   * Streaming event-level search. Walks the JSONL once without buffering
   * the whole file, calling `predicate(event, eventIndex, ts)` for each
   * parsed event. Stops as soon as `limit` matches are collected (when
   * provided) and yields only the matching events back to the caller.
   *
   * Implementations that don't support streaming MUST omit this method;
   * the SessionReader fallback path will then call `load()` instead. The
   * method is intentionally non-throwing for missing files — a missing
   * session yields an empty array, matching `load()` semantics for ENOENT.
   *
   * @param id  Session id (with or without the `.jsonl` suffix).
   * @param predicate  Returns true to keep the event in the result set.
   * @param opts.limit  Maximum number of hits to keep. Omit for unbounded.
   * @param opts.signal  Optional AbortSignal for early termination.
   */
  searchEvents?(
    id: string,
    predicate: (event: SessionEvent, eventIndex: number, ts: string) => boolean,
    opts?: { limit?: number | undefined; signal?: AbortSignal | undefined },
  ): Promise<Array<{ event: SessionEvent; eventIndex: number; ts: string }>>;
}

export interface SessionWriter {
  readonly id: string;
  /** Original session start timestamp, used by resumed surfaces to keep uptime stable. */
  readonly startedAt?: string | undefined;
  /**
   * Session-level trace ID for correlating storage events with agent
   * iterations in observability pipelines. Generated once at Context
   * creation time and stored here so storage operations can include it
   * in `storage.*` events even though the store has no direct handle
   * on the Context.
   */
  traceId?: string | undefined;
  /**
   * Optional callback invoked synchronously after each event is scrubbed
   * and observed for summary, immediately before it enters the write
   * buffer. The event has been scrubbed (PII removed) and observed
   * (counters updated) but NOT yet written to disk.
   *
   * When the event originates from {@link appendBatch}, this callback is
   * ALSO invoked for each individual event in the batch, in addition to
   * the {@link onAppendBatch} callback (which fires once for the whole
   * batch). Subscribing to both will therefore receive each batch event
   * twice — design consumers to subscribe to either per-event or batch,
   * not both, unless deduplication is handled.
   *
   * The callback must not throw — errors are silently swallowed to
   * preserve the best-effort contract of session logging. If the
   * callback needs async work, it should fire-and-forget rather than
   * blocking the append.
   *
   * Used by the HQ telemetry bridge to stream events without reading
   * them back from the JSONL file on disk.
   */
  onAppend?: ((event: SessionEvent) => void) | undefined;
  /**
   * Batch variant of {@link onAppend}. Called once per batch with
   * the already-scrubbed event array, after all have been observed
   * and after the per-event {@link onAppend} has already fired for
   * each event in the batch. Subscribing to both callbacks will
   * receive every batch event twice.
   */
  onAppendBatch?: ((events: SessionEvent[]) => void) | undefined;
  /**
   * Set or replace the {@link onAppend} callback after construction.
   * The previous callback (if any) is discarded. Used by telemetry bridges
   * that receive the writer as an already-created dependency.
   */
  setOnAppend?(cb: ((event: SessionEvent) => void) | undefined): void;
  /**
   * Set or replace the {@link onAppendBatch} callback after construction.
   */
  setOnAppendBatch?(cb: ((events: SessionEvent[]) => void) | undefined): void;
  /**
   * Absolute path to the JSONL file this writer appends to, when one
   * exists. In-memory writers (tests, ephemeral sessions) leave it
   * undefined. Observability surfaces (`/fleet log`, FleetPanel) use
   * this to tell the user *where* the transcript lives without
   * having to recompute the path from session metadata.
   */
  readonly transcriptPath?: string | undefined;
  /** IDs of tool_use blocks that have been sent but not yet received a tool_result.
   * Used by the REPL to serialize pending state into `session_end` for proper resume. */
  readonly pendingToolUses: string[];
  append(event: SessionEvent): Promise<void>;
  /**
   * Append a batch of events in one call. Semantically equivalent to calling
   * `append()` for each event sequentially, but avoids N individual function
   * calls, scrub/observe cycles, and timer rescheduling. The caller is
   * responsible for ensuring events are in the correct order.
   */
  appendBatch(events: SessionEvent[]): Promise<void>;
  /**
   * Flush any buffered events to disk immediately. Use after critical
   * events (user_input, llm_response) to ensure they survive a crash
   * or SIGKILL that would otherwise leave them in the in-memory buffer.
   * Idempotent — safe to call even when the buffer is empty. File-backed
   * writers reject on a failed disk append while retaining the batch for a
   * later retry; callers may log/degrade without losing event chronology.
   */
  flush(): Promise<void>;
  /**
   * Last-gasp synchronous drain for hard-exit paths (e.g. `process.exit`
   * after rapid Ctrl+C) where the async `flush()` cannot be awaited.
   * Writes whatever is still in the in-memory buffer with a blocking
   * append. Best-effort — errors are swallowed. Optional: in-memory
   * writers have nothing durable to drain.
   */
  flushSync?(): void;
  close(): Promise<void>;
  /**
   * Register a file change for later snapshotting.
   * Called by write/edit/delete tools to track pending changes.
   */
  recordFileChange(input: {
    path: string;
    action: 'created' | 'modified' | 'deleted';
    before: string | null;
    after: string | null;
  }): void;
  /**
   * Persist the hash of a file version observed by a tool. Optional for
   * alternate/in-memory writers; file-backed writers use it for stale-file
   * validation during resume.
   */
  recordFileObservation?(input: {
    path: string;
    hash: string;
    mtimeMs: number;
    source: 'user' | 'write';
  }): void;
  /**
   * Record a structured side effect for audit (P2 #5). Implementations
   * append a `side_effect` event to the session JSONL. Best-effort —
   * callers fire-and-forget; errors are swallowed.
   */
  recordSideEffect(input: {
    toolUseId: string;
    toolName: string;
    input: Record<string, unknown>;
    outcome?: string | undefined;
    risk: 'fs.write' | 'shell' | 'package' | 'network' | 'config';
  }): void;
  /**
   * Write a checkpoint marker after a user input is processed.
   * Also flushes any pending file snapshots.
   */
  writeCheckpoint(promptIndex: number, promptPreview: string): Promise<void>;
  /**
   * Write a file snapshot after file changes are detected.
   * Called by the file watcher or tool interceptor.
   */
  writeFileSnapshot(
    promptIndex: number,
    files: import('./session.js').FileSnapshot[],
  ): Promise<void>;
  /**
   * Truncate conversation history to a given checkpoint promptIndex.
   * Called after rewind — removes user_input/llm_response/tool_result events
   * that come after the target checkpoint, then writes a rewound event.
   * Returns the number of events removed.
   *
   * `revertedFiles` is recorded on that rewound event. The writer cannot
   * discover it — reverting is the SessionRewinder's job and the file_snapshot
   * events proving it are what this call truncates away — so the caller must
   * pass it or the record is lost for good.
   */
  truncateToCheckpoint(promptIndex: number, revertedFiles?: readonly string[]): Promise<number>;
  /**
   * The events the newest rewind cut, if it can still be redone (no prompt
   * since, journal prefix unchanged). Reads only. Optional: writers without
   * a journal file have no redo.
   */
  peekRedo?(): Promise<{ toPromptIndex: number; events: SessionEvent[] } | null>;
  /** Put the newest rewind's events back. Returns their count, or null. */
  restoreRedo?(): Promise<number | null>;
  /**
   * Clear the session transcript file, resetting the on-disk history.
   * Called by /clear to wipe chat history from persistent storage.
   */
  clearSession(): Promise<void>;
  /**
   * Idea #1 from IDEAS.md — Stateful Session Recovery.
   *
   * Writes an `in_flight_start` event at the current point in the
   * log. The agent loop should call this at the start of every
   * long-running operation (an iteration, a tool execution, a
   * streaming LLM call) so that a crashed process leaves a
   * visible "what was I doing?" marker. Pair with
   * `clearInFlightMarker` on clean shutdown.
   *
   * The `context` string is surfaced verbatim by
   * `SessionRecovery.detectStale` and the `/resume --incomplete`
   * CLI command, so prefer something a human can read at a glance:
   *   "iteration 14 / tool: read / id: tu-7"
   */
  writeInFlightMarker(context: string): Promise<void>;
  /**
   * Writes an `in_flight_end` event. Call on every clean exit
   * point (after a successful iteration, after the user issues
   * /exit, after a graceful SIGINT, etc.). The `reason` is
   * surfaced in the session log for postmortem review.
   */
  clearInFlightMarker(reason: 'clean' | 'aborted' | 'recovered'): Promise<void>;
}
