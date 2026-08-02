/**
 * Chimera review finding parser.
 *
 * FS-P0.2: Extracts structured ChimeraFinding[] from the canonical
 * Chimera review report format (### Severity (N) + numbered list items).
 *
 * The known report format is:
 *   ### Critical (2)
 *   1. [BUG] path/file.ts:42 — title description
 *      → Suggested fix line
 *   2. ...
 *
 *   ### High (1)
 *   1. ...
 *
 * @module review-finding-parser
 */

import { randomUUID } from 'node:crypto';
import type { ChimeraFinding, FindingSeverity, FindingSource } from './review-finding-types.js';
import { computeFindingFingerprint } from './review-finding-types.js';

/**
 * Parsed result from a Chimera review report.
 */
export interface ParsedReviewReport {
  /** All extracted findings (parsable items). */
  findings: ChimeraFinding[];
  /** Number of severity-counted items that could NOT be parsed individually. */
  unparseableCount: number;
  /** Total time for the review, extracted from "Duration: Xs" line. */
  durationSeconds?: number | undefined;
}

/** Match a `→` or `->` suggestion line. */
const SUGGEST_LINE = /^\s*(?:→|->|=>)\s*(.+)$/;

/** Match a `Duration: 123s` line. */
const DURATION_LINE = /^Duration:\s*(\d+)s\s*$/im;

/**
 * Parse a Chimera review report text into structured findings.
 *
 * @param reportText - Full Markdown report from a Chimera review.
 * @param context - Session/report context for stamping findings.
 * @returns Parsed findings and metadata.
 */
export function parseChimeraReviewReport(
  reportText: string,
  context: {
    sessionId?: string | undefined;
    agentId?: string | undefined;
    reviewType?: string | undefined;
    reviewerModel?: string | undefined;
    reportId?: string | undefined;
  } = {},
): ParsedReviewReport {
  if (!reportText || reportText.trim().length === 0) {
    return { findings: [], unparseableCount: 0 };
  }

  const findings: ChimeraFinding[] = [];
  const reportId = context.reportId ?? randomUUID();
  let unparseableCount = 0;
  let durationSeconds: number | undefined;

  let currentSeverity: FindingSeverity | null = null;
  let currentLines: string[] = [];

  const lines = reportText.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Check for severity heading
    const headingMatch = line.trim().match(/^###\s+(critical|high|medium|low)\b/i);
    if (headingMatch) {
      // Flush previous section
      flushSection();

      currentSeverity = headingMatch[1]!.toLowerCase() as FindingSeverity;
      continue;
    }

    // Check for duration line
    const durMatch = line.match(DURATION_LINE);
    if (durMatch) {
      durationSeconds = Number.parseInt(durMatch[1]!, 10);
      continue;
    }

    // Accumulate lines in the current section
    if (currentSeverity !== null) {
      currentLines.push(line);
    }
  }

  // Flush the last section
  flushSection();

  return { findings, unparseableCount, durationSeconds };

  /** Parse accumulated section lines into findings. */
  function flushSection(): void {
    if (currentSeverity === null || currentLines.length === 0) {
      currentSeverity = null;
      currentLines = [];
      return;
    }

    const combined = currentLines.join('\n');
    // Split by numbered items
    const segments = combined.split(/\n\s*(?=\d+\.\s)/).filter((s) => s.trim().length > 0);

    for (const segment of segments) {
      const finding = parseFindingSegment(segment, currentSeverity!, { ...context, reportId });
      if (finding) {
        findings.push(finding);
      } else {
        unparseableCount++;
      }
    }

    currentSeverity = null;
    // expectedCount was not stored; reset is implicit in severity/lines
    currentLines = [];
  }
}

/**
 * Parse a single finding segment (one numbered item + its suggestion lines).
 */
function parseFindingSegment(
  segment: string,
  severity: FindingSeverity,
  context: {
    sessionId?: string | undefined;
    agentId?: string | undefined;
    reviewType?: string | undefined;
    reviewerModel?: string | undefined;
    reportId?: string | undefined;
  },
): ChimeraFinding | null {
  const lines = segment.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return null;

  // The first line should be the finding line: "N. [TAG] file:line — Description"
  const first = lines[0]!;
  const match = first.match(/^\d+\.\s+(.*)$/);
  if (!match) return null;

  const content = match[1]!.trim();

  // Extract [TAG] prefix if present
  let remaining = content;
  const tagMatch = content.match(/^\[(\w+)\]\s*/);
  if (tagMatch) {
    remaining = content.slice(tagMatch[0].length).trim();
  }

  // Un-wrap the first balanced backtick pair at the citation position so the
  // canonical `` `path/file.ts:42` `` format is recognised by the path regexes
  // below. We only unwrap the FIRST balanced pair and only when the inner
  // content starts with a path-like character — this prevents over-matching
  // when the description contains an inline backtick construct that is not
  // a citation. Backticks further into the description are preserved verbatim.
  const citationMatch = remaining.match(
    /^(`+)([a-zA-Z_./\\:][^`]*[a-zA-Z0-9_./\\:])\1(?=\s*[—–-]|\s*$)/,
  );
  if (citationMatch) {
    const inner = citationMatch[2]!;
    const afterCitation = remaining.slice(citationMatch[0].length);
    remaining = `${inner}${afterCitation}`;
  }

  // Extract a path-like file reference before a spaced Markdown separator.
  // Requiring an extension prevents hyphens inside paths from becoming the
  // separator (for example, `execution-chimera-review.ts`).
  let file: string | undefined;
  let line: number | undefined;
  let desc = remaining;

  const refMatch = remaining.match(
    /^([a-zA-Z_./\\][a-zA-Z0-9_./\\-]*\.\w+)(?::(\d+))?\s+(?:[—–]|-)\s+(.+)$/,
  );
  if (refMatch) {
    file = refMatch[1]!.trim();
    if (refMatch[2] !== undefined) {
      line = Number.parseInt(refMatch[2]!, 10);
    }
    desc = refMatch[3]!.trim();
  }

  // Fallback: if the remaining text contains a colon-separated path, extract
  if (!file) {
    const pathMatch = remaining.match(/^([a-zA-Z_./\\][a-zA-Z0-9_./\\-]*\.\w+)(?::(\d+))?/);
    if (pathMatch) {
      file = pathMatch[1]!.trim();
      if (pathMatch[2] !== undefined) {
        line = Number.parseInt(pathMatch[2]!, 10);
      }
      // Remove the file ref from the description
      const afterFile = remaining.slice(pathMatch[0].length).trim();
      desc = afterFile.replace(/^[—–-]\s*/, '').trim() || desc;
    }
  }

  const cleanDesc = desc.replace(/^[—–-]\s*/, '').trim();

  // Collect suggestion lines (→ or -> or =>)
  const suggestions: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const suggest = lines[i]!.match(SUGGEST_LINE);
    if (suggest) {
      suggestions.push(suggest[1]!.trim());
    }
  }

  // Build title from description (first sentence or truncated)
  const title = cleanDesc.split(/\.\s/)[0]!.trim() || content;
  // Full description includes the description + suggestions
  const fullDesc = suggestions.length > 0
    ? cleanDesc + '\n' + suggestions.map((s) => '  → ' + s).join('\n')
    : cleanDesc;

  const suggestedFix = suggestions.length > 0 ? suggestions.join('\n') : undefined;

  return {
    id: randomUUID(),
    fingerprint: computeFindingFingerprint(file ?? '', line ?? null, title),
    severity,
    source: normalizeFindingSource(context.reviewType),
    ...(file ? { location: { file, ...(line !== undefined ? { line } : {}) } } : {}),
    title,
    description: fullDesc,
    ...(suggestedFix ? { suggestedFix } : {}),
    createdAt: new Date().toISOString(),
    status: 'active',
    originReport: {
      reportId: context.reportId ?? randomUUID(),
      sessionId: context.sessionId ?? '',
      agentId: context.agentId ?? '',
      reviewerModel: context.reviewerModel ?? '',
    },
  };
}

function normalizeFindingSource(reviewType: string | undefined): FindingSource {
  switch (reviewType) {
    case 'auto':
    case 'chimera':
    case 'cascade':
    case 'security-scanner':
      return reviewType;
    default:
      return 'chimera';
  }
}
