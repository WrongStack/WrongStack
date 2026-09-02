/**
 * Chimera review report integration.
 *
 * Hooks into the chimera.review_complete event to persist a full ReviewReport
 * record (metadata + raw text + severity counts) for each completed review.
 *
 * This is the report-level complement to review-finding-integration.ts:
 *   - finding-integration  → individual findings (deduplicated, lifecycle-tracked)
 *   - report-integration   → the report as a whole (raw text, provenance, lifecycle)
 *
 * The two share the same `reportId` so `/review report <id>` can cross-link
 * to the findings that came from that report.
 *
 * @module review-report-integration
 */

import { parseChimeraReviewReport } from './review-finding-parser.js';
import { JsonlFindingStore } from './review-finding-store.js';
import { classifyChimeraReviewSource } from './review-finding-integration.js';
import { JsonlReportStore, type PersistReportInput } from './review-report-store.js';
import type { ReviewReportCounts, ReviewReportFile } from './review-report-types.js';
import type { ChimeraReviewCompletePayload } from './review-types.js';

/**
 * Result of a report integration run.
 */
export interface ReportIntegrationResult {
  /** The persisted report's ID. */
  reportId: string;
  /** Whether this was a new record or an update to an existing one. */
  created: boolean;
  /** Total findings parsed from the report text. */
  totalFindings: number;
}

/**
 * Persist a completed Chimera review as a structured report record.
 *
 * Extracts metadata from the payload (provenance, files, cascade depth) and
 * parses the raw review text for severity counts and duration. The full raw
 * text is stored verbatim so it can be displayed later.
 *
 * @param payload - The chimera.review_complete event payload.
 * @param reportId - The UUID to assign (should match findings' originReport.reportId).
 * @param projectDir - Project root (~/.wrongstack/projects/<slug>).
 * @returns Integration result summary.
 */
export async function updateReviewReportEvidence(
  reportId: string,
  projectDir: string,
  evidenceStatus: import('./review-types.js').CascadeEvidenceStatus,
  evidenceChecks: import('./review-types.js').CascadeEvidenceCheckResult[],
): Promise<void> {
  await new JsonlReportStore(projectDir).updateEvidence(reportId, evidenceStatus, evidenceChecks);
}

export async function persistReviewReport(
  payload: ChimeraReviewCompletePayload,
  reportId: string,
  projectDir: string,
): Promise<ReportIntegrationResult> {
  const store = new JsonlReportStore(projectDir);
  const existed = await store.get(reportId);

  const source = classifyChimeraReviewSource(payload.bundle);
  const agentId =
    payload.bundle.fileProvenance?.find((entry) => entry.agentId)?.agentId ?? 'chimera-review';
  const sessionId = payload.sessionId ?? payload.cwd;
  const model = payload.bundle.config.model;
  const cascadeDepth = payload.bundle.cascadeDepth;

  const files: ReviewReportFile[] = payload.bundle.files.map((f) => ({
    path: f.path,
    status: f.status,
  }));

  const reviewStatus: 'success' | 'failed' = payload.status === 'success' ? 'success' : 'failed';

  // P0-1: the execution owner parses + verifies once and threads the result;
  // use it so report counts and finding counts can never diverge. Legacy
  // emitters without parsedReport fall back to parsing here. For failed
  // reviews, rawText may be empty — we still persist the record so there's
  // an audit trail of the attempt.
  const parsed =
    reviewStatus === 'success'
      ? (payload.parsedReport ??
        parseChimeraReviewReport(payload.reviewText, {
          sessionId,
          agentId,
          reviewerModel: model,
          reviewType: source,
          reportId,
        }))
      : { findings: [], unparseableCount: 0, durationSeconds: undefined };

  const counts: ReviewReportCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const finding of parsed.findings) {
    counts[finding.severity]++;
  }

  const input: PersistReportInput = {
    id: reportId,
    sessionId,
    agentId,
    reviewerModel: model,
    source,
    reviewStatus,
    files,
    counts,
    totalFindings: parsed.findings.length,
    unparseableCount: parsed.unparseableCount,
    durationSeconds: parsed.durationSeconds,
    rawText: payload.reviewText,
    ...(cascadeDepth !== undefined ? { cascadeDepth } : {}),
    // P0-3: carry the cascade evidence verification (status + per-check
    // comparisons) so the persisted report is auditable. Absent on initial
    // reviews — no cascade step produced evidence yet.
    ...(payload.bundle.evidenceStatus !== undefined
      ? { evidenceStatus: payload.bundle.evidenceStatus }
      : {}),
    ...(payload.bundle.evidenceChecks !== undefined
      ? { evidenceChecks: payload.bundle.evidenceChecks }
      : {}),
  };

  await store.persist(input);

  // A successful, fully parseable all-clear report has no work left for a
  // leader to disposition. Close it at the authoritative persistence
  // boundary instead of leaving an empty `open` report that can only be
  // cleared by a later manual `/review report ... complete` command.
  if (
    reviewStatus === 'success' &&
    parsed.findings.length === 0 &&
    parsed.unparseableCount === 0 &&
    isExplicitAllClearReview(payload.reviewText)
  ) {
    await store.transition(
      reportId,
      'completed',
      { id: 'chimera', kind: 'system' },
      {
        reason: 'Successful Chimera review produced no actionable findings',
      },
    );
  }

  return {
    reportId,
    created: !existed,
    totalFindings: parsed.findings.length,
  };
}

function isExplicitAllClearReview(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    normalized.startsWith('## 🦂 chimera review — all clear') ||
    normalized.includes('chimera review: all clear')
  );
}

/**
 * Result of a report-completion sync check.
 */
export interface ReportSyncResult {
  /** The report ID that was checked. */
  reportId: string;
  /** Whether the report was transitioned to completed. */
  completed: boolean;
  /** Total findings linked to this report. */
  totalFindings: number;
  /** How many are still in a non-terminal status. */
  remaining: number;
}

/**
 * Check whether all findings linked to a report are in terminal states
 * (resolved or ignored) and transition the report to `completed` if so.
 *
 * Called after a finding transition to provide auto-completion of the
 * parent report. This function is idempotent: if the report is already
 * completed/skipped, it does nothing.
 *
 * Edge cases:
 * - Zero findings: no-op (an empty report stays open until manually closed).
 * - Report not found: returns `{ completed: false }`.
 * - Report already terminal: no-op.
 *
 * @param reportId - The report to check.
 * @param projectDir - Project root (~/.wrongstack/projects/<slug>).
 * @param actor - Who/what is triggering the sync.
 */
export async function syncReportCompletion(
  reportId: string,
  projectDir: string,
  actor: { id: string; kind: 'agent' | 'operator' | 'system' },
): Promise<ReportSyncResult> {
  const reportStore = new JsonlReportStore(projectDir);
  const findingStore = new JsonlFindingStore(projectDir);

  const report = await reportStore.get(reportId);
  if (!report) {
    return { reportId, completed: false, totalFindings: 0, remaining: 0 };
  }

  // Already closed out — nothing to do.
  if (report.lifecycle === 'completed' || report.lifecycle === 'skipped') {
    return { reportId, completed: false, totalFindings: 0, remaining: 0 };
  }

  const findings = await findingStore.list({ reportId, limit: 9999 });
  const total = findings.length;

  // Don't auto-complete reports with zero findings — they need manual closure.
  if (total === 0) {
    return { reportId, completed: false, totalFindings: 0, remaining: 0 };
  }

  const remaining = findings.filter(
    (f) => f.status !== 'resolved' && f.status !== 'ignored',
  ).length;

  if (remaining > 0) {
    return { reportId, completed: false, totalFindings: total, remaining };
  }

  // All findings are terminal — transition the report.
  await reportStore.transition(reportId, 'completed', actor, {
    reason: `All ${total} finding(s) resolved or ignored`,
  });

  return { reportId, completed: true, totalFindings: total, remaining: 0 };
}

/**
 * Result of a report-reopen sync check.
 */
export interface ReportReopenResult {
  /** The report ID that was checked. */
  reportId: string;
  /** Whether the report was transitioned from terminal back to open. */
  reopened: boolean;
  /** The lifecycle status the report had before the check. */
  previousLifecycle: string;
}

/**
 * Reopen a completed or skipped report when one of its findings transitions
 * back to an active state.
 *
 * This is the inverse of `syncReportCompletion`: when a finding in a
 * terminal report is reopened (e.g. resolved → active), the parent report
 * should also reopen so it's not falsely marked as done.
 *
 * Edge cases:
 * - Report already open/actioned: no-op.
 * - Report not found: returns `{ reopened: false }`.
 * - Report completed or skipped: transitions to `open`.
 *
 * @param reportId - The report to check.
 * @param projectDir - Project root (~/.wrongstack/projects/<slug>).
 * @param actor - Who/what is triggering the sync.
 * @param reason - Optional reason for the reopen.
 */
export async function syncReportReopen(
  reportId: string,
  projectDir: string,
  actor: { id: string; kind: 'agent' | 'operator' | 'system' },
  reason?: string,
): Promise<ReportReopenResult> {
  const reportStore = new JsonlReportStore(projectDir);

  const report = await reportStore.get(reportId);
  if (!report) {
    return { reportId, reopened: false, previousLifecycle: 'not_found' };
  }

  // Only terminal reports need reopening.
  if (report.lifecycle !== 'completed' && report.lifecycle !== 'skipped') {
    return { reportId, reopened: false, previousLifecycle: report.lifecycle };
  }

  await reportStore.transition(reportId, 'open', actor, {
    reason: reason ?? `Finding reopened — report was ${report.lifecycle}`,
  });

  return { reportId, reopened: true, previousLifecycle: report.lifecycle };
}
