/**
 * Card 7B-3: Batched LLM scan step extracted from orchestrator.ts.
 *
 * Owns `scanWithLLM` (file batching loop with fileConcurrency + abort
 * checks) and `scanFileBatchLLM` (per-batch fetch + LLM call + JSON parsing).
 * Pure orchestration — the orchestrator drives it via `runBatchScan()`.
 */

import * as path from 'node:path';

import type { Provider, Request } from '@wrongstack/core/types';

import { retryProviderComplete } from './llm-client.js';
import { extractJsonBlock } from './json-extractor.js';
import {
  readBundledInstructionText,
  renderInstructionTemplate,
  sanitizeJsonString,
  toErrorMessage,
} from '@wrongstack/core/utils';
import { DEFAULT_EXCLUDE_PATTERNS, gatherFiles, readFileHead } from './file-gathering.js';
import type { Finding, ScanResult } from './scanner.js';
import type { GeneratedSkill } from './skill-generator.js';
import type { TechStackInfo } from './types.js';

const SCAN_FILE_HEAD_CHARS = 2000;

export interface BatchScannerOptions {
  provider: Provider;
  model: string | undefined;
  projectRoot: string;
  skill: GeneratedSkill;
  techStack: TechStackInfo;
  depth: 'quick' | 'standard' | 'deep' | undefined;
  llmBatchSize: number | undefined;
  fileConcurrency: number | undefined;
  abortController: AbortController;
  excludePatterns?: readonly string[] | undefined;
}

export class BatchScanner {
  /** Run the full scan: gather → batch → per-batch LLM → sort + summarize. */
  async runBatchScan(options: BatchScannerOptions): Promise<ScanResult> {
    const startTime = Date.now();
    const findings: Finding[] = [];
    const errors: string[] = [];
    let scannedFiles = 0;

    const targetFiles = options.skill.metadata.targetFiles;
    const fallbackExtensions: string[] = [
      '.ts', '.js', '.jsx', '.tsx', '.py', '.go', '.java', '.cs', '.rs',
    ];
    const extensions: string[] = Array.from(
      new Set(
        targetFiles
          .map((p: string) => {
            const match = p.match(/\.[a-z0-9]+$/i);
            return match ? [match[0].toLowerCase()] : [];
          })
          .flat(),
      ),
    );
    const maxDepth =
      options.depth === 'quick' ? 2 : options.depth === 'deep' ? 20 : 5;
    const files = await gatherFiles({
      root: options.projectRoot,
      extensions: extensions.length > 0 ? extensions : fallbackExtensions,
      maxDepth,
      excludePatterns: [...(options.excludePatterns ?? DEFAULT_EXCLUDE_PATTERNS)],
      excludeHidden: true,
    });

    const configuredBatchSize = options.llmBatchSize ?? 10;
    const batchSize = Number.isFinite(configuredBatchSize)
      ? Math.max(1, Math.floor(configuredBatchSize))
      : 10;
    const configuredConcurrency = options.fileConcurrency ?? 10;
    const fileConcurrency = Number.isFinite(configuredConcurrency)
      ? Math.max(1, Math.floor(configuredConcurrency))
      : 10;

    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      const batchFindings = await this.scanFileBatchLLM({
        provider: options.provider,
        model: options.model,
        projectRoot: options.projectRoot,
        files: batch,
        skill: options.skill,
        _techStack: options._techStack,
        fileConcurrency,
        abortController: options.abortController,
      });
      if (options.abortController.signal.aborted) break;
      findings.push(...batchFindings);
      scannedFiles += batch.length;
    }

    // Sort by severity
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    findings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

    const summary = {
      critical: findings.filter((f) => f.severity === 'critical').length,
      high: findings.filter((f) => f.severity === 'high').length,
      medium: findings.filter((f) => f.severity === 'medium').length,
      low: findings.filter((f) => f.severity === 'low').length,
      total: findings.length,
    };

    return {
      timestamp: new Date().toISOString(),
      projectRoot: options.projectRoot,
      techStack: options.techStack,
      findings,
      summary,
      scannedFiles,
      scanDurationMs: Date.now() - startTime,
      errors,
    };
  }

  /** Read every file's head with bounded concurrency, then ask the LLM. */
  private async scanFileBatchLLM(opts: {
    provider: Provider;
    model: string | undefined;
    projectRoot: string;
    files: string[];
    skill: GeneratedSkill;
    _techStack: TechStackInfo;
    fileConcurrency: number;
    abortController: AbortController;
    retryPolicy: import('./_compat-types.js').RetryPolicy | undefined;
    errorHandler: import('./_compat-types.js').ErrorHandler | undefined;
  }): Promise<Finding[]> {
    const fileContents: string[] = [];
    for (let index = 0; index < opts.files.length; index += opts.fileConcurrency) {
      const readResults = await Promise.allSettled(
        opts.files.slice(index, index + opts.fileConcurrency).map(async (file) => {
          const content = await readFileHead(file, SCAN_FILE_HEAD_CHARS);
          const relativePath = path.relative(opts.projectRoot, file).replace(/\\/g, '/');
          return `\n=== ${relativePath} ===\n${content}`;
        }),
      );
      for (const result of readResults) {
        if (result.status === 'fulfilled') fileContents.push(result.value);
      }
    }

    if (fileContents.length === 0) return [];

    const prompt = renderInstructionTemplate(
      readBundledInstructionText('security-scanner/analyze-batch.md'),
      {
        patterns: opts.skill.patterns
          .map((p) => `- ${p.name} (${p.severity}): ${p.description}`)
          .join('\n'),
        files: fileContents.join('\n'),
      },
    );

    const validCategories: Finding['category'][] = [
      'secrets',
      'injection',
      'config',
      'dependency',
      'filesystem',
    ];

    try {
      const request: Request = {
        model: opts.model ?? 'unknown',
        system: [
          { type: 'text', text: readBundledInstructionText('security-scanner/json-system.md') },
        ],
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 4096,
      };

      const response = await retryProviderComplete({
        provider: opts.provider,
        request,
        abortController: opts.abortController,
        retryPolicy: opts.retryPolicy,
        errorHandler: opts.errorHandler,
      });
      const text = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');

      const jsonBlock = extractJsonBlock(text, 'array');
      if (jsonBlock) {
        const sanitized = sanitizeJsonString(jsonBlock) || jsonBlock;
        const parsed = JSON.parse(sanitized) as Array<{
          file: string;
          line?: number | undefined;
          severity: 'critical' | 'high' | 'medium' | 'low';
          category?: string | undefined;
          title: string;
          description: string;
          snippet?: string | undefined;
          remediation: string;
        }>;

        return parsed.map((item, idx) => {
          const normalizedFile = (
            isAbsolute(item.file) ? path.relative(opts.projectRoot, item.file) : item.file
          ).replace(/\\/g, '/');
          const category = validCategories.includes(item.category as Finding['category'])
            ? (item.category as Finding['category'])
            : 'injection';
          return {
            id: `llm-analysis-${normalizedFile}-${item.line ?? 0}-${idx}`,
            severity: item.severity,
            category,
            title: item.title,
            description: item.description,
            file: normalizedFile,
            line: item.line,
            snippet: item.snippet,
            remediation: item.remediation,
            patternId: 'llm-analysis',
            confidence: 'high' as const,
          };
        });
      }
      return [];
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'security_scanner.llm_scan_batch_failed',
          message: toErrorMessage(err),
          fileCount: opts.files.length,
          timestamp: new Date().toISOString(),
        }),
      );
      return [];
    }
  }
}
