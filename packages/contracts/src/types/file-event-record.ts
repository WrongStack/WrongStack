/**
 * FileEventRecord — structured record for every file operation in a session.
 *
 * Captures all relevant context for each filesystem interaction: which
 * session, agent, provider/model, scope, and kanban task were active when
 * the operation occurred. Every tool call that touches a file emits one of
 * these records (via `file_event` session JSONL events) for durable audit.
 * The same data shape is also available as the `file.event` EventBus event
 * payload for live observability subscribers.
 *
 * ## Fields
 *
 * - `operation`: The low-level filesystem action performed.
 * - `filePath` / `absPath`: Project-relative and absolute paths.
 * - `sessionId`, `agentId`, `agentName`: Who performed the operation.
 * - `provider`, `model`: Which LLM provider/model was in use.
 * - `toolName`, `toolUseId`: Which tool and tool-use block triggered it.
 * - `scope`: Execution context — `'project'` (global project scope),
 *   `'session'` (current session), or `'task'` (associated with a kanban task).
 * - `taskId`, `boardId`: Associated kanban task/board when `scope === 'task'`.
 * - `timestamp`: ISO 8601 string.
 * - `durationMs`: Wall-clock execution time.
 * - `fileSize`, `lines`, `bytes`: Operational metrics.
 */
export interface FileEventRecord {
  /** Low-level filesystem action */
  operation: 'create' | 'read' | 'update' | 'delete' | 'rename';
  /** Project-relative file path */
  filePath: string;
  /** Absolute file path on disk */
  absPath: string;

  /** Session identifier */
  sessionId: string;
  /** Agent identifier performing the operation */
  agentId: string;
  /** Human-readable agent name */
  agentName: string;

  /** LLM provider id (e.g. "anthropic", "openai") */
  provider: string;
  /** LLM model id (e.g. "claude-sonnet-4-20250514") */
  model: string;
  /** Logical provider request that produced the mutating tool call. */
  logicalRequestId?: string | undefined;
  /** Content-addressed provider-visible prompt identity. */
  promptManifestId?: string | undefined;
  /** Strength of the prompt-to-file attribution edge. */
  provenanceConfidence: 'explicit' | 'correlated' | 'inferred' | 'unknown';

  /** Tool that performed the operation (e.g. "read", "write", "edit") */
  toolName: string;
  /** Tool-use block correlation ID for pairing start/end */
  toolUseId: string;

  /**
   * Execution scope.
   * - `'project'`: Global project-level operation (e.g. indexing, watcher).
   * - `'session'`: Ordinary session-scoped operation.
   * - `'task'`: Operation performed as part of a kanban task.
   */
  scope: 'project' | 'session' | 'task';

  /** Associated kanban task ID (only when scope === 'task') */
  taskId?: string | undefined;
  /** Associated kanban board ID (only when scope === 'task') */
  boardId?: string | undefined;

  /** ISO 8601 timestamp */
  timestamp: string;

  /** Optional wall-clock execution duration in milliseconds */
  durationMs?: number | undefined;
  /** File size in bytes at the time of operation */
  fileSize?: number | undefined;
  /** Number of lines read or written */
  lines?: number | undefined;
  /** Bytes transferred (read from disk or written to disk) */
  bytes?: number | undefined;
}
