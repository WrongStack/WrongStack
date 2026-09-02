/**
 * Core data types for the Chimera Review Report Store.
 *
 * A ReviewReport is the top-level record produced by each completed review
 * run. It captures the full report metadata (when, who, what model, which
 * files), the raw Markdown text, severity counts, and a lifecycle that
 * tracks what was done with the report over time.
 *
 * Reports link to individual findings via a shared `reportId` (stored on
 * each finding's `originReport.reportId`). The report store is a separate
 * JSONL file from the finding store so the two have independent lifecycles
 * and retention windows.
 *
 * @module review-report-types
 */

import type { CascadeEvidenceCheckResult, CascadeEvidenceStatus } from './review-types.js';
import type { FindingSource } from './review-finding-types.js';

// ── Lifecycle ──────────────────────────────────────────────────────

/**
 * Lifecycle status of a review report.
 *
 * ```
 * open (review just completed)
 *   ├→ actioned  (at least one finding is being worked on or was fixed)
 *   ├→ completed (all findings resolved or ignored; report closed out)
 *   └→ skipped   (operator/agent decided not to act on this report)
 *
 * completed / skipped → open (reopened — findings resurfaced)
 * actioned → completed / skipped
 * ```
 */
export type ReportLifecycleStatus = 'open' | 'actioned' | 'completed' | 'skipped';

/** What kind of actor performed a lifecycle transition. */
export type ReportActorKind = 'agent' | 'operator' | 'system';

// ── Core record ────────────────────────────────────────────────────

/** Severity counts extracted from the parsed report. */
export interface ReviewReportCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

/** A file that was part of the reviewed change set. */
export interface ReviewReportFile {
  path: string;
  status: 'added' | 'modified';
}

/**
 * A completed Chimera review report — the full record of one review run.
 *
 * One report is created per `chimera.review_complete` event. It is linked
 * to the finding store via `id` (which equals `finding.originReport.reportId`).
 */
export interface ReviewReport {
  /** Immutable UUID — links to findings' `originReport.reportId`. */
  id: string;
  /** When the review completed (ISO8601). */
  reviewedAt: string;
  /** Session that triggered the review. */
  sessionId: string;
  /** Agent that was being reviewed. */
  agentId: string;
  /** Model that produced the review report. */
  reviewerModel: string;
  /** Review kind that produced this report. */
  source: FindingSource;
  /** Whether the review subagent succeeded or failed. */
  reviewStatus: 'success' | 'failed';
  /** Materialized lifecycle status (derived from latest lifecycle event). */
  lifecycle: ReportLifecycleStatus;
  /** Files that were reviewed. */
  files: ReviewReportFile[];
  /** Severity counts from the parsed report. */
  counts: ReviewReportCounts;
  /** Total findings parsed from the report. */
  totalFindings: number;
  /** Severity-counted items that could not be parsed individually. */
  unparseableCount: number;
  /** Review duration in seconds, if reported. */
  durationSeconds?: number | undefined;
  /** The full raw Markdown report text. */
  rawText: string;
  /** Cascade iteration depth (0 for initial review). */
  cascadeDepth?: number | undefined;
  /**
   * P0-3: machine-evidence verification status of the cascade fix step that
   * preceded this report's review. `verified` / `failed` / `missing` mirror
   * the bundle's evidenceStatus; absent when no cascade step ran.
   */
  evidenceStatus?: CascadeEvidenceStatus | undefined;
  /**
   * Per-check comparison results (claimed vs. observed exit codes) from the
   * cascade evidence verification. Recorded so a report is auditable: exactly
   * which commands the fix agent claimed, what the orchestrator observed, and
   * which checks matched.
   */
  evidenceChecks?: CascadeEvidenceCheckResult[] | undefined;
}

// ── Lifecycle event ────────────────────────────────────────────────

export type ReportEventType =
  | 'created'
  | 'actioned'
  | 'completed'
  | 'skipped'
  | 'reopened'
  | 'note_added';

/** A single state-transition or annotation event in a report's lifecycle. */
export interface ReviewReportEvent {
  id: string;
  reportId: string;
  eventType: ReportEventType;
  fromLifecycle: ReportLifecycleStatus | null;
  toLifecycle: ReportLifecycleStatus;
  actorId: string;
  actorKind: ReportActorKind;
  timestamp: string; // ISO8601
  reason?: string | undefined;
}

// ── Error classes ──────────────────────────────────────────────────

export class ReportNotFoundError extends Error {
  readonly reportId: string;
  constructor(reportId: string) {
    super(`Review report not found: ${reportId}`);
    this.name = 'ReportNotFoundError';
    this.reportId = reportId;
  }
}

export class InvalidReportTransitionError extends Error {
  readonly from: ReportLifecycleStatus;
  readonly to: ReportLifecycleStatus;
  constructor(from: ReportLifecycleStatus, to: ReportLifecycleStatus, reason?: string) {
    const msg = reason ?? `Invalid report transition from "${from}" to "${to}"`;
    super(msg);
    this.name = 'InvalidReportTransitionError';
    this.from = from;
    this.to = to;
  }
}

// ── Transition state machine ───────────────────────────────────────

const REPORT_TRANSITION_MATRIX: Record<
  ReportLifecycleStatus,
  ReadonlySet<ReportLifecycleStatus>
> = {
  open: new Set(['actioned', 'completed', 'skipped']),
  actioned: new Set(['completed', 'skipped']),
  completed: new Set(['open']),
  skipped: new Set(['open']),
};

/**
 * Check whether a report lifecycle transition is valid per the state machine.
 * Throws InvalidReportTransitionError for invalid transitions.
 *
 * `note_added` events are always allowed regardless of current status — they
 * are annotations, not transitions, and the caller should validate them
 * separately (this function is for real status moves only).
 */
export function validateReportTransition(
  from: ReportLifecycleStatus,
  to: ReportLifecycleStatus,
): void {
  if (from === to) return; // idempotent
  const allowed = REPORT_TRANSITION_MATRIX[from];
  if (!allowed?.has(to)) {
    throw new InvalidReportTransitionError(from, to);
  }
}

/** Map a target lifecycle status to its corresponding event type. */
export function reportEventTypeFor(to: ReportLifecycleStatus): ReportEventType {
  switch (to) {
    case 'actioned':
      return 'actioned';
    case 'completed':
      return 'completed';
    case 'skipped':
      return 'skipped';
    default:
      return 'reopened';
  }
}
