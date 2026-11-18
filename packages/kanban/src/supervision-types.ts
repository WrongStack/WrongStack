import type { KanbanAgentRunStatus, KanbanRetryPolicy } from './task-policy-types.js';
import type { KanbanVerificationBaseline } from './verification-types.js';

/**
 * How an agent assigned to a task obtains its primary model.
 *
 * - 'session'          — inherit whatever the session leader is running.
 * - 'fixed'            — a pinned provider/model.
 * - 'fallback_profile' — a named chain; chain[0] is the primary.
 * - 'tier'             — a named cost level ('budget' / 'standard' / 'premium').
 *                        Resolved through `modelTiers`, so the board stores the
 *                        INTENT ('run this cheaply') rather than a model id that
 *                        goes stale the moment the config changes.
 */
export type KanbanModelRoutingMode = 'session' | 'fixed' | 'fallback_profile' | 'tier';

/**
 * Persisted, inspectable execution route. Keeping the mode explicit avoids the
 * old ambiguity where an empty provider/model could mean either "use session"
 * or "configuration was forgotten".
 */
export interface KanbanExecutionRouting {
  mode: KanbanModelRoutingMode;
  provider?: string | undefined;
  model?: string | undefined;
  fallbackProfile?: string | undefined;
  fallbackModels?: string[] | undefined;
  /** Tier id when `mode` is 'tier'. Resolved at dispatch time against `modelTiers`. */
  tier?: string | undefined;
}

export type KanbanSupervisorMode = 'deterministic' | 'agentic';

/** Board-level policy for the quiet Kanban supervisor. */
export interface KanbanSupervisorConfig {
  /** Undefined config enables background management when the host supports dispatch. */
  enabled: boolean;
  /** Deterministic reconciliation is always performed; agentic also manages task quality. */
  mode: KanbanSupervisorMode;
  /** Audit cadence. Hosts clamp this to a safe minimum. */
  intervalMs?: number | undefined;
  /** Minimum delay between agentic anomaly reviews. */
  agentCooldownMs?: number | undefined;
  /** What to do with expired assignment leases. */
  recoveryMode?: KanbanRecoveryMode | undefined;
  /** Explicit model source for an agentic review. */
  routing?: KanbanExecutionRouting | undefined;
  /** Agent skills whose instructions must be injected into an agentic review. */
  skills?: string[] | undefined;
}

/** Durable task-manager ownership and review checkpoint; never copied to a new board. */
export interface KanbanManagementState {
  status?: 'running' | 'completed' | 'failed' | undefined;
  lease?:
    | {
        token: string;
        fingerprint: string;
        expiresAt: number;
        reviews?: Record<string, KanbanManagementReview>;
      }
    | undefined;
  reviews?: Record<string, KanbanManagementReview> | undefined;
  pendingTaskIds?: string[] | undefined;
  reviewedFingerprint?: string | undefined;
  /** Only receipt-validated completions may suppress future reviews. */
  reviewCoverageVersion?: 1 | undefined;
  lastAttemptAt?: number | undefined;
  lastCompletedAt?: number | undefined;
  summary?: string | undefined;
  error?: string | undefined;
}

export interface KanbanManagementReview {
  taskVersion: string;
  disposition: 'adequate' | 'enriched' | 'needs_leader';
  reason: string;
  reviewedAt: number;
  reviewedBy: string;
}

export type KanbanSupervisorStatus = 'disabled' | 'healthy' | 'attention' | 'running' | 'error';

/** Ephemeral runtime snapshot returned by the hosting surface. */
export interface KanbanSupervisorSnapshot {
  boardId: string;
  status: KanbanSupervisorStatus;
  mode: KanbanSupervisorMode;
  /** The automatically mirrored session board contains no tasks. */
  emptySessionMirror?: true | undefined;
  lastAuditAt?: string | undefined;
  lastAgentRunAt?: string | undefined;
  nextAuditAt?: string | undefined;
  reconciledTaskIds: string[];
  staleRecoveredTaskIds: string[];
  anomalyCount: number;
  summary?: string | undefined;
  error?: string | undefined;
}

/**
 * Sprint 2 recovery mode surface. `'auto'` defers per-task mode to
 * `selectRecoveryMode` based on the configured `RecoverStaleKanbanAssignmentsInput.policy`.
 * Explicit modes keep the historical semantics:
 *   - `'release'` clears the assignment and returns the task to ready/blocked.
 *   - `'retry'` increments attempt and re-queues unless `maxAttempts` is exhausted.
 *   - `'fail'` marks the assignment failed (retry budget exhausted).
 */
export type KanbanRecoveryMode = 'auto' | 'release' | 'retry' | 'fail';

/**
 * Optional policy that biases per-task recovery decisions. When present and
 * `RecoverStaleKanbanAssignmentsInput.mode === 'auto'`, each stale task gets
 * a per-task mode derived from its assignment metadata, the queue health
 * signal summary for the task's board, and the policy rules below.
 */
export interface KanbanRecoveryPolicy {
  /** When true, prefer `fail` over `retry` for tasks whose `costCeilingUsd` is set. */
  failWhenCostCeilingSet?: boolean | undefined;
  /** When set, prefer `release` for tasks whose `lastFailureKind` matches any of these. */
  releaseOnFailureKinds?: string[] | undefined;
  /** When true, also `release` if the heartbeat-due signal mentions this task. Default: false. */
  releaseOnHeartbeatDue?: boolean | undefined;
  /** Incremental/exponential/off hint returned for cost boundary diagnostics. */
  retryPolicyOverride?: KanbanRetryPolicy | undefined;
}

export interface KanbanAgentAssignment {
  agentId?: string | undefined;
  name?: string | undefined;
  role?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  /** Explicit source used to resolve provider/model for this run. */
  modelRouting?: KanbanModelRoutingMode | undefined;
  fallbackProfile?: string | undefined;
  fallbackModels?: string[] | undefined;
  /**
   * Named cost level when `modelRouting` is 'tier'. Storing the level rather
   * than a resolved model id keeps a queued task correct across config edits.
   */
  tier?: string | undefined;
  /** Agentic skills that are force-loaded into the worker prompt. */
  skills?: string[] | undefined;
  tools?: string[] | undefined;
  allowedCapabilities?: string[] | undefined;
  status: KanbanAgentRunStatus;
  dispatchedAt?: string | undefined;
  completedAt?: string | undefined;
  leaseId?: string | undefined;
  /** Captured before this attempt starts editing; reused by completion verification. */
  verificationBaseline?: KanbanVerificationBaseline | undefined;
  claimedAt?: string | undefined;
  heartbeatAt?: string | undefined;
  leaseExpiresAt?: string | undefined;
  attempt?: number | undefined;
  maxAttempts?: number | undefined;
  /** Sprint 2: cost ceiling for this assignment in USD; 0/undefined means unbounded. */
  costCeilingUsd?: number | undefined;
  /** Sprint 2: which retry strategy the recovery router should follow. */
  retryPolicy?: KanbanRetryPolicy | undefined;
  /** Sprint 2: last failure kind observed by the worker, used by routing hints. */
  lastFailureKind?: string | undefined;
  subagentId?: string | undefined;
  runTaskId?: string | undefined;
  lastResult?: string | undefined;
  error?: string | undefined;
}
