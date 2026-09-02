import { createHash, randomUUID } from 'node:crypto';
import type { ChimeraReviewCompletePayload } from '../plugins/review-types.js';
import type { ChronicleContext } from './context.js';
import type { ChronicleEventSink } from './sink.js';
import type { ChronicleEventInput } from './types.js';

export interface ChronicleReviewAdapterOptions {
  events: {
    onPattern(pattern: string, handler: (event: unknown, payload: unknown) => void): () => void;
  };
  journal: ChronicleEventSink;
  context: ChronicleContext | (() => ChronicleContext);
  onPersistError?: ((error: unknown, event: ChronicleEventInput) => void) | undefined;
}

/**
 * Bridges Chimera review completions into Chronicle as structured,
 * queryable events. Each finding (severity + file:line + title) becomes
 * one Chronicle event so queries like "which sessions had critical auth
 * findings" are a single WHERE clause instead of a cross-store join.
 *
 * Also persists one summary event per review with duration, model, and
 * severity-count aggregates so review-level analytics (frequency, model
 * usage, cascade depth) are self-contained in Chronicle.
 */
export function wireReviewFindingsToChronicle(options: ChronicleReviewAdapterOptions): () => void {
  const unsubscribe = options.events.onPattern(
    'chimera.review_complete',
    (_event: unknown, raw: unknown) => {
      const payload = raw as ChimeraReviewCompletePayload;
      if (!payload?.reviewText) return;
      if (payload.status !== 'success') return;

      const context = typeof options.context === 'function' ? options.context() : options.context;
      const sessionId = payload.sessionId ?? payload.bundle?.cwd;
      const agentId = payload.bundle?.fileProvenance?.find((e) => e.agentId)?.agentId;
      const taskId = payload.bundle?.kanbanCard?.id;
      const provider = payload.bundle?.config?.provider;
      const model = payload.bundle?.config?.model;
      const cascadeDepth = payload.bundle?.cascadeDepth ?? 0;
      const now = new Date().toISOString();

      // Parse structured findings from the review text.
      // We use a minimal inline parse rather than importing
      // parseChimeraReviewReport to keep the adapter dependency-free
      // and avoid importing review-finding-parser types into chronicle.
      const findings = parseFindings(payload.reviewText);

      // One Chronicle event per finding
      for (const finding of findings) {
        const eventId = randomUUID();
        const input: ChronicleEventInput = {
          eventType: `finding.${finding.severity}` as const,
          occurredAt: now,
          scope: {
            ...context.scope,
            ...(sessionId ? { sessionId } : {}),
            ...(agentId ? { agentId } : {}),
            ...(taskId ? { taskId } : {}),
          },
          correlation: context.correlation,
          resource: finding.file
            ? {
                kind: 'file',
                id: `finding:${finding.fingerprint}`,
                path: finding.file,
                ...(finding.line !== undefined ? { lineStart: finding.line } : {}),
              }
            : undefined,
          outcome: 'success',
          attributes: {
            findingId: eventId,
            fingerprint: finding.fingerprint,
            severity: finding.severity,
            title: finding.title,
            file: finding.file,
            line: finding.line,
            source: 'chimera',
            model,
            provider,
            cascadeDepth,
          },
          tags: {
            collector: 'review-adapter',
            family: 'finding',
            severity: finding.severity,
          },
        };
        options.journal.append(input).catch((error) => options.onPersistError?.(error, input));
      }

      // No findings → no summary either
      if (findings.length === 0) return;

      // Summary event per review
      const summaryInput: ChronicleEventInput = {
        eventType: 'review.completed',
        occurredAt: now,
        scope: {
          ...context.scope,
          ...(sessionId ? { sessionId } : {}),
          ...(agentId ? { agentId } : {}),
          ...(taskId ? { taskId } : {}),
        },
        correlation: context.correlation,
        outcome: 'success',
        attributes: {
          totalFindings: findings.length,
          severityCounts: aggregateSeverities(findings),
          files: payload.bundle?.files?.map((f) => f.path),
          model,
          provider,
          cascadeDepth,
          status: payload.status,
        },
        tags: {
          collector: 'review-adapter',
          family: 'review',
        },
      };
      options.journal
        .append(summaryInput)
        .catch((error) => options.onPersistError?.(error, summaryInput));
    },
  );

  return unsubscribe;
}

// ── Minimal finding parser ──────────────────────────────────────────

interface ParsedFinding {
  severity: string;
  file?: string | undefined;
  line?: number | undefined;
  title: string;
  fingerprint: string;
}

/** Match a severity heading: ### Critical (N) */
const SEVERITY_HEADING = /^###\s+(critical|high|medium|low)\b/i;

/** Match a numbered finding item: captures everything after "N. " */
const ITEM_CAPTURE = /^\d+\.\s+(.*)$/;

/** Match an optional [TAG] prefix at the start of content. */
const TAG_PREFIX = /^\[(\w+)\]\s*/;

/**
 * Extract file:line — description from finding content.
 * Mirrors canonical parseFindingSegment() in review-finding-parser.ts
 * but uses `\s+` instead of `\s*` before the separator to prevent
 * hyphens inside file paths (e.g. `my-file.ts`) from being consumed
 * as the description separator.
 */
const FILE_REF = /^(.+?)(?::(\d+))?\s+[—–]\s*(.+)$/;

/** Match a path-like reference as fallback when no file:line — pattern is found. */
const PATH_REF = /^([a-zA-Z_./\\][a-zA-Z0-9_./\\-]*\.\w+)(?::(\d+))?/;

function parseFindings(reviewText: string): ParsedFinding[] {
  const findings: ParsedFinding[] = [];
  let currentSeverity: string | null = null;

  for (const rawLine of reviewText.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    const heading = line.match(SEVERITY_HEADING);
    if (heading) {
      currentSeverity = heading[1]!.toLowerCase();
      continue;
    }

    if (!currentSeverity) continue;

    // Step 1: capture everything after "N. " (mirrors canonical first step)
    const item = line.match(ITEM_CAPTURE);
    if (!item) continue;
    let remaining = item[1]!.trim();
    if (!remaining) continue;

    // Step 2: strip optional [TAG] prefix (mirrors canonical tag extraction)
    const tag = remaining.match(TAG_PREFIX);
    if (tag) remaining = remaining.slice(tag[0].length).trim();

    // Step 3: extract file:line — description (mirrors canonical FILE_REF)
    const refMatch = remaining.match(FILE_REF);
    let file: string | undefined;
    let lineNum: number | undefined;
    let desc: string;

    if (refMatch) {
      file = refMatch[1]!.trim();
      lineNum = refMatch[2] !== undefined ? Number.parseInt(refMatch[2]!, 10) : undefined;
      desc = refMatch[3]!.trim();
    } else {
      // Step 4: fallback — try PATH_REF when no — separator (mirrors canonical fallback)
      const pathFallback = remaining.match(PATH_REF);
      if (pathFallback) {
        file = pathFallback[1]!.trim();
        lineNum = pathFallback[2] !== undefined ? Number.parseInt(pathFallback[2]!, 10) : undefined;
        const afterFile = remaining.slice(pathFallback[0].length).trim();
        desc = afterFile.replace(/^[—–-]\s*/, '').trim() || remaining;
      } else {
        // No file reference at all — treat entire remaining as description
        desc = remaining;
      }
    }

    // Validate extracted file looks like a path; reset if not
    if (file && !file.includes('/') && !file.includes('\\') && !file.includes('.')) {
      file = undefined;
      desc = remaining;
    }

    const title = desc.split(/\.\s/)[0]!.trim() || desc;
    const fingerprint = computeFingerprint(file ?? '', lineNum ?? null, title);

    findings.push({
      severity: currentSeverity,
      file,
      line: lineNum,
      title,
      fingerprint,
    });
  }

  return findings;
}

function computeFingerprint(file: string, line: number | null, title: string): string {
  const normalizedFile = file.replace(/\\/g, '/').trim().toLowerCase();
  const lineStr = line != null && line >= 0 ? String(line) : '0';
  const normalizedTitle = title
    .trim()
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const hash = createHash('sha256');
  hash.update(`${normalizedFile}:${lineStr}:${normalizedTitle}`);
  return hash.digest('hex');
}

function aggregateSeverities(findings: ParsedFinding[]): Record<string, number> {
  const counts: Record<string, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };
  for (const f of findings) {
    const sev = f.severity;
    if (sev in counts) counts[sev]!++;
  }
  return counts;
}
