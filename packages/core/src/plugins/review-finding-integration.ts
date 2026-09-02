/**
 * Chimera finding auto-integration.
 *
 * FS-P0.6: Hooks into the chimera.review_complete event to persist
 * structured findings from every review report.
 *
 * @module review-finding-integration
 */

import type { ChimeraReviewCompletePayload, ReviewContextBundle } from './review-types.js';
import { parseChimeraReviewReport } from './review-finding-parser.js';
import { JsonlFindingStore } from './review-finding-store.js';
import type { FindingSource } from './review-finding-types.js';

/**
 * Classify the review source from the payload bundle.
 *
 * Shared by finding integration and report integration so the two stores
 * always agree on how a review is labeled. Mirrors the historical logic:
 * cascadeDepth > 0 → 'cascade'; cascadeOn configured (not 'off') → 'auto';
 * otherwise the post-session/manual Chimera plugin → 'chimera'.
 */
export function classifyChimeraReviewSource(bundle: ReviewContextBundle): FindingSource {
  const cascadeDepth = bundle.cascadeDepth ?? 0;
  if (cascadeDepth > 0) return 'cascade';
  const cascadeOn = bundle.cascadeOn;
  if (cascadeOn !== undefined && cascadeOn !== 'off') return 'auto';
  return 'chimera';
}

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
 * Uses the execution owner's pre-parsed findings (P0-1) when present so the
 * report is never re-parsed with a divergent context; falls back to parsing
 * `payload.reviewText` for legacy emitters. Upserts all findings and returns
 * a summary.
 */
export async function integrateFindings(
  payload: ChimeraReviewCompletePayload,
  projectDir: string,
  reportId: string,
): Promise<FindingsIntegrationResult> {
  if ((!payload.reviewText || payload.reviewText.trim().length === 0) && !payload.parsedReport) {
    return { created: 0, relinked: 0, reopened: 0, totalFindings: 0, unparseableCount: 0 };
  }

  const store = new JsonlFindingStore(projectDir);
  const source = classifyChimeraReviewSource(payload.bundle);
  const agentId =
    payload.bundle.fileProvenance?.find((entry) => entry.agentId)?.agentId ?? 'chimera-review';
  const sessionId = payload.sessionId ?? payload.cwd;
  const model = payload.bundle.config.model;

  // The execution owner parses + verifies exactly once and threads the result
  // (P0-1/P0-2). Legacy emitters that skip pre-parsing fall back to parsing
  // here so both paths converge on the same upsert semantics.
  const parsed =
    payload.parsedReport ??
    parseChimeraReviewReport(payload.reviewText, {
      sessionId,
      agentId,
      reviewerModel: model,
      reviewType: source,
      reportId,
    });

  if (parsed.findings.length === 0) {
    return {
      created: 0,
      relinked: 0,
      reopened: 0,
      totalFindings: 0,
      unparseableCount: parsed.unparseableCount,
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
