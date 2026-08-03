import type { HqSubagentSummary } from './session.js';

export interface HqFleetSnapshotPayload {
  runId: string;
  activeSubagents: number;
  queuedTasks: number;
  completedTasks: number;
  failedTasks: number;
  totalCostUsd?: number;
  subagents: readonly HqSubagentSummary[];
}

export interface HqFleetEventPayload {
  runId: string;
  subagentId?: string;
  event: string;
  summary?: string;
  data?: unknown;
}

// ── Worktree lifecycle telemetry ────────────────────────────────────────────
//
// Goal allocates one git worktree per phase so parallelizable phases run
// isolated, then merges them back sequentially. These envelopes let HQ render
// live build phase swim-lanes / DAG across every connected machine. All fields
// are plain serializable data (the EventBus `worktree.*` payloads forwarded
// with the type tag added).

export type HqWorktreeEventKind =
  | 'allocated'
  | 'committed'
  | 'merged'
  | 'conflict'
  | 'released'
  | 'failed';

export interface HqWorktreeEventPayload {
  /** Which worktree lifecycle event this is (mirrors `worktree.<kind>`). */
  kind: HqWorktreeEventKind;
  handleId: string;
  ownerId: string;
  ownerLabel?: string;
  slug?: string;
  branch?: string;
  baseBranch?: string;
  /** For `committed`: diff stats. */
  insertions?: number;
  deletions?: number;
  files?: number;
  sha?: string;
  /** For `merged`: whether the merge was a squash. */
  squash?: boolean;
  /** For `conflict`: the list of conflicting files. */
  conflictFiles?: readonly string[];
  /** For `released`: whether the worktree was kept (true) or pruned (false). */
  kept?: boolean;
  /** For `failed`: the error message. */
  error?: string;
}

export interface HqWorklistSnapshotPayload {
  todos?: HqWorklistCounts;
  tasks?: HqWorklistCounts;
  plans?: HqWorklistCounts;
  activeItem?: string;
}

export interface HqWorklistCounts {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  failed?: number;
}

export interface HqFleetSummary {
  runId: string;
  projectId: string;
  clientId: string;
  activeSubagents: number;
  queuedTasks: number;
  completedTasks: number;
  failedTasks: number;
  totalCostUsd?: number;
  lastActivityAt: string;
}

export interface HqQueuedCommand {
  commandId: string;
  /** Idempotency key deduplicates commands across leader handoffs (§2.2). */
  idempotencyKey?: string;
  type: string;
  createdAt: string;
  payload: unknown;
  requiresAck?: boolean;
}
