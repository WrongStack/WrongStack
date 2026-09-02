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
import type {
  ChimeraFinding,
  FindingCategory,
  FindingConfidence,
  FindingSeverity,
  FindingSource,
} from './review-finding-types.js';
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
  /**
   * True when the findings came from the structured JSON contract (P0-1)
   * rather than the legacy markdown heuristics. When false, findings are
   * recovered from `### Severity (N)` headings + numbered list items and
   * carry no `category`/`confidence`.
   */
  structured?: boolean | undefined;
}

/**
 * One finding item from the structured JSON contract appended by the
 * reviewer to the end of the markdown report (P0-1).
 */
export interface StructuredFindingItem {
  severity: string;
  file?: string | undefined;
  line?: number | undefined;
  category?: string | undefined;
  confidence?: string | undefined;
  title: string;
  description?: string | undefined;
  suggestedFix?: string | undefined;
}

/**
 * The parsed fenced JSON block: a `findings` array plus optional metadata.
 */
export interface StructuredFindingsBlock {
  findings: StructuredFindingItem[];
  durationSeconds?: number | undefined;
}

const SEVERITIES = new Set<FindingSeverity>(['critical', 'high', 'medium', 'low']);
const CATEGORIES = new Set<FindingCategory>([
  'bug',
  'security',
  'performance',
  'type',
  'contract',
  'test',
  'other',
]);
const CONFIDENCES = new Set<FindingConfidence>(['high', 'medium', 'low']);

/**
 * Match a fenced code block tagged `json` (the P0-1 structured-findings
 * contract). Untagged fences are never treated as the findings block so an
 * example JSON snippet in report prose cannot hijack the parse.
 */
const FENCED_BLOCK = /```json[ \t]*\r?\n([\s\S]*?)\r?\n```/gi;

/**
 * Extract the structured findings JSON block from a report. Returns the
 * LAST fenced block that parses as JSON and carries a `findings` array —
 * the reviewer is instructed to append exactly one such block, so the last
 * one wins when earlier blocks are examples or stray prose. Returns `null`
 * when no parseable block exists (legacy markdown-only reports).
 */
export function extractStructuredFindingsBlock(reportText: string): StructuredFindingsBlock | null {
  if (!reportText) return null;
  let best: StructuredFindingsBlock | null = null;
  for (const match of reportText.matchAll(FENCED_BLOCK)) {
    const body = match[1];
    if (!body?.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue; // not JSON — not our block
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const findings = (parsed as { findings?: unknown }).findings;
    if (!Array.isArray(findings)) continue;
    const items: StructuredFindingItem[] = [];
    for (const raw of findings) {
      const item = normalizeStructuredItem(raw);
      if (item) items.push(item);
    }
    // A block that declares findings but yields zero valid items is garbage,
    // NOT an all-clear: skipping it lets the markdown fallback survive so the
    // report's real findings are not silently lost. An empty `findings` array
    // (a true all-clear) still counts as a structured block.
    if (findings.length > 0 && items.length === 0) continue;
    const durationRaw = (parsed as { durationSeconds?: unknown }).durationSeconds;
    const durationSeconds =
      typeof durationRaw === 'number' && Number.isFinite(durationRaw) && durationRaw > 0
        ? Math.floor(durationRaw)
        : undefined;
    best = { findings: items, ...(durationSeconds !== undefined ? { durationSeconds } : {}) };
  }
  return best;
}

/** Validate and normalize a single JSON findings item, or null when invalid. */
function normalizeStructuredItem(raw: unknown): StructuredFindingItem | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const item = raw as Record<string, unknown>;
  const severity = typeof item.severity === 'string' ? item.severity.toLowerCase() : '';
  if (!SEVERITIES.has(severity as FindingSeverity)) return null;
  const title = typeof item.title === 'string' ? item.title.trim() : '';
  if (title.length === 0) return null;
  const file =
    typeof item.file === 'string' && item.file.trim().length > 0 ? item.file.trim() : undefined;
  const line =
    typeof item.line === 'number' && Number.isInteger(item.line) && item.line >= 1
      ? item.line
      : undefined;
  const categoryRaw = typeof item.category === 'string' ? item.category.toLowerCase() : '';
  const category = CATEGORIES.has(categoryRaw as FindingCategory)
    ? (categoryRaw as FindingCategory)
    : undefined;
  const confidenceRaw = typeof item.confidence === 'string' ? item.confidence.toLowerCase() : '';
  const confidence = CONFIDENCES.has(confidenceRaw as FindingConfidence)
    ? (confidenceRaw as FindingConfidence)
    : undefined;
  return {
    severity: severity as FindingSeverity,
    ...(file ? { file } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(category ? { category } : {}),
    ...(confidence ? { confidence } : {}),
    title,
    ...(typeof item.description === 'string' && item.description.trim().length > 0
      ? { description: item.description.trim() }
      : {}),
    ...(typeof item.suggestedFix === 'string' && item.suggestedFix.trim().length > 0
      ? { suggestedFix: item.suggestedFix.trim() }
      : {}),
  };
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

  // ── P0-1: structured JSON contract takes precedence when present ──
  // The reviewer appends one fenced JSON block; when it parses, its
  // findings are authoritative and the markdown is display-only. The
  // legacy markdown heuristics below remain the fallback for reports
  // that predate the contract.
  const structured = extractStructuredFindingsBlock(reportText);
  if (structured) {
    // Hoist the report id ONCE so every structured finding stamps the same
    // originReport.reportId — mirrors the markdown path below, which allocates
    // a single id for the whole parse rather than one per finding.
    const reportId = context.reportId ?? randomUUID();
    const findings = structured.findings.map(
      (item): ChimeraFinding => buildFindingFromStructuredItem(item, { ...context, reportId }),
    );
    return {
      findings,
      unparseableCount: 0,
      ...(structured.durationSeconds !== undefined
        ? { durationSeconds: structured.durationSeconds }
        : {}),
      structured: true,
    };
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
  const lines = segment
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
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
  const fullDesc =
    suggestions.length > 0
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

/**
 * Build a ChimeraFinding from a structured JSON contract item (P0-1).
 * Uses the same fingerprint/context stamping as the markdown path so a
 * finding that later appears in a markdown-only report dedupes to the
 * same logical record.
 */
function buildFindingFromStructuredItem(
  item: StructuredFindingItem,
  context: {
    sessionId?: string | undefined;
    agentId?: string | undefined;
    reviewType?: string | undefined;
    reviewerModel?: string | undefined;
    reportId?: string | undefined;
  },
): ChimeraFinding {
  const file = item.file;
  const line = item.line;
  const title = item.title;
  const description = item.description ?? title;
  return {
    id: randomUUID(),
    fingerprint: computeFindingFingerprint(file ?? '', line ?? null, title),
    severity: item.severity as FindingSeverity,
    source: normalizeFindingSource(context.reviewType),
    ...(file ? { location: { file, ...(line !== undefined ? { line } : {}) } } : {}),
    ...(item.category ? { category: item.category as FindingCategory } : {}),
    ...(item.confidence ? { confidence: item.confidence as FindingConfidence } : {}),
    title,
    description,
    ...(item.suggestedFix ? { suggestedFix: item.suggestedFix } : {}),
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
