import type { Message } from './messages.js';
import type { Usage } from './provider.js';
import type { SessionEvent } from './session-events.js';
import type { SessionPermissionOverride } from './session-permission-override.js';
import type { SessionWriter } from './session-storage.js';

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
  /**
   * Absolute checkout directory the session runs in. Differs from the
   * project's identity root in a linked git worktree, whose sessions share
   * the main checkout's store (see `canonicalProjectRoot`).
   */
  checkout?: string | undefined;
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
  /** The base commit of the checkout plus every non-ignored changed/untracked path. */
  coverage: WorkspaceCheckpointCoverage;
}

/** Which version control the checkpoint's base commit belongs to. */
export type WorkspaceCheckpointCoverage =
  | 'git-head-plus-dirty'
  | 'jj-head-plus-dirty'
  | 'hg-head-plus-dirty';

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
  /**
   * Parent session id when this session was created by fork(), taken from
   * its `session_forked` event. Pickers nest forks under their parent.
   */
  forkedFrom?: string | undefined;
  /**
   * Checkout directory the session last ran in (from `session_start` /
   * `session_resumed`). Sessions of every git worktree of a repository share
   * one store; pickers use this to tell them apart.
   */
  checkout?: string | undefined;
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
  /** Disk tier: live JSONL (`hot`) or gzip archive (`cold`). */
  storageState?: 'hot' | 'cold' | undefined;
  codec?: 'gzip' | undefined;
  archivedAt?: string | undefined;
  uncompressedBytes?: number | undefined;
  compressedBytes?: number | undefined;
}

export interface SessionData {
  metadata: SessionMetadata;
  events: SessionEvent[];
  messages: Message[];
  usage: Usage;
  /** Latest persisted session subagent policy, retained even when old events are evicted. */
  subagentsAllowed?: boolean | undefined;
  /** Companion half of the same policy event (`subagent_policy.companions`). */
  subagentCompanionsAllowed?: boolean | undefined;
  /** Latest `/permissions allow|deny` list, retained even when old events are evicted. */
  permissionOverrides?: SessionPermissionOverride[] | undefined;
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
  /**
   * Fork from just before the checkpoint's prompt rather than just after it,
   * leaving that prompt out so it can be sent again or changed. The prompt is
   * recorded before its checkpoint, so a plain checkpoint fork carries it.
   */
  beforeCheckpointPrompt?: boolean | undefined;
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
export type { SessionEvent, SessionEventAttribution } from './session-events.js';
export type {
  SessionArchiveIdleResult,
  SessionArchiveResult,
  SessionLoadProgress,
  SessionMoveResult,
  SessionMoveTarget,
  SessionStoragePolicy,
  SessionStore,
  SessionWriter,
} from './session-storage.js';
