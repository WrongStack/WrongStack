/**
 * Card 7B-3: Batched LLM scan step extracted from orchestrator.ts.
 *
 * Owns `scanWithLLM` (file batching loop with fileConcurrency + abort
 * checks) and `scanFileBatchLLM` (per-batch fetch + LLM call + JSON parsing).
 * Pure orchestration — the orchestrator drives it via `runBatchScan()`.
 */

import * as path from 'node:path';

import type { Provider, Request } from '@wrongstack/contracts/types';
import {
  readBundledInstructionText,
  renderInstructionTemplate,
  sanitizeJsonString,
  toErrorMessage,
} from '@wrongstack/core/utils';
import type { ErrorHandler, RetryPolicy } from './_compat-types.js';
import { DEFAULT_EXCLUDE_PATTERNS, gatherFiles, readFileHead } from './file-gathering.js';
import { extractJsonBlock } from './json-extractor.js';
import { retryProviderComplete } from './llm-client.js';
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
  retryPolicy?: RetryPolicy | undefined;
  errorHandler?: ErrorHandler | undefined;
}

export class BatchScanner {
  /** Run the full scan: gather → batch → per-batch LLM → sort + summarize. */
  async runBatchScan(options: BatchScannerOptions): Promise<ScanResult> {
    const startTime = Date.now();
    const findings: Finding[] = [];
    const errors: string[] = [];
    const scanStats = { readCount: 0, errors };

    if (options.abortController.signal.aborted) {
      return {
        timestamp: new Date().toISOString(),
        projectRoot: options.projectRoot,
        techStack: options.techStack,
        findings: [],
        summary: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
        scannedFiles: 0,
        scanDurationMs: Date.now() - startTime,
        errors,
      };
    }

    const targetFiles = options.skill.metadata.targetFiles;
    const fallbackExtensions: string[] = [
      '.ts',
      '.js',
      '.jsx',
      '.tsx',
      '.py',
      '.go',
      '.java',
      '.cs',
      '.rs',
    ];
    // Only a `*.ext` last segment is an extension. A named target keeps its
    // glob: reducing `**/requirements*.txt` or `**/CMakeLists.txt` to `.txt`
    // sent every text file to the model, and `**/Gemfile` (no extension) was
    // never read. An all-wildcard segment (`**/*`, `src/**`) narrows nothing.
    const extensions = new Set<string>();
    const includePatterns = new Set<string>();
    for (const target of targetFiles) {
      const normalized = target.replace(/\\/g, '/');
      const baseName = normalized.slice(normalized.lastIndexOf('/') + 1);
      if (/^\*\.[a-z0-9]+$/i.test(baseName)) extensions.add(baseName.slice(1).toLowerCase());
      else if (/[^*?]/.test(baseName)) includePatterns.add(normalized);
    }
    const restricted = extensions.size > 0 || includePatterns.size > 0;
    const maxDepth = options.depth === 'quick' ? 2 : options.depth === 'deep' ? 20 : 5;
    const files = await gatherFiles({
      root: options.projectRoot,
      extensions: restricted ? [...extensions] : fallbackExtensions,
      includePatterns: [...includePatterns],
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
      const batchStats = { readCount: 0, errors };
      const batchFindings = await this.scanFileBatchLLM({
        provider: options.provider,
        model: options.model,
        projectRoot: options.projectRoot,
        files: batch,
        skill: options.skill,
        techStack: options.techStack,
        fileConcurrency,
        abortController: options.abortController,
        retryPolicy: options.retryPolicy,
        errorHandler: options.errorHandler,
        scanStats: batchStats,
      });
      scanStats.readCount += batchStats.readCount;
      // Keep the completed batch's findings: the abort check below stops the
      // NEXT batch, but discarding work the model already produced (while its
      // reads stay counted in scannedFiles) made a cancelled scan report a
      // scanned file with no findings.
      findings.push(...batchFindings);
      if (options.abortController.signal.aborted) break;
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
      scannedFiles: scanStats.readCount,
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
    techStack: TechStackInfo;
    fileConcurrency: number;
    abortController: AbortController;
    retryPolicy?: RetryPolicy | undefined;
    errorHandler?: ErrorHandler | undefined;
    scanStats?: { readCount: number; errors: string[] } | undefined;
  }): Promise<Finding[]> {
    const fileContents: string[] = [];
    const readableFiles: string[] = [];
    for (let index = 0; index < opts.files.length; index += opts.fileConcurrency) {
      const readBatch = opts.files.slice(index, index + opts.fileConcurrency);
      const readResults = await Promise.allSettled(
        readBatch.map(async (file) => {
          const content = await readFileHead(file, SCAN_FILE_HEAD_CHARS);
          const relativePath = path.relative(opts.projectRoot, file).replace(/\\/g, '/');
          return `\n=== ${relativePath} ===\n${content}`;
        }),
      );
      for (const [offset, result] of readResults.entries()) {
        if (result.status === 'fulfilled') {
          fileContents.push(result.value);
          readableFiles.push(readBatch[offset]!);
          if (opts.scanStats) opts.scanStats.readCount++;
        } else if (opts.scanStats) {
          const file = path.relative(opts.projectRoot, readBatch[offset]!).replace(/\\/g, '/');
          opts.scanStats.errors.push(`Failed to read ${file}: ${toErrorMessage(result.reason)}`);
        }
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

        // Non-empty: a batch whose files all failed to read returned above.
        const defaultFile = path.relative(opts.projectRoot, readableFiles[0]!).replace(/\\/g, '/');
        const scannedFiles = new Set(
          readableFiles.map((file) =>
            path.relative(opts.projectRoot, path.resolve(file)).replace(/\\/g, '/'),
          ),
        );
        const validSeverities = ['critical', 'high', 'medium', 'low'] as const;

        // extractJsonBlock(…, 'array') only yields a `[`-delimited block, so
        // this parses to an array or throws into the catch below.
        return parsed
          .filter(
            (item): item is NonNullable<typeof item> => typeof item === 'object' && item !== null,
          )
          .flatMap((item, idx): Finding[] => {
            const rawFile =
              typeof item.file === 'string' && item.file.trim().length > 0
                ? item.file
                : defaultFile;
            const normalizedFile = (
              path.isAbsolute(rawFile) ? path.relative(opts.projectRoot, rawFile) : rawFile
            ).replace(/\\/g, '/');
            if (!scannedFiles.has(normalizedFile)) return [];
            const category = validCategories.includes(item.category as Finding['category'])
              ? (item.category as Finding['category'])
              : 'injection';
            const rawSeverity =
              typeof item.severity === 'string' ? item.severity.toLowerCase() : '';
            const severity: Finding['severity'] = validSeverities.includes(
              rawSeverity as Finding['severity'],
            )
              ? (rawSeverity as Finding['severity'])
              : 'medium';
            const finding: Finding = {
              id: `llm-analysis-${normalizedFile}-${item.line ?? 0}-${idx}`,
              severity,
              category,
              title: typeof item.title === 'string' ? item.title : 'Security Finding',
              description: typeof item.description === 'string' ? item.description : '',
              file: normalizedFile,
              line:
                typeof item.line === 'number' && Number.isFinite(item.line) ? item.line : undefined,
              snippet: typeof item.snippet === 'string' ? item.snippet : undefined,
              remediation:
                typeof item.remediation === 'string'
                  ? item.remediation
                  : 'Review and remediate this finding.',
              patternId: 'llm-analysis',
              confidence: 'high' as const,
            };
            return [finding];
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
      // A batch the model never analysed is not a clean one: report it in the
      // scan's errors, as an unreadable file is. A cancelled scan is not a failure.
      if (!opts.abortController.signal.aborted) {
        const names = opts.files.map((file) =>
          path.relative(opts.projectRoot, file).replace(/\\/g, '/'),
        );
        opts.scanStats?.errors.push(
          `LLM analysis failed for ${names.join(', ')}: ${toErrorMessage(err)}`,
        );
      }
      return [];
    }
  }
}
