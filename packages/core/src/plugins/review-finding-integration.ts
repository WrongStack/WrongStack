/**
 * Chimera finding auto-integration.
 *
 * FS-P0.6: Hooks into the chimera.review_complete event to persist
 * structured findings from every review report.
 *
 * @module review-finding-integration
 */

import { randomUUID } from 'node:crypto';
import { type ChimeraReviewCompletePayload } from './chimera-plugin.js';
import { parseChimeraReviewReport } from './review-finding-parser.js';
import { JsonlFindingStore } from './review-finding-store.js';

/**
 * Result of a findings integration run.
 */
export interface FindingsIntegrationResult {
  /** Number of new findings created. */
  created: number;
  /** Number of existing findings relinked. */
  relinked: number;
  /** Number of resolved/ignored findings reopened. */
  reopened: number;
  /** Report ID if any findings were upserted. */
  reportId?: string | undefined;
  /** Total findings count in the report. */
  totalFindings: number;
  /** Unparseable item count. */
  unparseableCount: number;
}

/**
 * Integrate findings from a completed Chimera review into the
 * project's finding store.
 *
 * Parses the review report text, upserts all findings, and
 * returns a summary.
 */
export async function integrateFindings(
  payload: ChimeraReviewCompletePayload,
  projectDir: string,
): Promise<FindingsIntegrationResult> {
  if (!payload.reviewText || payload.reviewText.trim().length === 0) {
    return { created: 0, relinked: 0, reopened: 0, totalFindings: 0, unparseableCount: 0 };
  }

  const store = new JsonlFindingStore(projectDir);
  const reportId = randomUUID();
  const source = (payload.bundle.cascadeDepth ?? 0) > 0
    ? 'cascade'
    : payload.bundle.cascadeOn !== undefined && payload.bundle.cascadeOn !== 'off'
      ? 'auto'
      : 'chimera';
  const agentId = payload.bundle.fileProvenance?.find((entry) => entry.agentId)?.agentId
    ?? 'chimera-review';
  const sessionId = payload.cwd;
  const model = payload.bundle.config.model;

  const parsed = parseChimeraReviewReport(payload.reviewText, {
    sessionId,
    agentId,
    reviewerModel: model,
    reviewType: source,
    reportId,
  });

  if (parsed.findings.length === 0) {
    return {
      created: 0, relinked: 0, reopened: 0,
      totalFindings: 0, unparseableCount: parsed.unparseableCount,
    };
  }

  const result = await store.upsert(parsed.findings, {
    sessionId,
    reportId,
    agentId,
    model,
  });

  return {
    created: result.created,
    relinked: result.relinked,
    reopened: result.reopened,
    reportId,
    totalFindings: parsed.findings.length,
    unparseableCount: parsed.unparseableCount,
  };
}
