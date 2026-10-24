import type { ContentBlock } from './blocks.js';
import type { Message } from './messages.js';
import type { ProviderErrorBody, Usage } from './provider.js';
import type { FileSnapshot, WorkspaceCheckpointRef } from './session.js';
import type { SessionPermissionOverride } from './session-permission-override.js';
import type { ToolSettlement } from './tool.js';

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
  | {
      type: 'session_start';
      ts: string;
      id: string;
      model: string;
      provider: string;
      /** Checkout directory (a linked git worktree differs from the project root). */
      checkout?: string | undefined;
    }
  | {
      type: 'session_resumed';
      ts: string;
      id: string;
      model: string;
      provider: string;
      checkout?: string | undefined;
    }
  | {
      type: 'subagent_policy';
      ts: string;
      allowed: boolean;
      /** With `allowed: false`: the resident read-only companions still run. */
      companions?: boolean | undefined;
    }
  | {
      type: 'sandbox_audit';
      ts: string;
      /** Ring/bus event name: `sandbox.denied`, `sandbox.expansion_requested`, or `sandbox.expansion_outcome`. */
      event: string;
      tool: string;
      detail: Record<string, unknown>;
    }
  /**
   * The session's whole `/permissions allow|deny` list; the last event wins on
   * resume. Untrusted journal payload, normalized when read
   * (`security/session-permission-overrides.ts`).
   */
  | { type: 'permission_overrides'; ts: string; overrides: SessionPermissionOverride[] }
  /**
   * The leader changed (or, with `override: null`, reset) its OWN reasoning
   * effort via `leader_effort_set`. Last event wins on resume; untrusted
   * payload, normalized by `utils/leader-effort-override.ts`.
   */
  | { type: 'leader_effort'; ts: string; override: unknown }
  /**
   * Session-scoped subagent model plan (lanes + role overlay). Last event wins
   * on resume; see `coordination/session-subagent-models.ts`.
   */
  | {
      type: 'subagent_model_plan';
      ts: string;
      plan: unknown; // Untrusted journal payload; normalized by the coordination layer.
    }
  /**
   * The session was moved to another checkout: a git worktree of the same
   * repository (same store), or another project's store, in which case
   * `fromProject` names the project it came from. Readers take `checkout`
   * from the last of these the way they take it from `session_resumed`.
   */
  | { type: 'session_moved'; ts: string; checkout: string; fromProject?: string | undefined }
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
      /**
       * System-prompt identity variant this request ran under (`default`,
       * `lite`, `pro`, `scout`). Absent on journals written before it existed
       * and on hosts that keep no per-conversation variant.
       */
      systemVariant?: string | undefined;
    }
  | {
      type: 'enhance_usage';
      ts: string;
      usage: Usage;
      /**
       * Provider/model that served the refine pass, when known. Optional for
       * the same reason as on `llm_response`: journals written before these
       * fields existed omit them — a live writer always sets both.
       */
      provider?: string | undefined;
      model?: string | undefined;
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
  | {
      type: 'tool_result';
      ts: string;
      id: string;
      content: unknown;
      isError: boolean;
      /** Typed outcome; absent on journals written before it existed. */
      settlement?: ToolSettlement | undefined;
    }
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
      fullRequestTokensBefore?: number | undefined;
      fullRequestTokensAfter?: number | undefined;
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
      /** Stable delegation id (survives handoffs). Absent in older journals. */
      delegationId?: string | undefined;
      /** First attempt's task id. */
      taskId?: string | undefined;
      /** `background` (leader not blocked) or `wait` (blocking call). */
      mode?: 'background' | 'wait' | undefined;
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
      delegationId?: string | undefined;
      /** Terminal attempt's task id (the `roll_up` handle). */
      taskId?: string | undefined;
      /** Tool-level stop reason (`end_turn`, `aborted`, `host_timeout`, …). */
      stopReason?: string | undefined;
      /**
       * Bounded result text (structured report first, ≤4k chars). Lets a
       * resumed session re-deliver an undelivered background result after the
       * in-memory task registry is gone.
       */
      resultExcerpt?: string | undefined;
      mode?: 'background' | 'wait' | undefined;
    }
  | {
      /**
       * A background delegation's result reached the owning leader — folded
       * into its conversation by the agent loop (`via: 'loop'`) or already
       * received in-band through `await_tasks` (`via: 'await_tasks'`). On
       * resume, a `delegate_completed` without this is re-delivered.
       */
      type: 'delegation_delivered';
      ts: string;
      delegationId: string;
      deliveryId?: string | undefined;
      via?: 'loop' | 'await_tasks' | undefined;
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
      /** `server`: the backend itself answered with another model (see `provider.model_rerouted`). */
      reason: 'fallback' | 'user' | 'server';
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
