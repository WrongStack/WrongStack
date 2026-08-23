/**
 * Card 7B-4: report synthesis + write file extracted from orchestrator.ts.
 *
 * Owns the post-scan pipeline:
 *  - `synthesizeReportLLM` (LLM-rendered markdown with fallback)
 *  - `generateBasicReport` (safe static fallback when LLM fails)
 *  - `writeReport` (atomic file write under configured outputDir)
 *
 * Pure module — no class state, no orchestration concerns. The
 * orchestrator drives it via `synthesizeAndWriteReport()`.
 */

import * as path from 'node:path';

import type { Provider, Request } from '@wrongstack/core/types';
import {
  atomicWrite,
  readBundledInstructionText,
  renderInstructionTemplate,
  toErrorMessage,
} from '@wrongstack/core/utils';

import { retryProviderComplete } from './llm-client.js';
import type { ScanResult } from './scanner.js';
import type { ReportOptions } from './report-generator.js';
import type { TechStackInfo } from './types.js';

const { mkdir } = require('node:fs/promises') as {
  mkdir: (path: string, opts: { recursive: boolean }) => Promise<void>;
};
// The `require` form above is the only deviation from the orchestrator's
// `import { mkdir, readdir } from 'node:fs/promises'` — the dynamic form
// keeps `report-writer.ts` free of side-effectful top-level imports that
// would defeat Vite's dependency-graph boundary checks. The function
// interface is identical.

export interface ReportWriterDeps {
  /** Provider used when callers don't have an orchestrator-injected one (CLI, scanner). */
  provider?: Provider;
  /** LLM retry helper — pass orchestrator's `completeWithRetry` closure. */
  completeWithRetry(
    provider: Provider,
    request: Request,
    abortController: AbortController,
  ): Promise<Awaited<ReturnType<Provider['complete']>>>;
}

/**
 * LLM-rendered markdown synthesis of a security scan. Returns the
 * markdown body; orchestration chooses when/where to write it.
 */
export async function synthesizeReportLLM(
  deps: ReportWriterDeps,
  provider: Provider,
  model: string | undefined,
  projectRoot: string,
  techStack: TechStackInfo,
  scanResult: ScanResult,
  abortController: AbortController,
): Promise<string> {
  const prompt = renderInstructionTemplate(
    readBundledInstructionText('security-scanner/synthesize-report.md'),
    {
      scannedFiles: String(scanResult.scannedFiles),
      totalFindings: String(scanResult.summary.total),
      critical: String(scanResult.summary.critical),
      high: String(scanResult.summary.high),
      medium: String(scanResult.summary.medium),
      low: String(scanResult.summary.low),
      findings: scanResult.findings
        .map(
          (f, i) => `
${i + 1}. [${f.severity.toUpperCase()}] ${f.title}
   File: ${f.file}${f.line ? `:${f.line}` : ''}
   Category: ${f.category}
   Description: ${f.description}
   ${f.snippet ? `Code: \`\`\`\n${f.snippet}\n\`\`\`` : ''}
   Remediation: ${f.remediation}
`,
        )
        .join('\n'),
      projectRoot,
      stack: techStack.stack,
      packageManager: techStack.packageManager,
    },
  );

  try {
    const request: Request = {
      model: model ?? 'unknown',
      system: [
        { type: 'text', text: readBundledInstructionText('security-scanner/report-system.md') },
      ],
      messages: [{ role: 'user', content: prompt }],
      // No explicit cap: the provider adapter resolves this model's real
      // `limit.output` from the catalog. A hardcoded 8192 truncated the
      // report on every model that can write a longer one.
    };

    const response = await deps.completeWithRetry(provider, request, abortController);
    return response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'security_scanner.report_synthesis_failed',
        message: toErrorMessage(err),
        findingsCount: scanResult.findings.length,
        timestamp: new Date().toISOString(),
      }),
    );
    // Fallback to basic report
    return generateBasicReport(projectRoot, techStack, scanResult);
  }
}

/** Static fallback report — safe markdown produced without LLM. */
export function generateBasicReport(
  projectRoot: string,
  techStack: TechStackInfo,
  scanResult: ScanResult,
): string {
  const lines: string[] = [];
  lines.push('# Security Scan Report');
  lines.push('');
  lines.push(`**Generated:** ${new Date(scanResult.timestamp).toLocaleString()}`);
  lines.push(`**Project:** ${projectRoot}`);
  lines.push(`**Tech Stack:** ${techStack.stack} (${techStack.packageManager})`);
  lines.push(`**Scanned Files:** ${scanResult.scannedFiles}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Severity | Count |');
  lines.push('|----------|-------|');
  lines.push(`| 🔴 Critical | ${scanResult.summary.critical} |`);
  lines.push(`| 🟠 High | ${scanResult.summary.high} |`);
  lines.push(`| 🟡 Medium | ${scanResult.summary.medium} |`);
  lines.push(`| 🟢 Low | ${scanResult.summary.low} |`);
  lines.push('');

  for (const finding of scanResult.findings) {
    const emoji =
      finding.severity === 'critical'
        ? '🔴'
        : finding.severity === 'high'
          ? '🟠'
          : finding.severity === 'medium'
            ? '🟡'
            : '🟢';
    lines.push(`## ${emoji} ${finding.title}`);
    lines.push('');
    lines.push(`**File:** \`${finding.file}${finding.line ? `:${finding.line}` : ''}\``);
    lines.push(`**Severity:** ${finding.severity.toUpperCase()}`);
    lines.push(`**Category:** ${finding.category}`);
    lines.push('');
    if (finding.snippet) {
      lines.push('```');
      lines.push(finding.snippet);
      lines.push('```');
      lines.push('');
    }
    lines.push(`**Remediation:** ${finding.remediation}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Atomic-write the rendered markdown under `<projectRoot>/<outputDir>/...`
 * with an ISO timestamp filename. Returns the absolute path. Output
 * is rooted at `path.join(projectRoot, outputDir)` — `projectRoot` was
 * previously an unused parameter; this restore brings it back into
 * use so callers can pin the report directory per scan root.
 */
export async function writeReport(
  content: string,
  projectRoot: string,
  reportOptions?: Partial<ReportOptions>,
): Promise<string> {
  const configuredOutputDir = reportOptions?.outputDir || 'security-reports';
  const outputDir = path.isAbsolute(configuredOutputDir)
    ? configuredOutputDir
    : path.join(projectRoot, configuredOutputDir);
  const format = reportOptions?.format || 'markdown';

  try {
    await mkdir(outputDir, { recursive: true });
  } catch {
    // Directory may already exist
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `security-report-${timestamp}.${format}`;
  const filepath = path.join(outputDir, filename);

  await atomicWrite(filepath, content);
  return filepath;
}

/**
 * Cast-free class wrapper around the free-function helpers above so
 * `orchestrator.ts` can compose them under a single instance field.
 * Construct via `new ReportWriter({ completeWithRetry: this.completeWithRetry.bind(this) })`.
 */
export class ReportWriter {
  constructor(private readonly deps: ReportWriterDeps) {}

  synthesizeReportLLM(
    provider: Provider,
    model: string | undefined,
    projectRoot: string,
    techStack: import('./types.js').TechStackInfo,
    scanResult: ScanResult,
    abortController: AbortController,
  ): Promise<string> {
    return synthesizeReportLLM(
      this.deps,
      provider,
      model,
      projectRoot,
      techStack,
      scanResult,
      abortController,
    );
  }

  generateBasicReport(
    projectRoot: string,
    techStack: import('./types.js').TechStackInfo,
    scanResult: ScanResult,
  ): string {
    return generateBasicReport(projectRoot, techStack, scanResult);
  }

  writeReport(
    content: string,
    projectRoot: string,
    reportOptions?: Partial<ReportOptions>,
  ): Promise<string> {
    return writeReport(content, projectRoot, reportOptions);
  }
}

export { retryProviderComplete };
