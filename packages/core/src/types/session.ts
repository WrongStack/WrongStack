import type { ContentBlock } from './blocks.js';
import type { Message } from './messages.js';
import type { ProviderErrorBody, Usage } from './provider.js';

export interface SessionMetadata {
  id: string;
  title?: string | undefined;
  model?: string | undefined;
  provider?: string | undefined;
  startedAt: string;
  endedAt?: string | undefined;
  /**
   * Tool calls the previous run had issued but not resolved when it closed,
   * as recorded on `session_end`.
   *
   * Diagnostic only. Resume does NOT restore pending state from this: it
   * derives the same fact from the replayed conversation
   * ({@link SessionData.pendingToolUseCount}), which also covers the crash
   * case where no `session_end` was ever written. Nothing re-executes these.
   */
  pendingToolUses?: string[] | undefined;
  /** Parent journal metadata when this session was created by fork(). */
  forkedFrom?:
    | {
        sessionId: string;
        checkpointPromptIndex?: number | undefined;
        checkpointHash: string;
        workspace: 'shared-current';
        workspaceCheckpointHash?: string | undefined;
      }
    | undefined;
}

/**
 * SessionEvent — per-session persistent JSONL audit + reconstruct log.
 *
 * ## Two-Tier Model (see Config.session.auditLevel)
 *
 * **Core Reconstruct Set** (always persisted, minimal & reliable):
 * - `session_start`, `session_resumed`, `session_forked`, `user_input`, `llm_response`, `tool_result`
 * - `message_appended`, `message_updated`, `messages_replaced` (exact conversation journal)
 * - `context_snapshot`, `checkpoint`, `file_snapshot`, `file_observation`, `rewound`
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
 * - Sensitive content in `user_input`, `llm_response`, and
 *   `context_snapshot` is passed through the configured SecretScrubber before
 *   being written or summarized.
 * - The log is append-only JSONL. Individual lines may be malformed after
 *   hard crashes; `DefaultSessionStore.load()` silently skips bad lines.
 *
 * ## Location (source of truth: resolveWstackPaths)
 * ~/.wrongstack/projects/<sha256(projectRoot).slice(0,12)>/sessions/<date>/sess_<ULID>.jsonl
 *
 * The only files that live inside the project tree are the committed
 * `.wrongstack/AGENTS.md` and `.wrongstack/skills/`.
 */
export type SessionEvent = SessionEventVariant & SessionEventAttribution;

/**
 * Attribution stamped onto a journal event by the WRITER, never by the
 * producer that built it.
 *
 * A leader's JSONL can carry events produced by its subagents: the
 * parent-interleaved writer (`createParentSubagentSessionWriter`) forwards a
 * subagent's appends into the leader's journal because that subagent has no
 * journal of its own. Without a stamp those appends are indistinguishable
 * from the leader's, so a transcript reader cannot say which agent ran which
 * tool. `withAgentAttribution` sets this at the writer boundary — the one
 * place that knows whose writer it is — so no emit site has to remember.
 *
 * Absent means "the session's own leader". Old journals have no stamp at all,
 * which reads the same way and is correct: they predate subagent interleaving
 * being attributable.
 */
export interface SessionEventAttribution {
  /** Subagent that produced this event; absent = the session's leader. */
  agentId?: string | undefined;
}

type SessionEventVariant =
  | { type: 'session_start'; ts: string; id: string; model: string; provider: string }
  | { type: 'session_resumed'; ts: string; id: string; model: string; provider: string }
  | {
      type: 'session_forked';
      ts: string;
      parentSessionId: string;
      parentCheckpointPromptIndex?: number | undefined;
      parentCheckpointHash: string;
      /** The child journal is isolated; filesystem state remains shared. */
      workspace: 'shared-current';
      workspaceCheckpointHash?: string | undefined;
    }
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
      /**
       * Model that produced this response and billed this `usage`.
       *
       * Optional because logs written before this field existed omit it —
       * never because a live writer may skip it. `usage` is the only place
       * token counts are journaled, so without these two fields the journal
       * cannot answer "which model burned these tokens": `session_start`
       * records only the model the session OPENED with (a mid-session switch
       * or a fallback rotation leaves it stale), and `llm_request` carries
       * `model` but no provider. Readers must still tolerate `undefined` and
       * fall back to the nearest preceding `llm_request` / `session_start`.
       */
      model?: string | undefined;
      /** Provider id that served this response. See {@link model}. */
      provider?: string | undefined;
    }
  | { type: 'tool_use'; ts: string; name: string; id: string; input: unknown }
  | { type: 'tool_result'; ts: string; id: string; content: unknown; isError: boolean }
  | {
      /**
       * Exact message appended to the live conversation. `version` lets the
       * loader distinguish this lossless journal from legacy inferred events.
       */
      type: 'message_appended';
      ts: string;
      version: 1;
      message: Message;
    }
  | {
      /** Exact replacement of one existing message (for folded mailbox/hook text). */
      type: 'message_updated';
      ts: string;
      version: 1;
      index: number;
      message: Message;
    }
  | {
      /** Exact full conversation after a rewrite such as repair or context management. */
      type: 'messages_replaced';
      ts: string;
      version: 1;
      messages: Message[];
      /**
       * Set by the loader when `messages` was dropped to bound memory — see
       * {@link SessionData} and `load-session-data.ts`. Carries the length the
       * payload had on disk. Absent on freshly emitted events.
       */
      messagesOmitted?: number;
    }
  | {
      /**
       * The oldest `count` messages were evicted from the front of the history.
       *
       * A delta rather than a `messages_replaced` snapshot, because eviction is
       * the one rewrite that repeats: once a long session reaches
       * `Context.MAX_MESSAGES`, *every* subsequent append overflows by one and
       * drops one. Emitting the surviving history each time made the journal
       * quadratic in session length — measured at 2.1 GB for one session whose
       * actual content was ~10 MB, and 17.9 GB across a 20 GB corpus. Replay
       * splices the same prefix off, so the reconstructed conversation is
       * identical to what the snapshot would have produced.
       */
      type: 'messages_dropped';
      ts: string;
      version: 1;
      count: number;
    }
  | {
      /**
       * Exact post-rewrite conversation state. Replay replaces all messages
       * reconstructed before this event, then continues applying later events.
       * Currently emitted after compaction.
       */
      type: 'context_snapshot';
      ts: string;
      reason: 'compaction';
      messages: Message[];
      /** See `messagesOmitted` on `messages_replaced`. */
      messagesOmitted?: number;
    }
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
      budget?:
        | {
            maxContext: number;
            inputTokens: number;
            availableInputTokens: number;
            remainingInputTokens: number;
            reservedOutputTokens: number;
            reservedSafetyTokens: number;
            load: number;
            overflowTokens: number;
          }
        | undefined;
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
  | {
      /**
       * Binds a spawned agent to the transcript it writes into.
       *
       * Separate from `agent_spawned` because the two facts are learned in
       * different places: the fleet layer emits `agent_spawned` once the
       * coordinator hands back an id, while the writer is built one layer
       * down in the subagent factory, which has no channel back to that emit
       * site. Threading one would have changed five signatures for a fact
       * that is naturally its own record — and would still be optional on
       * `agent_spawned`, since an agent running on the parent-interleaved
       * writer never gets a transcript of its own and emits no link at all.
       *
       * Readers join on `agentId` within the session.
       */
      type: 'agent_session_linked';
      ts: string;
      agentId: string;
      /** The subagent journal's own session id. */
      agentSessionId: string;
      /**
       * Absolute path of the subagent's JSONL at the time it was opened.
       * Absent for in-memory writers (tests, ephemeral runs), which have a
       * session id but no file.
       */
      transcriptPath?: string | undefined;
      provider?: string | undefined;
      model?: string | undefined;
      /** Set when this agent was spawned by another agent, not the leader. */
      parentAgentId?: string | undefined;
    }
  | {
      type: 'agent_stopped';
      ts: string;
      agentId: string;
      /** Why the agent ended. Absent in journals written before this field. */
      reason?: 'completed' | 'aborted' | 'failed' | 'evicted' | undefined;
      /** This agent's own cumulative spend, when the stopper knows it. */
      usage?: Usage | undefined;
    }
  | { type: 'agent_error'; ts: string; agentId: string; error: string }
  | {
      /**
       * A `delegate` tool call handing work to a subagent.
       *
       * Distinct from `agent_spawned`, which records that an agent exists.
       * This records that the LEADER stopped and waited on it, which is the
       * thing the transcript shows: every surface renders a delegation line
       * live (the TUI even suppresses the generic tool card in its favour),
       * and none of it reached disk — so a resumed session showed a gap where
       * minutes of delegated work had happened.
       */
      type: 'delegate_started';
      ts: string;
      /** Resolved roster role or free-form subagent name. */
      target: string;
      /** The instruction handed to the subagent. */
      task: string;
      subagentId?: string | undefined;
    }
  | {
      type: 'delegate_completed';
      ts: string;
      target: string;
      task: string;
      ok: boolean;
      /** `success` | `timeout` | `host_timeout` | `stopped` | … */
      status?: string | undefined;
      /** One-line human summary, as the live surfaces render it. */
      summary: string;
      durationMs: number;
      iterations: number;
      toolCalls: number;
      costUsd?: number | undefined;
      subagentId?: string | undefined;
    }
  | {
      /**
       * The loop detector acted on a repeating run.
       *
       * Only `action: 'cut'` is worth a record: a `steer` is an in-band nudge
       * the model absorbs, while a cut ENDS the turn — and without this the
       * run came back as a bare `max_iterations` with nothing saying why.
       */
      type: 'loop_detected';
      ts: string;
      /** Comma-separated tool names, or empty for a pure message loop. */
      tools: string;
      repeatCount: number;
      iteration: number;
      kind?: 'tool' | 'message' | 'mixed' | undefined;
      action?: 'steer' | 'cut' | undefined;
    }
  | {
      /**
       * The active provider/model changed mid-session.
       *
       * `reason: 'fallback'` is the automatic switch after a provider failure;
       * `'user'` is an explicit `/model` or UI change. Either way the rest of
       * the transcript was produced by a different model than the one
       * `session_start` names, and a reader with no record of the switch
       * attributes it all to the first one.
       */
      type: 'model_switched';
      ts: string;
      from?: { providerId: string; model: string } | undefined;
      to: { providerId: string; model: string };
      reason: 'fallback' | 'user';
      /** HTTP status that triggered an automatic fallback, when there was one. */
      status?: number | undefined;
    }
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
      /** Scrubbed raw provider error envelope/body for post-run diagnosis. */
      errorBody?: ProviderErrorBody | undefined;
    }
  | {
      type: 'provider_error';
      ts: string;
      providerId: string;
      status?: number | undefined;
      description: string;
      retryable: boolean;
      /** Scrubbed raw provider error envelope/body for post-run diagnosis. */
      errorBody?: ProviderErrorBody | undefined;
    }
  | {
      type: 'checkpoint';
      ts: string;
      promptIndex: number;
      promptPreview: string;
      /** Content-addressed Git HEAD + dirty/untracked workspace manifest. */
      workspaceCheckpoint?: WorkspaceCheckpointRef | undefined;
    }
  | { type: 'file_snapshot'; ts: string; promptIndex: number; files: FileSnapshot[] }
  | {
      /**
       * Hash of a file version observed by a tool. The latest observation per
       * path is revalidated when the session resumes so stale tool context is
       * surfaced to the model before it continues.
       */
      type: 'file_observation';
      ts: string;
      path: string;
      hash: string;
      mtimeMs: number;
      source: 'user' | 'write';
    }
  | { type: 'rewound'; ts: string; toPromptIndex: number; revertedFiles: string[] }
  | {
      /**
       * Idea #1 from IDEAS.md — Stateful Session Recovery.
       *
       * Marks the start of "the process is currently working on this
       * point in the log". If the process exits cleanly, a matching
       * `in_flight_end` follows. If the process dies (crash, OOM,
       * machine sleep, SIGKILL), ordinary request/response/tool events may
       * follow the start marker but no later lifecycle boundary closes it.
       * `SessionRecovery.detectStale` scans for that latest unmatched
       * lifecycle boundary and flags the session as resumable.
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
    }
  | {
      /**
       * Structured record for every file operation performed during the
       * session (create, read, update, delete, rename). Includes session,
       * provider/model, agent, tool, scope, and optional kanban task context.
       * Appended by `Context.recordFileEvent()` — fire-and-forget, never
       * blocks tool execution.
       */
      type: 'file_event';
      ts: string;
      operation: 'create' | 'read' | 'update' | 'delete' | 'rename';
      filePath: string;
      absPath: string;
      sessionId: string;
      agentId: string;
      agentName: string;
      provider: string;
      model: string;
      logicalRequestId?: string | undefined;
      promptManifestId?: string | undefined;
      provenanceConfidence?: 'explicit' | 'correlated' | 'inferred' | 'unknown' | undefined;
      toolName: string;
      toolUseId: string;
      scope: 'project' | 'session' | 'task';
      taskId?: string | undefined;
      boardId?: string | undefined;
      durationMs?: number | undefined;
      fileSize?: number | undefined;
      lines?: number | undefined;
      bytes?: number | undefined;
    };

export type FileSnapshot = {
  path: string;
  action: 'created' | 'modified' | 'deleted';
  before: string | null;
  after: string | null;
};

export interface WorkspaceCheckpointRef {
  manifestHash: string;
  baseHead: string;
  entryCount: number;
  unresolvedCount: number;
  capturedAt: string;
  /** Base Git tree plus every non-ignored changed/untracked path. */
  coverage: 'git-head-plus-dirty';
}

export interface WorkspaceMaterializationResult {
  targetRoot: string;
  writtenFiles: string[];
  deletedFiles: string[];
  errors: string[];
}

export type ResumeFileStatus = 'modified' | 'deleted' | 'unreadable' | 'outside_project';

export interface ResumeFileValidationEntry {
  /** Absolute path recorded by the original tool observation. */
  path: string;
  /** Timestamp of the latest observation that was checked. */
  observedAt: string;
  status: ResumeFileStatus;
  expectedHash: string;
  actualHash?: string | undefined;
  detail?: string | undefined;
}

export interface ResumeValidation {
  checkedAt: string;
  /** Number of distinct paths with a valid persisted observation. */
  checkedFileCount: number;
  /** Changed, missing, unreadable, or out-of-scope paths. */
  staleFiles: ResumeFileValidationEntry[];
}

export interface SessionSummary {
  id: string;
  title: string;
  /**
   * Optional user-supplied name for the session. Unlike {@link title} (which
   * is auto-derived from the first user message and overwritten on every
   * rebuild), `name` is set explicitly via {@link SessionStore.rename} and
   * persisted in the `.summary.json` sidecar and `_index.jsonl`. Listings
   * should prefer `name` over `title` when present; `title` remains the
   * fallback and stays in sync as the conversation evolves.
   */
  name?: string | undefined;
  startedAt: string;
  /** When the session finished (null if still running / crashed). */
  endedAt?: string | undefined;
  model: string;
  provider: string;
  tokenTotal: number;
  /** Latest meaningful activity timestamp. Used to order resumed sessions by recency. */
  lastActivityAt?: string | undefined;
  /** Number of persisted user + assistant conversation messages. */
  messageCount?: number | undefined;
  /** Compact preview of the latest user request, for session pickers and recovery prompts. */
  lastUserMessage?: string | undefined;
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
  /** Present on resume when the store is configured with a project root. */
  resumeValidation?: ResumeValidation | undefined;
  /**
   * Number of `tool_use` blocks in the reconstructed conversation that never
   * received a matching `tool_result` — i.e. tool calls the previous run left
   * in flight (crash/interrupt). Computed during replay BEFORE adjacency
   * repair strips them. `resume()` surfaces this as an informational notice so
   * the user/model know work was interrupted; the tools are NOT re-executed.
   *
   * Only present when at least one call was left open: **absent means none**,
   * never zero (see `load-session-data.ts`). It is also absent for
   * events-only loads, which reconstruct no messages to count. Read it as
   * `data.pendingToolUseCount ?? 0` rather than testing for `undefined`.
   */
  pendingToolUseCount?: number | undefined;
  /**
   * Number of oldest `events` dropped to stay inside the loader's retention
   * budget. Only set for sessions large enough to hit it (see
   * `DEFAULT_MAX_RETAINED_EVENT_BYTES`); absent means `events` is complete.
   * `messages` is never affected — it is replayed as lines arrive.
   */
  eventsDropped?: number | undefined;
}

export interface ResumedSession {
  writer: SessionWriter;
  data: SessionData;
}

export interface SessionForkOptions {
  /** Omit to fork the latest persisted event boundary. */
  checkpointPromptIndex?: number | undefined;
}

export interface ForkedSession {
  id: string;
  data: SessionData;
  parentSessionId: string;
  checkpointPromptIndex?: number | undefined;
  /** SHA-256 of the exact parent event prefix used to create this branch. */
  checkpointHash: string;
  /** Session history is isolated, but both branches still see the same files. */
  workspace: 'shared-current';
  /** Available for checkpoint forks captured by workspace-CAS-aware writers. */
  workspaceCheckpoint?: WorkspaceCheckpointRef | undefined;
}

export interface SessionStore {
  create(meta: Omit<SessionMetadata, 'startedAt'>): Promise<SessionWriter>;
  load(id: string): Promise<SessionData>;
  /**
   * Open an existing session for append, returning both a writer that
   * continues writing to the same JSONL file and the replayed state
   * (messages + usage) so the caller can hydrate a Context. A
   * `session_resumed` marker is appended for audit. New writers may also
   * persist the exact conversation journal (`message_*` events); legacy logs
   * containing only user/assistant/tool events remain replayable.
   */
  resume(id: string): Promise<ResumedSession>;
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
