/**
 * A board-local contract graph describes what a task optimizes, what it may
 * affect, what it must preserve, and which evidence proves those claims. It is
 * deliberately separate from the execution dependency DAG (`dependsOn`).
 */
export type KanbanContractNodeKind =
  | 'objective'
  | 'guardrail'
  | 'risk'
  | 'component'
  | 'artifact'
  | 'verification';

export type KanbanContractNodeState =
  | 'unknown'
  | 'active'
  | 'satisfied'
  | 'violated'
  | 'waived'
  | 'resolved';

export type KanbanContractEnforcement = 'blocking' | 'advisory' | 'informational';

export type KanbanContractGraphEnforcement = 'off' | 'advisory' | 'strict';

export type KanbanContractEdgeType =
  | 'targets'
  | 'affects'
  | 'must_preserve'
  | 'exposes'
  | 'verified_by'
  | 'conflicts_with'
  | 'derived_from'
  | 'relates_to';

export interface KanbanContractWaiver {
  actor: string;
  reason: string;
  at: string;
  expiresAt?: string | undefined;
}

export interface KanbanContractNode {
  id: string;
  /** Owning task. Cross-task edges may share its contract with other tasks. */
  taskId: string;
  kind: KanbanContractNodeKind;
  title: string;
  description?: string | undefined;
  enforcement: KanbanContractEnforcement;
  state: KanbanContractNodeState;
  /** Optional binding to an executable acceptance check on the owning task. */
  checkId?: string | undefined;
  /** Optional binding to a goal metric on the owning task. */
  metricId?: string | undefined;
  baseline?: string | number | undefined;
  threshold?: string | number | undefined;
  waiver?: KanbanContractWaiver | undefined;
  createdAt: string;
  updatedAt: string;
  createdBy?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface KanbanContractEdge {
  id: string;
  /** Node id or an implicit task endpoint formatted as `task:<taskId>`. */
  from: string;
  /** Node id or an implicit task endpoint formatted as `task:<taskId>`. */
  to: string;
  type: KanbanContractEdgeType;
  enforcement: KanbanContractEnforcement;
  rationale?: string | undefined;
  createdAt: string;
  createdBy?: string | undefined;
}

export interface KanbanContractGraph {
  version: 1;
  enforcement: KanbanContractGraphEnforcement;
  nodes: KanbanContractNode[];
  edges: KanbanContractEdge[];
  updatedAt: string;
}

export interface KanbanContractGraphIssue {
  code:
    | 'objective-missing'
    | 'guardrail-missing'
    | 'node-unresolved'
    | 'verification-missing'
    | 'conflict-unresolved'
    | 'binding-invalid'
    | 'waiver-invalid';
  nodeId?: string | undefined;
  edgeId?: string | undefined;
  message: string;
}

export interface KanbanContractGraphEvaluation {
  taskId: string;
  enforcement: KanbanContractGraphEnforcement;
  allowed: boolean;
  evaluatedNodeIds: string[];
  issues: KanbanContractGraphIssue[];
}

/**
 * Card-detail codes here must match what `validateRequiredCardDetails`
 * (manager/lifecycle.ts) enforces and what the queue classifier buckets on:
 * this is the gate `start_task` consults, and a rule missing from it means
 * `start_task` accepts a card the transition then throws out.
 * `queue-startability-agreement.test.ts` holds the three together.
 *
 * `task-due-date-missing` and `task-label-missing` are RETIRED — nothing emits
 * them since due dates and labels stopped being required. Kept in the union so
 * a stored or in-flight issue from an older build still type-checks.
 */
export type KanbanContractReadinessIssueCode =
  | 'managed-lifecycle-required'
  | 'task-not-found'
  | 'task-description-missing'
  | 'task-owner-missing'
  | 'task-child-tasks-missing'
  | 'task-due-date-missing'
  | 'task-label-missing'
  | 'success-criteria-missing'
  | 'strict-contract-required'
  | 'objective-missing'
  | 'guardrail-missing'
  | 'impact-node-missing'
  | 'risk-node-missing'
  | 'verification-node-missing'
  | 'evidence-binding-missing'
  | 'verification-link-missing';

export interface KanbanContractReadinessIssue {
  code: KanbanContractReadinessIssueCode;
  nodeId?: string | undefined;
  message: string;
}

/** Structural pre-implementation gate. Unlike completion evaluation, nodes may still be active. */
export interface KanbanContractReadinessEvaluation {
  taskId: string;
  ready: boolean;
  issues: KanbanContractReadinessIssue[];
}
