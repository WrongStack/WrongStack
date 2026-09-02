import type { Context } from '../core/context.js';
import { ToolCapabilities } from '../security/capabilities.js';
import type { SubagentStructuredReport } from '../types/multi-agent.js';
import type { Tool } from '../types/tool.js';

/** Context metadata key used to hand the submitted report to the task runner. */
export const SUBAGENT_STRUCTURED_REPORT_META_KEY = 'subagentStructuredReport';
export const MAX_SUBAGENT_STRUCTURED_REPORT_CHARS = 8_000;

const MAX_SUMMARY_CHARS = 1_500;
const MAX_FINDINGS = 16;
const MAX_FILES = 64;
const MAX_NEXT_STEPS = 12;
const MAX_ITEM_CHARS = 500;

/**
 * Validate and normalize a model-supplied structured result. The tool executor
 * already applies JSON Schema validation, but this guard keeps direct callers,
 * custom executors, and data read back from Context metadata honest too.
 */
export function normalizeSubagentStructuredReport(
  value: unknown,
): SubagentStructuredReport | undefined {
  if (!isRecord(value)) return undefined;
  const summary = nonEmptyString(value['summary']);
  const findings = stringArray(value['findings']);
  const filesExamined = stringArray(value['files_examined']);
  const nextSteps = stringArray(value['suggested_next_steps']);
  const confidence = value['confidence'];
  const completion = value['completion'];
  const remainingWork = optionalString(value['remaining_work']);
  if (
    !summary ||
    summary.length > MAX_SUMMARY_CHARS ||
    !findings ||
    findings.length > MAX_FINDINGS ||
    !filesExamined ||
    filesExamined.length > MAX_FILES ||
    !nextSteps ||
    nextSteps.length > MAX_NEXT_STEPS ||
    [...findings, ...filesExamined, ...nextSteps].some(
      (item) => item.trim().length > MAX_ITEM_CHARS,
    ) ||
    typeof confidence !== 'number' ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1 ||
    (completion !== undefined && completion !== 'complete' && completion !== 'partial') ||
    (completion === 'partial' && !remainingWork) ||
    (remainingWork !== undefined && remainingWork.length > MAX_SUMMARY_CHARS)
  ) {
    return undefined;
  }
  const report: SubagentStructuredReport = {
    summary,
    findings: findings.map((item) => item.trim()).filter(Boolean),
    files_examined: filesExamined.map((item) => item.trim()).filter(Boolean),
    confidence,
    suggested_next_steps: nextSteps.map((item) => item.trim()).filter(Boolean),
    ...(completion === 'complete' || completion === 'partial' ? { completion } : {}),
    ...(remainingWork ? { remaining_work: remainingWork } : {}),
  };
  return JSON.stringify(report).length <= MAX_SUBAGENT_STRUCTURED_REPORT_CHARS ? report : undefined;
}

export function readSubagentStructuredReport(
  ctx: Pick<Context, 'meta'> | { meta?: Record<string, unknown> } | undefined,
): SubagentStructuredReport | undefined {
  return normalizeSubagentStructuredReport(ctx?.meta?.[SUBAGENT_STRUCTURED_REPORT_META_KEY]);
}

/** Stable compact text form for mailbox/roll-up surfaces. */
export function formatSubagentStructuredReport(report: SubagentStructuredReport): string {
  const findings = report.findings.length
    ? report.findings.map((item) => `- ${item}`).join('\n')
    : '- (none)';
  const files = report.files_examined.length ? report.files_examined.join(', ') : '(none)';
  const next = report.suggested_next_steps.length
    ? report.suggested_next_steps.map((item) => `- ${item}`).join('\n')
    : '- (none)';
  return [
    report.summary,
    report.completion ? `Completion: ${report.completion}` : undefined,
    report.remaining_work ? `Remaining work: ${report.remaining_work}` : undefined,
    `\nFindings:\n${findings}`,
    `\nFiles examined: ${files}`,
    `Confidence: ${report.confidence.toFixed(2)}`,
    `\nSuggested next steps:\n${next}`,
  ]
    .filter((line): line is string => typeof line === 'string')
    .join('\n');
}

/** Safe, task-local handoff channel from a subagent to its Director. */
export function makeSubagentResultTool(): Tool {
  return {
    name: 'submit_result',
    description:
      'Submit the task result as a compact structured report for the Director. Call once near the end, before your final text response.',
    permission: 'auto',
    mutating: false,
    capabilities: [ToolCapabilities.COORDINATION_RESULT_SUBMIT],
    inputSchema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          maxLength: MAX_SUMMARY_CHARS,
          description: 'Concise outcome summary.',
        },
        findings: {
          type: 'array',
          maxItems: MAX_FINDINGS,
          items: { type: 'string' },
          description: 'Atomic findings or changes, with evidence when useful.',
        },
        files_examined: {
          type: 'array',
          maxItems: MAX_FILES,
          items: { type: 'string' },
          description: 'Project-relative files materially read or changed.',
        },
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Confidence from 0.0 to 1.0.',
        },
        suggested_next_steps: {
          type: 'array',
          maxItems: MAX_NEXT_STEPS,
          items: { type: 'string' },
          description: 'Concrete follow-ups; use an empty array when none remain.',
        },
        completion: {
          type: 'string',
          enum: ['complete', 'partial'],
          description:
            'Use `partial` only when the task is intentionally stopping at a clean checkpoint and another worker should continue.',
        },
        remaining_work: {
          type: 'string',
          maxLength: MAX_SUMMARY_CHARS,
          description:
            'Concrete work left for a successor. Required by runtime validation when completion is `partial`.',
        },
      },
      required: ['summary', 'findings', 'files_examined', 'confidence', 'suggested_next_steps'],
      additionalProperties: false,
    },
    async execute(input, ctx) {
      const report = normalizeSubagentStructuredReport(input);
      if (!report) {
        return {
          ok: false,
          error:
            'Invalid report: summary/findings/files_examined/confidence/suggested_next_steps are required and confidence must be 0..1.',
        };
      }
      ctx.meta[SUBAGENT_STRUCTURED_REPORT_META_KEY] = report;
      return {
        ok: true,
        findings: report.findings.length,
        filesExamined: report.files_examined.length,
        confidence: report.confidence,
      };
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : nonEmptyString(value);
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : undefined;
}
