/** Filesystem activity emitted by project watchers and deterministic workers. */
export interface FileEventMap {
  'file.activity': {
    filePath: string;
    operation: 'read' | 'write' | 'edit' | 'delete' | 'rename';
    phase: 'started' | 'completed' | 'changed';
    source: 'tool' | 'editor' | 'deterministic' | 'watcher' | 'external';
    at: number;
    sessionId?: string | undefined;
    traceId?: string | undefined;
    agentId?: string | undefined;
    agentName?: string | undefined;
    toolUseId?: string | undefined;
    toolName?: string | undefined;
    line?: number | undefined;
    endLine?: number | undefined;
  };
  /**
   * Comprehensive file operation event with full session, provider/model,
   * agent, scope, and kanban task metadata. Emitted by `Context.recordFileEvent()`
   * on every tool-initiated file operation for durable audit and live observability.
   * The same data is also persisted as a `file_event` session JSONL event.
   */
  'file.event': {
    /** Low-level filesystem action */
    operation: 'create' | 'read' | 'update' | 'delete' | 'rename';
    /** Project-relative file path */
    filePath: string;
    /** Absolute file path */
    absPath: string;
    /** Session identifier */
    sessionId: string;
    /** Agent identifier */
    agentId: string;
    /** Human-readable agent name */
    agentName: string;
    /** LLM provider id */
    provider: string;
    /** LLM model id */
    model: string;
    /** Logical provider request that produced the mutating tool call. */
    logicalRequestId?: string | undefined;
    /** Content-addressed provider-visible prompt identity. */
    promptManifestId?: string | undefined;
    /** Strength of the prompt-to-file attribution edge. */
    provenanceConfidence?: 'explicit' | 'correlated' | 'inferred' | 'unknown' | undefined;
    /** Tool name */
    toolName: string;
    /** Tool-use block correlation ID */
    toolUseId: string;
    /** Execution scope */
    scope: 'project' | 'session' | 'task';
    /** Associated kanban task ID (only when scope === 'task') */
    taskId?: string | undefined;
    /** Associated kanban board ID (only when scope === 'task') */
    boardId?: string | undefined;
    /** Owning orchestration run, when the task belongs to one. */
    runId?: string | undefined;
    /** ISO 8601 timestamp */
    timestamp: string;
    /** Optional wall-clock execution duration in ms */
    durationMs?: number | undefined;
    /** File size in bytes */
    fileSize?: number | undefined;
    /** Number of lines involved */
    lines?: number | undefined;
    /** Bytes transferred */
    bytes?: number | undefined;
  };
  /**
   * Codebase index finished a run (startup or incremental). WebUI clears
   * CodeMap graph caches and may force-refresh the open atlas scope.
   */
  'codemap.index_updated': {
    at: number;
    ready: boolean;
    reason: 'index_complete';
  };
}
