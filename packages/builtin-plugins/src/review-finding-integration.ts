/**
 * Chimera finding auto-integration.
 *
 * FS-P0.6: Hooks into the chimera.review_complete event to persist
 * structured findings from every review report.
 *
 * @module review-finding-integration
 */

import { parseChimeraReviewReport } from './review-finding-parser.js';
import { JsonlFindingStore } from './review-finding-store.js';
import type { ChimeraFinding, FindingSource } from './review-finding-types.js';
import type { ChimeraReviewCompletePayload, ReviewContextBundle } from './review-types.js';

function normalizeSuppressionPath(filePath: string): string {
  return filePath
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '')
    .toLowerCase();
}

function makeSuppressionTitleKey(filePath: string, title: string): string {
  return `${normalizeSuppressionPath(filePath)}\0${title.trim().toLowerCase()}`;
}

/**
 * Strip findings that match an operator-suppressed record (`ignored`, or
 * `resolved` with outcome `wontfix` | `false_positive`) in the project's
 * finding store.
 *
 * Applied at the execution boundary BEFORE Markdown report synthesis, report
 * persistence, mailbox alerts, or auto-review fix cascades run — ensuring an
 * LLM that disobeys `DO NOT RE-REPORT` cannot trigger a fix cascade or noisy
 * alert on code the operator explicitly suppressed. Genuinely `fixed` findings
 * are NOT filtered so real regressions still pass through and reopen.
 */
export async function filterOperatorSuppressedFindings(
  findings: ChimeraFinding[],
  projectDir: string,
): Promise<{ findings: ChimeraFinding[]; suppressedCount: number }> {
  if (findings.length === 0 || !projectDir) {
    return { findings, suppressedCount: 0 };
  }

  let terminalRecords: ChimeraFinding[];
  try {
    const store = new JsonlFindingStore(projectDir);
    terminalRecords = await store.list({ statuses: ['ignored', 'resolved'], limit: 500 });
  } catch {
    return { findings, suppressedCount: 0 };
  }

  if (terminalRecords.length === 0) {
    return { findings, suppressedCount: 0 };
  }

  const suppressedFingerprints = new Set<string>();
  const suppressedFileTitles = new Set<string>();

  for (const record of terminalRecords) {
    const outcome = record.resolution?.outcome;
    const resolvedByAgent = record.resolution?.resolvedBy === 'leader';
    const isOperatorSuppressed =
      record.status === 'ignored' ||
      (!resolvedByAgent &&
        record.status === 'resolved' &&
        (outcome === 'wontfix' || outcome === 'false_positive'));
    if (!isOperatorSuppressed) continue;

    if (record.fingerprint) {
      suppressedFingerprints.add(record.fingerprint);
    }
    if (record.location?.file && record.title.trim().length > 0) {
      suppressedFileTitles.add(makeSuppressionTitleKey(record.location.file, record.title));
    }
  }

  if (suppressedFingerprints.size === 0 && suppressedFileTitles.size === 0) {
    return { findings, suppressedCount: 0 };
  }

  const kept: ChimeraFinding[] = [];
  let suppressedCount = 0;
  for (const finding of findings) {
    const matchesFingerprint = Boolean(
      finding.fingerprint && suppressedFingerprints.has(finding.fingerprint),
    );
    const matchesFileTitle = Boolean(
      finding.location?.file &&
        finding.title.trim().length > 0 &&
        suppressedFileTitles.has(makeSuppressionTitleKey(finding.location.file, finding.title)),
    );
    if (matchesFingerprint || matchesFileTitle) {
      suppressedCount++;
      continue;
    }
    kept.push(finding);
  }

  return { findings: kept, suppressedCount };
}

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
