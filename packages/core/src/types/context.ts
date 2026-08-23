/**
 * AgentContext — the structural contract of the agent-run object.
 *
 * Dependency-leaf module (Roadmap 10A): imports ONLY from sibling `types/*`
 * modules. The concrete `Context` class (core/context.ts) implements this
 * interface; tsc enforces structural compatibility on every build, so the
 * interface cannot drift from the class silently.
 *
 * Why this exists: the CYCLE-12 type SCC was caused by `types/*.ts` and
 * `utils/*` modules importing the `Context` CLASS type back from
 * `core/context.ts`. Consumers below declare `AgentContext` instead — the
 * back-edge disappears while the class stays the single implementation.
 *
 * Scope (2026-08-23): only `types/compactor.ts` and `conversation-state.ts`
 * consume `AgentContext` today. Six back-edges on the `Context` class type
 * remain (`types/tool.ts`, `types/error-handler.ts`, `types/provider-runner.ts`,
 * `types/permission.ts`, `types/slash-command.ts`, `types/plugin.ts`) — they
 * require the full class surface (state, file-tracking, catalogTools) which
 * needs `ConversationState` resolved in this leaf first. Do not claim
 * acyclicity until those flip.
 *
 * Statics (`Context.MAX_MESSAGES`, `Context.MAX_MESSAGE_TOKENS`) are read
 * through the `messageLimits` accessor so runtime subclass overrides keep
 * working (the reason the old `ctx.constructor` cast existed) without any
 * consumer importing the class type.
 */
import type { ContextEvidenceState } from './context-evidence.js';
import type { ConversationStateApi } from './conversation-state.js';
import type { TextBlock } from './blocks.js';
import type { FileEventRecord } from './file-event-record.js';
import type { Message } from './messages.js';
import type { RunEnv } from './run-env.js';
import type { SessionWriter } from './session.js';
import type { SideEffect } from './side-effect.js';
import type { Tool } from './tool.js';

/** A single todo row projected to the model and the UI. */
export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string | undefined;
  /** When promoted from a plan item, stores the plan item's id. */
  promotedFromPlan?: string | undefined;
  /** When promoted from a task, stores the task's id. */
  promotedFromTask?: string | undefined;
  /** Durable Kanban owner when the todo row is a UI projection of a real card. */
  kanbanBoardId?: string | undefined;
  /** Durable Kanban card represented by this todo row. */
  kanbanTaskId?: string | undefined;
  /** Titles of the unfinished work this row waits on (board-derived). */
  blockedBy?: string[] | undefined;
}
// Roadmap 10A note: the original TodoItem JSDoc on blockedBy is preserved
// below from the class file; the projection must carry the *reason* a card
// is blocked — the board computes readiness on every mutation, and dropping
// it left blocked work indistinguishable from ready work on screen and in
// the model's context.

/** Conversation retention limits, honoring runtime subclass overrides. */
export interface ContextMessageLimits {
  readonly maxMessages: number;
  readonly maxMessageTokens: number;
}

/**
 * The conversation-facing surface of the run object. `RunEnv` covers the
 * set-once environment; this adds the mutable conversation state and the
 * hook tools rely on.
 */
export interface AgentContext extends RunEnv {
  messages: Message[];
  meta: Record<string, unknown>;
  todos: TodoItem[];
  toolAdjacencyDirty: boolean;
  systemPrompt: readonly TextBlock[];
  contextEvidence: ContextEvidenceState;
  /** Observable mutation wrapper; the concrete class satisfies this structurally. */
  readonly state: ConversationStateApi;
  registerAbortHook(fn: () => void | Promise<void>): () => void;
  /** Retention limits honoring runtime subclass overrides of the statics. */
  readonly messageLimits: ContextMessageLimits;
  /**
   * File-tracking surface (see the Context class for full semantics).
   * `readFiles` is the permission write-bypass source of truth — it must
   * NEVER contain files only touched by edit/write.
   */
  readFiles: Set<string>;
  /** Files written by edit/write this session (observability only). */
  writtenFiles: Set<string>;
  /** Last-known mtime per tracked path; permission + edit-staleness checks. */
  fileMtimes: Map<string, number>;
  /** sha-256 (hex) at last recorded read/write; authoritative staleness arbiter. */
  fileHashes: Map<string, string>;
  /**
   * Record a file observation. `source: 'write'` routes to writtenFiles;
   * 'user' (default) routes to readFiles. `contentHash`, when available,
   * becomes the authoritative staleness arbiter for later edits.
   */
  recordRead(
    absPath: string,
    mtimeMs: number,
    source?: 'user' | 'write',
    contentHash?: string,
  ): void;
  /** Tool instances visible to tool_search/catalog surfaces. */
  catalogTools: Tool[];
  /** Structured side-effect records for the current run (bounded, MAX_SIDE_EFFECTS). */
  sideEffects: SideEffect[];
  /** Tracked file events for the current session (bounded, MAX_FILE_EVENTS). */
  fileEvents: FileEventRecord[];
  /** When false (default), file tools reject paths outside projectRoot. */
  allowOutsideProjectRoot: boolean;
  /** Current kanban task ID; tools use this via recordFileEvent() for task scope. */
  currentKanbanTaskId: string | undefined;
  /** Current kanban board ID, paired with currentKanbanTaskId. */
  currentKanbanBoardId: string | undefined;
  /** Session-level trace ID for correlating storage events with agent iterations. */
  traceId: string | undefined;
  /** Logical provider request whose response produced the current tool calls. */
  activeLogicalRequestId: string | undefined;
  /** Content-addressed prompt composition for activeLogicalRequestId. */
  activePromptManifestId: string | undefined;
  /**
   * Session id pinned to the currently-executing run; event sites must
   * prefer this over session.id (see Context class for session-swap
   * rationale).
   */
  activeRunSessionId: string | undefined;
  /** Writer pinned alongside activeRunSessionId for run-scoped appends. */
  activeRunSessionWriter: SessionWriter | undefined;
  /**
   * Session id that events of the in-flight run must be stamped with:
   * run-pinned id when active, otherwise the live session id.
   */
  eventSessionId(): string;
}
