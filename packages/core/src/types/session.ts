import type { ContentBlock } from './blocks.js';
import type { Message } from './messages.js';
import type { Usage } from './provider.js';

export interface SessionMetadata {
  id: string;
  title?: string | undefined;
  model?: string | undefined;
  provider?: string | undefined;
  startedAt: string;
  endedAt?: string | undefined;
  /** Set when a session is closed with open tool calls — used to restore pending state on resume. */
  pendingToolUses?: string[] | undefined;
}

/**
 * SessionEvent — per-session persistent JSONL audit + reconstruct log.
 *
 * ## Two-Tier Model (see Config.session.auditLevel)
 *
 * **Core Reconstruct Set** (always persisted, minimal & reliable):
 * - `session_start`, `session_resumed`, `user_input`, `llm_response`, `tool_result`
 * - `checkpoint`, `file_snapshot`, `rewound`
 * - `in_flight_start` / `in_flight_end`, `session_end`
 *
 * These events are **required** for correct resume, rewind, crash recovery
 * and conversation replay. They are written regardless of auditLevel.
 *
 * **Audit Detail Set** (controlled by `session.auditLevel`):
 * - `llm_request` (lightweight by default)
 * - `tool_use`, `tool_call_start`/`tool_call_end`
 * - `compaction`, `error`, `message_truncated`, provider retries, etc.
 *
 * When `auditLevel: "minimal"` only Core Reconstruct events are guaranteed.
 * `"standard"` (default) adds the most valuable lightweight audit events.
 * `"full"` enables heavier payloads (may be stored in a sidecar replay log).
 *
 * ## Guarantees
 * - All appends are best-effort. A failed write logs a throttled warning but
 *   never aborts the agent loop.
 * - Sensitive content in `user_input` and `llm_response` is passed through
 *   the configured SecretScrubber before being written or summarized.
 * - The log is append-only JSONL. Individual lines may be malformed after
 *   hard crashes; `DefaultSessionStore.load()` silently skips bad lines.
 *
 * ## Location (source of truth: resolveWstackPaths)
 * ~/.wrongstack/projects/<sha256(projectRoot).slice(0,12)>/sessions/<date>/sess_<ULID>.jsonl
 *
 * The only files that live inside the project tree are the committed
 * `.wrongstack/AGENTS.md` and `.wrongstack/skills/`.
 */
export type SessionEvent =
  | { type: 'session_start'; ts: string; id: string; model: string; provider: string }
  | { type: 'session_resumed'; ts: string; id: string; model: string; provider: string }
  | { type: 'user_input'; ts: string; content: string | ContentBlock[] }
  | {
      type: 'llm_request';
      ts: string;
      model: string;
      messageCount: number;
      /** Estimated total input tokens for this request (messages + tools + system). */
      estimatedInputTokens?: number | undefined;
      /** Number of tools offered to the model in this request. */
      toolCount?: number | undefined;
    }
  | {
      type: 'llm_response';
      ts: string;
      content: ContentBlock[];
      stopReason: string;
      usage: Usage;
    }
  | { type: 'tool_use'; ts: string; name: string; id: string; input: unknown }
  | { type: 'tool_result'; ts: string; id: string; content: unknown; isError: boolean }
  | {
      type: 'compaction';
      ts: string;
      before: number;
      after: number;
      /** Pressure level that triggered the compaction. */
      level?: 'warn' | 'soft' | 'hard' | undefined;
      aggressive?: boolean | undefined;
      /** Summary of token savings per phase (elision, summary, selective). */
      reductions?: Array<{ phase: string; saved: number }>;
      /** Context budget snapshot used to trigger this compaction. */
      budget?: {
        maxContext: number;
        inputTokens: number;
        availableInputTokens: number;
        remainingInputTokens: number;
        reservedOutputTokens: number;
        reservedSafetyTokens: number;
        load: number;
        overflowTokens: number;
      } | undefined;
      /** Adaptive trigger signals observed alongside token pressure. */
      signals?: { repeatedReadCount?: number | undefined } | undefined;
      /**
       * Lossless digest of the range collapsed during this compaction (text
       * content preserved; raw tool I/O omitted). Captures *what* was collapsed
       * for forensics. May be truncated for log size. Absent when nothing was
       * collapsed (e.g. elision-only passes).
       */
      digest?: string | undefined;
    }
  | { type: 'error'; ts: string; message: string; phase: string }
  | { type: 'session_end'; ts: string; usage: Usage; pendingToolUses?: string[] | undefined }
  | { type: 'mode_changed'; ts: string; from: string; to: string }
  | { type: 'task_created'; ts: string; taskId: string; title: string }
  | { type: 'task_updated'; ts: string; taskId: string; status: string }
  | { type: 'task_completed'; ts: string; taskId: string; title: string }
  | { type: 'task_failed'; ts: string; taskId: string; title: string; error: string }
  | { type: 'agent_spawned'; ts: string; agentId: string; role: string }
  | { type: 'agent_stopped'; ts: string; agentId: string }
  | { type: 'agent_error'; ts: string; agentId: string; error: string }
  | { type: 'spec_parsed'; ts: string; specId: string; title: string; completeness: number }
  | { type: 'spec_analyzed'; ts: string; specId: string; gaps: string[] }
  | { type: 'skill_activated'; ts: string; skillName: string }
  | { type: 'skill_deactivated'; ts: string; skillName: string }
  | { type: 'tool_call_start'; ts: string; name: string; id: string; input: unknown }
  | {
      type: 'tool_call_end';
      ts: string;
      name: string;
      id: string;
      durationMs: number;
      /** Legacy field kept for backward compatibility. Prefer outputBytes. */
      outputSize: number;
      ok?: boolean | undefined;
      outputBytes?: number | undefined;
      outputTokens?: number | undefined;
      outputLines?: number | undefined;
    }
  | {
      /** Lightweight sampled progress from Tool.executeStream (only at auditLevel 'full'). */
      type: 'tool_progress';
      ts: string;
      name: string;
      id: string;
      event: {
        type: 'log' | 'warning' | 'metric' | 'file_changed' | 'partial_output';
        text?: string | undefined;
        data?: Record<string, unknown>;
      };
    }
  | { type: 'message_truncated'; ts: string; before: number; after: number }
  | {
      type: 'provider_retry';
      ts: string;
      providerId: string;
      attempt: number;
      delayMs: number;
      status?: number | undefined;
      description: string;
    }
  | {
      type: 'provider_error';
      ts: string;
      providerId: string;
      status?: number | undefined;
      description: string;
      retryable: boolean;
    }
  | { type: 'checkpoint'; ts: string; promptIndex: number; promptPreview: string }
  | { type: 'file_snapshot'; ts: string; promptIndex: number; files: FileSnapshot[] }
  | { type: 'rewound'; ts: string; toPromptIndex: number; revertedFiles: string[] }
  | {
      /**
       * Idea #1 from IDEAS.md — Stateful Session Recovery.
       *
       * Marks the start of "the process is currently working on this
       * point in the log". If the process exits cleanly, a matching
       * `in_flight_end` follows. If the process dies (crash, OOM,
       * machine sleep, SIGKILL) the marker is the last event in the
       * file — and `SessionRecovery.detectStale` flags the session
       * as resumable.
       *
       * `context` is a free-form description of the current
       * operation (e.g. "iteration 14 / tool: read / id: tu-7") so
       * the recovery UI can show "what was the agent doing when it
       * died?".
       */
      type: 'in_flight_start';
      ts: string;
      context: string;
    }
  | { type: 'in_flight_end'; ts: string; reason: 'clean' | 'aborted' | 'recovered' }
  | {
      /**
       * Structured side-effect audit record (P2 #5). Appended by tools that
       * perform non-filesystem mutations (bash, install, fetch) so /diag and
       * session replay can show what the agent did beyond file edits.
       * Unlike file_snapshot, this is purely for observability — no undo.
       */
      type: 'side_effect';
      ts: string;
      toolUseId: string;
      toolName: string;
      input: Record<string, unknown>;
      outcome?: string | undefined;
      risk: 'fs.write' | 'shell' | 'package' | 'network' | 'config';
    };

export type FileSnapshot = {
  path: string;
  action: 'created' | 'modified' | 'deleted';
  before: string | null;
  after: string | null;
};

export interface SessionSummary {
  id: string;
  title: string;
  startedAt: string;
  /** When the session finished (null if still running / crashed). */
  endedAt?: string | undefined;
  model: string;
  provider: string;
  tokenTotal: number;
  /** Number of LLM iterations (turn cycles). */
  iterationCount?: number | undefined;
  /** Number of tool calls executed. */
  toolCallCount?: number | undefined;
  /** Number of tool calls that returned an error. */
  toolErrorCount?: number | undefined;
  /** Number of files changed (created + modified + deleted). */
  fileChangeCount?: number | undefined;
  /** Per-tool breakdown: tool name → call count. */
  toolBreakdown?: Record<string, number>;
  /** Number of compaction events. */
  compactionCount?: number | undefined;
  /** Session outcome: 'completed', 'error', 'timeout', 'aborted', or undefined. */
  outcome?: 'completed' | 'error' | 'timeout' | 'aborted' | undefined;
}

export interface SessionData {
  metadata: SessionMetadata;
  events: SessionEvent[];
  messages: Message[];
  usage: Usage;
  /** Tool execution records extracted from `tool_call_end` events — used for TUI tool entry rendering on resume. */
  toolCallEnds: Array<{
    name: string;
    id: string;
    durationMs: number;
    ok: boolean;
    outputBytes?: number | undefined;
    outputTokens?: number | undefined;
    outputLines?: number | undefined;
  }>;
}

export interface ResumedSession {
  writer: SessionWriter;
  data: SessionData;
}

export interface SessionStore {
  create(meta: Omit<SessionMetadata, 'startedAt'>): Promise<SessionWriter>;
  load(id: string): Promise<SessionData>;
  /**
   * Open an existing session for append, returning both a writer that
   * continues writing to the same JSONL file and the replayed state
   * (messages + usage) so the caller can hydrate a Context. A
   * `session_resumed` marker is appended for audit.
   */
  resume(id: string): Promise<ResumedSession>;
  list(limit?: number): Promise<SessionSummary[]>;
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
   * Sessions referenced by active.json are never pruned.
   */
  prune(maxAgeDays?: number): Promise<number>;
  /**
   * Rebuild the session index from disk. Scans all session directories,
   * computes summaries, and writes a fresh _index.jsonl. Returns the
   * number of sessions indexed.
   */
  rebuildIndex?(): Promise<number>;
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
  /**
   * Session-level trace ID for correlating storage events with agent
   * iterations in observability pipelines. Generated once at Context
   * creation time and stored here so storage operations can include it
   * in `storage.*` events even though the store has no direct handle
   * on the Context.
   */
  traceId?: string | undefined;
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
   * Idempotent — safe to call even when the buffer is empty.
   */
  flush(): Promise<void>;
  close(): Promise<void>;
  /**
   * Register a file change for later snapshotting.
   * Called by write/edit/delete tools to track pending changes.
   */
  recordFileChange(input: { path: string; action: 'created' | 'modified' | 'deleted'; before: string | null; after: string | null }): void;
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
  writeFileSnapshot(promptIndex: number, files: import('./session.js').FileSnapshot[]): Promise<void>;
  /**
   * Truncate conversation history to a given checkpoint promptIndex.
   * Called after rewind — removes user_input/llm_response/tool_result events
   * that come after the target checkpoint, then writes a rewound event.
   * Returns the number of events removed.
   */
  truncateToCheckpoint(promptIndex: number): Promise<number>;
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
