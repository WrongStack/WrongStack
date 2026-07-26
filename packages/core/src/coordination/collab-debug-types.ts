export enum DirectorAlertLevel {
  /** The agent is still making progress but has hit a soft budget limit. */
  WARNING = 'warning',
  /** The agent has hit a hard limit and the session cannot continue. */
  CRITICAL = 'critical',
  /** The Director has decided to cancel the session (user request or policy). */
  CANCELLED = 'cancelled',
}

export interface DirectorAlert {
  sessionId: string;
  subagentId: string;
  role: string;
  level: DirectorAlertLevel;
  /** Human-readable message for UI/logs */
  message: string;
  /** Budget kind that triggered this alert, if any */
  budgetKind?:
    | 'timeout'
    | 'idle_timeout'
    | 'iterations'
    | 'tool_calls'
    | 'tokens'
    | 'cost'
    | undefined;
  /** Elapsed ms at time of alert */
  elapsedMs?: number | undefined;
  /** Limit that was hit */
  limit?: number | undefined;
  /** /btw notes the director has collected (may be empty) */
  btwNotes?: string[] | undefined;
}

/**
 * Immutable snapshot of target files at the start of a collab session.
 * All agents in the session read from this snapshot — they see the same baseline.
 */
export interface SharedFileSnapshot {
  id: string;
  createdAt: string;
  files: SharedFileEntry[];
}

export interface SharedFileEntry {
  path: string;
  content: string;
  language?: string | undefined;
  snapshotMtimeMs?: number | undefined;
  snapshotSizeBytes?: number | undefined;
}

/**
 * Bug finding emitted by BugHunter and consumed by RefactorPlanner + Critic.
 */
export interface BugFinding {
  id: string;
  type: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  location: { file: string; line: number };
  description: string;
  suggestedFix?: string | undefined;
}

/**
 * Refactoring plan emitted by RefactorPlanner, consuming BugFinding(s).
 */
export interface RefactorPlan {
  id: string;
  basedOnBugIds: string[];
  phases: RefactorPhase[];
  riskScore: 'low' | 'medium' | 'high';
  estimatedChangeCount: number;
  rollbackStrategy: string;
}

/** One phase within a refactor plan. */
export interface RefactorPhase {
  number: number;
  title: string;
  tasks: string[];
  risk: 'low' | 'medium' | 'high';
}

/**
 * Critic evaluation of a bug finding or refactor plan.
 */
export interface CriticEvaluation {
  id: string;
  subjectType: 'bug_finding' | 'refactor_plan';
  subjectId: string;
  score: number; // 0-10
  verdict: 'approve' | 'needs_revision' | 'reject';
  strengths: string[];
  weaknesses: string[];
  concerns: CriticConcern[];
}

export interface CriticConcern {
  description: string;
  location?: { file: string | undefined; line: number };
  severity: 'blocking' | 'advisory';
}

/**
 * Full structured report produced when a CollabSession resolves.
 */
export interface CollabDebugReport {
  sessionId: string;
  startedAt: string;
  completedAt: string;
  targetPaths: string[];
  /** How the session ended. 'completed' = all agents finished normally.
   * 'cancelled' = Director called cancelCollabSession().
   * 'timeout' = session-level timeout elapsed before all agents finished.
   * 'critical_alert' = Director escalated a warning to a cancel decision.
   */
  disposition: 'completed' | 'cancelled' | 'timeout' | 'critical_alert';
  bugs: BugFinding[];
  refactorPlans: RefactorPlan[];
  evaluations: CriticEvaluation[];
  /** Alerts that were raised during the session (may be empty). */
  alerts: DirectorAlert[];
  /** Files modified after the initial static snapshot was captured. */
  snapshotWarnings?: string[] | undefined;
  /** Overall verdict from the Critic across all evaluated subjects. */
  overallVerdict: 'approve' | 'needs_revision' | 'reject';
  /** Markdown-formatted summary for the director's context window. */
  summary: string;
}

/**
 * Per-agent budget configuration for collab sessions.
 * Allows the caller (Director) to control the exact limits instead of
 * using hard-coded defaults that may not match the director's policy.
 */
export interface CollabBudgetConfig {
  maxIterations: number;
  maxToolCalls: number;
  timeoutMs: number;
}

/**
 * Budget overrides for specific roles in a collab session.
 * When a role is not present in the map, the default budget is used.
 */
export type CollabBudgetOverrides = Partial<Record<string, CollabBudgetConfig>>;

// ---------------------------------------------------------------------------
// Event payload types (what gets put on the FleetBus)
// ---------------------------------------------------------------------------

export interface BugFoundPayload {
  finding: BugFinding;
}

export interface RefactorPlanPayload {
  plan: RefactorPlan;
}

export interface CriticEvaluationPayload {
  evaluation: CriticEvaluation;
}

/**
 * Emitted by a collab agent when it hits a soft budget limit.
 * The Director's fleet handler receives this and calls collabAlert().
 */
export interface CollabBudgetWarningPayload {
  sessionId: string;
  role: string;
  kind: 'timeout' | 'idle_timeout' | 'iterations' | 'tool_calls' | 'tokens' | 'cost';
  used: number;
  limit: number;
  timeoutMs?: number | undefined;
  elapsedMs: number;
}

/**
 * Emitted by the Director to cancel all agents in a collab session.
 * CollabSession listens for this and causes its agent pool to finish early.
 */
export interface DirectorCancelCollabPayload {
  sessionId: string;
  reason: string;
  cancelledAt: string;
}

// ---------------------------------------------------------------------------
// CollabSessionOptions — extends base with budget + alert callbacks
// ---------------------------------------------------------------------------

export interface CollabSessionOptions {
  /** Paths to scan — used to build the SharedFileSnapshot. */
  targetPaths: string[];
  /** Files already read and snapshot. When provided, snapshot is skipped. */
  prebuiltSnapshot?: SharedFileSnapshot | undefined;
  /** Max time to wait for the session to resolve (ms). Default: 10 min. */
  timeoutMs?: number | undefined;
  /**
   * Maximum number of files to include in the snapshot.
   * - If set explicitly: use this value (hard override).
   * - If `contextWindow` is set: calculate dynamically from estimated token budget.
   * - If neither: use `DEFAULT_MAX_TARGET_FILES` (30).
   */
  maxTargetFiles?: number | undefined;
  /**
   * Context window size (in tokens) of the model running the subagents.
   * When provided and `maxTargetFiles` is not set, the limit is computed
   * dynamically: `floor((contextWindow * 0.4) / AVG_TOKENS_PER_FILE)`.
   * If not provided, `DEFAULT_MAX_TARGET_FILES` is used as the fallback.
   */
  contextWindow?: number | undefined;
  /**
   * Budget overrides per role. When provided, these override the hard-coded
   * defaults so the Director can enforce fleet-wide budget policy.
   * Keys must match role names: 'bug-hunter', 'refactor-planner', 'critic'.
   */
  budgetOverrides?: CollabBudgetOverrides | undefined;
  /**
   * Called by the Director when a collab agent hits a soft budget limit.
   * The Director uses this to decide whether to cancel the session or extend.
   * Return 'cancel' to stop the session immediately; 'extend' to continue
   * with the agent's proposed new limits; 'ignore' to let the default
   * auto-extend logic handle it.
   */
  onBudgetWarning?: ((alert: DirectorAlert) => 'cancel' | 'extend' | 'ignore') | undefined;
}

// ---------------------------------------------------------------------------
// CollabSession — coordinates the three-agent pipeline
// ---------------------------------------------------------------------------
