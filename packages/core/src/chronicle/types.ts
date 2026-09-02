/** Schema version for the first durable WrongStack Chronicle event envelope. */
export const CHRONICLE_SCHEMA_VERSION = 1 as const;

export type ChronicleOutcome =
  | 'started'
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'denied'
  | 'abandoned'
  | 'unknown';

/** Stable identities used to project one event into global and project views. */
export interface ChronicleScope {
  installationId: string;
  machineId: string;
  projectId?: string | undefined;
  repositoryId?: string | undefined;
  workspaceId?: string | undefined;
  worktreeId?: string | undefined;
  sessionId?: string | undefined;
  turnId?: string | undefined;
  iterationId?: string | undefined;
  agentId?: string | undefined;
  goalId?: string | undefined;
  planId?: string | undefined;
  taskId?: string | undefined;
  kanbanBoardId?: string | undefined;
}

export interface ChronicleCorrelation {
  traceId: string;
  spanId: string;
  parentSpanId?: string | undefined;
  logicalRequestId?: string | undefined;
  /** Content-addressed identity of the exact provider-visible prompt composition. */
  promptManifestId?: string | undefined;
  attemptId?: string | undefined;
  toolCallId?: string | undefined;
}

export interface ChronicleRuntimeIdentity {
  providerId?: string | undefined;
  modelId?: string | undefined;
  modelRevision?: string | undefined;
  processId?: number | undefined;
  parentProcessId?: number | undefined;
}

export interface ChronicleResourceRef {
  kind:
    | 'file'
    | 'symbol'
    | 'memory'
    | 'task'
    | 'kanban'
    | 'process'
    | 'network'
    | 'artifact'
    | 'other';
  id: string;
  path?: string | undefined;
  lineStart?: number | undefined;
  lineEnd?: number | undefined;
  contentHashBefore?: string | undefined;
  contentHashAfter?: string | undefined;
}

export interface ChronicleEventInput {
  eventType: string;
  scope: ChronicleScope;
  correlation: ChronicleCorrelation;
  runtime?: ChronicleRuntimeIdentity | undefined;
  resource?: ChronicleResourceRef | undefined;
  outcome?: ChronicleOutcome | undefined;
  durationNs?: string | undefined;
  occurredAt?: string | undefined;
  monotonicNs?: string | undefined;
  attributes?: Record<string, unknown> | undefined;
  tags?: Record<string, string> | undefined;
}

/**
 * Lossless durable envelope. All wall-clock timestamps are UTC ISO-8601;
 * monotonicNs is used for elapsed-time ordering inside one process.
 */
export interface ChronicleEvent extends ChronicleEventInput {
  schemaVersion: typeof CHRONICLE_SCHEMA_VERSION;
  eventId: string;
  observedAt: string;
  persistedAt: string;
  sequence: number;
  previousHash: string;
  hash: string;
}

export type ChronicleVerifyResult =
  | { ok: true; entries: number; lastSequence: number; lastHash: string }
  | { ok: false; entries: number; brokenAt: number; reason: string };
