import type { Context } from '@wrongstack/core/agent';
import type { Provider, Request } from '@wrongstack/core/types';
import { ConfigError, ProviderError } from '@wrongstack/core/types';
import {
  atomicWrite,
  expectDefined,
  readBundledInstructionText,
  renderInstructionTemplate,
  sanitizeJsonString,
  toErrorMessage,
} from '@wrongstack/core/utils';
import { defaultTechStackDetector } from './detector.js';
import { defaultGitignoreUpdater } from './gitignore-updater.js';
import type { TechStackInfo } from './types.js';
import type { GeneratedSkill } from './skill-generator.js';
import type { ScanResult, Finding } from './scanner.js';
import type { ReportOptions } from './report-generator.js';
import { NETWORK_ERR_RE, type RetryPolicy, type ErrorHandler } from './_compat-types.js';
import { DEFAULT_EXCLUDE_PATTERNS, gatherFiles, readFileHead } from './file-gathering.js';
import { extractJsonBlock } from './json-extractor.js';
import { readdir, mkdir } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

/** Per-file excerpt included in a batch scan prompt. */
const SCAN_FILE_HEAD_CHARS = 2000;

/** Per-file excerpt included in the project-context summary. */
const KEY_FILE_HEAD_CHARS = 1000;

export interface SecurityScannerOptions {
  projectRoot: string;
  scanOptions?: {
    depth?: 'quick' | 'standard' | 'deep' | undefined;
    includeSecrets?: boolean | undefined;
    includeInjection?: boolean | undefined;
    includeConfig?: boolean | undefined;
    includeDependencies?: boolean | undefined;
    llmBatchSize?: number | undefined;
    fileConcurrency?: number | undefined;
  };
  reportOptions?: Partial<ReportOptions> | undefined;
  skipGitignore?: boolean | undefined;
  /** Optional model name to pass to the LLM provider (defaults to the provider's default). */
  model?: string | undefined;
  /**
   * Optional external abort signal. When aborted, all in-flight LLM calls
   * and retry backoff sleeps are cancelled immediately.
   */
  signal?: AbortSignal | undefined;
  /**
   * Optional deadline in milliseconds for the entire scan. When the deadline
   * expires, the effective abort signal fires and the scan stops. Defaults
   * to no timeout (the scan runs until the provider returns or errors).
   */
  timeoutMs?: number | undefined;
}

/** Accepts a full Context or just the provider+model needed for LLM calls. */
export type SecurityScannerContext =
  | Context
  | Provider
  | { provider: Provider; model?: string | undefined };

export interface FullScanResult {
  detectionResult: Awaited<ReturnType<typeof defaultTechStackDetector.detect>>;
  generatedSkill: GeneratedSkill;
  scanResult: ScanResult;
  reportPath: string;
  synthesizedReport?: string | undefined;
  gitignoreResult?: Awaited<ReturnType<typeof defaultGitignoreUpdater.update>> | undefined;
}

/**
 * LLM-powered Security Scanner Orchestrator
 *
 * Flow:
 * 1. Detect tech stack (static)
 * 2. Generate project-specific security skill via LLM
 * 3. Scan code using LLM with generated skill as context
 * 4. Synthesize findings into structured report via LLM
 */
export class SecurityScannerOrchestrator {
  private detector = defaultTechStackDetector;
  private gitignoreUpdater = defaultGitignoreUpdater;

  constructor(
    private readonly retryPolicy?: RetryPolicy,
    private readonly errorHandler?: ErrorHandler,
  ) {}

  /**
   * Wraps provider.complete with retry logic using the injected RetryPolicy.
   */
  private async completeWithRetry(
    provider: Provider,
    request: Request,
    abortController: AbortController,
    attempt = 0,
  ): Promise<Awaited<ReturnType<Provider['complete']>>> {
    const signal = abortController.signal;
    try {
      return await provider.complete(request, { signal });
    } catch (err) {
      if (signal.aborted) throw err;

      const isProviderErr = err instanceof ProviderError;
      const policy = this.retryPolicy;
      const errAsErr = isProviderErr ? err : err instanceof Error ? err : new Error(String(err));

      // No policy or non-retryable error — rethrow immediately
      if (!policy || (!isProviderErr && !NETWORK_ERR_RE.test(errAsErr.message))) {
        throw err;
      }

      const canRetry = policy.shouldRetry(errAsErr, attempt);
      if (!canRetry) throw err;

      // Classify via error handler if available
      if (this.errorHandler) {
        const classified = this.errorHandler.classify(err);
        if (!classified.retryable) throw err;
      }

      const delay = Math.round(
        policy.delayMs(attempt, isProviderErr ? (err as ProviderError) : errAsErr),
      );
      const status = isProviderErr ? (err as ProviderError).status : 0;
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'security_scanner.retry',
          attempt: attempt + 1,
          delayMs: delay,
          status,
          message: errAsErr.message,
          timestamp: new Date().toISOString(),
        }),
      );

      await new Promise<void>((resolve, reject) => {
        if (abortController.signal.aborted) {
          reject(new Error('Retry backoff aborted'));
          return;
        }
        const onAbort = () => {
          clearTimeout(timer);
          reject(new Error('Retry backoff aborted'));
        };
        const timer = setTimeout(() => {
          abortController.signal.removeEventListener('abort', onAbort);
          resolve();
        }, delay);
        abortController.signal.addEventListener('abort', onAbort, { once: true });
      });
      return this.completeWithRetry(provider, request, abortController, attempt + 1);
    }
  }

  /**
   * Run full security scan with LLM assistance.
   * Accepts a full Context (active agent run) or just provider+model (pre-agent session).
   */
  async run(ctx: SecurityScannerContext, options: SecurityScannerOptions): Promise<FullScanResult> {
    const {
      projectRoot,
      reportOptions,
      skipGitignore,
      model: explicitModel,
      signal: externalSignal,
      timeoutMs,
    } = options;
    const provider = 'provider' in ctx && ctx.provider ? ctx.provider : (ctx as never as Provider);
    const model = explicitModel ?? ('model' in ctx ? ctx.model : undefined);

    // Create a shared AbortController that combines the external signal
    // and the optional timeout deadline. All LLM calls and retry backoff
    // sleeps honour this controller.
    const abortController = new AbortController();
    const timeoutId = timeoutMs ? setTimeout(() => abortController.abort(), timeoutMs) : undefined;
    if (externalSignal) {
      if (externalSignal.aborted) {
        abortController.abort();
      } else {
        externalSignal.addEventListener('abort', () => abortController.abort(), { once: true });
      }
    }
    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
    };

    // Step 1: Detect tech stack (static, fast)
    const detectionResult = await this.detector.detect(projectRoot);
    if (detectionResult.detectedStacks.length === 0) {
      throw new ConfigError({
        message: `No supported tech stack detected in ${projectRoot}`,
        code: 'CONFIG_INVALID',
        context: { projectRoot },
      });
    }
    // Non-null assertion is intentional — guard above guarantees non-empty array.
    const techStack = expectDefined(detectionResult.detectedStacks[0]);

    // Step 2: Generate project-specific security skill via LLM
    const generatedSkill = await this.generateSkillLLM(
      provider,
      model,
      projectRoot,
      techStack,
      abortController,
    );

    // Step 3: Scan code using LLM
    const scanResult = await this.scanWithLLM(
      provider,
      model,
      projectRoot,
      generatedSkill,
      techStack,
      options,
      abortController,
    );

    // Step 4: Synthesize report via LLM
    const synthesizedReport = await this.synthesizeReportLLM(
      provider,
      model,
      projectRoot,
      techStack,
      scanResult,
      abortController,
    );

    // Step 5: Write report to file
    const reportPath = await this.writeReport(synthesizedReport, reportOptions);

    // Step 6: Update .gitignore if not skipped
    let gitignoreResult;
    if (!skipGitignore) {
      gitignoreResult = await this.gitignoreUpdater.update();
    }

    try {
      return {
        detectionResult,
        generatedSkill,
        scanResult,
        reportPath,
        synthesizedReport,
        gitignoreResult,
      };
    } finally {
      cleanup();
    }
  }

  /**
   * Generate a project-specific security skill using LLM.
   * The LLM analyzes the project structure and creates tailored security patterns.
   */
  private async generateSkillLLM(
    provider: Provider,
    model: string | undefined,
    projectRoot: string,
    techStack: TechStackInfo,
    abortController: AbortController,
  ): Promise<GeneratedSkill> {
    // Gather project info for LLM context
    const projectInfo = await this.gatherProjectInfo(projectRoot, techStack);

    const prompt = renderInstructionTemplate(
      readBundledInstructionText('security-scanner/generate-skill.md'),
      {
        projectInfo,
        stack: techStack.stack,
        packageManager: techStack.packageManager,
        manifestFile: techStack.manifestFile,
        dependencies: techStack.dependencies
          .slice(0, 20)
          .map((d) => `- ${d.name}@${d.version}`)
          .join('\n'),
        nodeFocus:
          techStack.stack === 'nodejs'
            ? 'Node.js specific: eval, prototype pollution, npm script injection, express middleware issues, passport.js misconfigs'
            : '',
        pythonFocus:
          techStack.stack === 'python'
            ? 'Python specific: pickle deserialization, SQL injection in ORMs, template injection, insecure Django/Flask settings'
            : '',
      },
    );

    const request: Request = {
      model: model ?? 'unknown',
      system: [
        { type: 'text', text: readBundledInstructionText('security-scanner/json-system.md') },
      ],
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 4096,
    };

    try {
      const response = await this.completeWithRetry(provider, request, abortController);
      const text = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');

      // Parse JSON from response
      const jsonBlock = extractJsonBlock(text, 'object');
      if (jsonBlock) {
        const sanitized = sanitizeJsonString(jsonBlock) || jsonBlock;
        const skillData = JSON.parse(sanitized);
        return {
          name: skillData.name || `security-scanner-${techStack.stack}`,
          description: skillData.description || `Security scanner for ${techStack.stack}`,
          version: '1.0.0',
          techStack: techStack.stack,
          content: { type: 'skill', content: JSON.stringify(skillData, null, 2) },
          patterns: skillData.patterns || [],
          metadata: {
            generatedAt: new Date().toISOString(),
            confidence: 0.85,
            targetFiles: skillData.targetFiles || [],
          },
        };
      }
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'security_scanner.skill_generation_failed',
          message: toErrorMessage(err),
          techStack: techStack.stack,
          timestamp: new Date().toISOString(),
        }),
      );
    }

    // Fallback: return basic skill without LLM
    return this.generateFallbackSkill(techStack);
  }

  /**
   * Scan code using LLM with the generated skill as context.
   * The LLM analyzes files and reports security findings.
   */
  private async scanWithLLM(
    provider: Provider,
    model: string | undefined,
    projectRoot: string,
    skill: GeneratedSkill,
    techStack: TechStackInfo,
    options: SecurityScannerOptions,
    abortController: AbortController,
  ): Promise<ScanResult> {
    const startTime = Date.now();
    const findings: Finding[] = [];
    const errors: string[] = [];
    let scannedFiles = 0;

    // Gather files to scan
    const files = await this.gatherFiles(
      projectRoot,
      skill.metadata.targetFiles,
      options.scanOptions?.depth || 'standard',
    );

    // Process files in batches to avoid overwhelming the LLM
    const configuredBatchSize = options.scanOptions?.llmBatchSize ?? 10;
    const batchSize = Number.isFinite(configuredBatchSize)
      ? Math.max(1, Math.floor(configuredBatchSize))
      : 10;
    const configuredConcurrency = options.scanOptions?.fileConcurrency ?? 10;
    const fileConcurrency = Number.isFinite(configuredConcurrency)
      ? Math.max(1, Math.floor(configuredConcurrency))
      : 10;
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      const batchFindings = await this.scanFileBatchLLM(
        provider,
        model,
        projectRoot,
        batch,
        skill,
        techStack,
        fileConcurrency,
        abortController,
      );
      if (abortController.signal.aborted) break;
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
      projectRoot,
      techStack,
      findings,
      summary,
      scannedFiles,
      scanDurationMs: Date.now() - startTime,
      errors,
    };
  }

  /**
   * Scan a batch of files using LLM.
   */
  private async scanFileBatchLLM(
    provider: Provider,
    model: string | undefined,
    projectRoot: string,
    files: string[],
    skill: GeneratedSkill,
    _techStack: TechStackInfo,
    fileConcurrency: number,
    abortController: AbortController,
  ): Promise<Finding[]> {
    const fileContents: string[] = [];
    for (let index = 0; index < files.length; index += fileConcurrency) {
      const readResults = await Promise.allSettled(
        files.slice(index, index + fileConcurrency).map(async (file) => {
          const content = await readFileHead(file, SCAN_FILE_HEAD_CHARS);
          const relativePath = relative(projectRoot, file).replace(/\\/g, '/');
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
        patterns: skill.patterns
          .map((p) => `- ${p.name} (${p.severity}): ${p.description}`)
          .join('\n'),
        files: fileContents.join('\n'),
      },
    );

    try {
      const request: Request = {
        model: model ?? 'unknown',
        system: [
          { type: 'text', text: readBundledInstructionText('security-scanner/json-system.md') },
        ],
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 4096,
      };

      const response = await this.completeWithRetry(provider, request, abortController);
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
            isAbsolute(item.file) ? relative(projectRoot, item.file) : item.file
          ).replace(/\\/g, '/');
          const validCategories: Finding['category'][] = [
            'secrets',
            'injection',
            'config',
            'dependency',
            'filesystem',
          ];
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
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'security_scanner.llm_scan_batch_failed',
          message: toErrorMessage(err),
          fileCount: files.length,
          timestamp: new Date().toISOString(),
        }),
      );
    }

    return [];
  }

  /**
   * Synthesize a comprehensive security report using LLM.
   */
  private async synthesizeReportLLM(
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

      const response = await this.completeWithRetry(provider, request, abortController);
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
      return this.generateBasicReport(projectRoot, techStack, scanResult);
    }
  }

  /**
   * Generate a basic fallback report when LLM synthesis fails.
   */
  private generateBasicReport(
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
   * Write synthesized report to file.
   */
  private async writeReport(
    content: string,
    reportOptions?: Partial<ReportOptions>,
  ): Promise<string> {
    const outputDir = reportOptions?.outputDir || 'security-reports';
    const format = reportOptions?.format || 'markdown';

    try {
      await mkdir(outputDir, { recursive: true });
    } catch {
      // Directory may already exist
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `security-report-${timestamp}.${format}`;
    const filepath = join(outputDir, filename);

    await atomicWrite(filepath, content);
    return filepath;
  }

  /**
   * Gather project info for skill generation.
   */
  private async gatherProjectInfo(projectRoot: string, _techStack: TechStackInfo): Promise<string> {
    const info: string[] = [];

    // Read key project files
    const keyFiles = [
      'package.json',
      'tsconfig.json',
      '.env.example',
      'README.md',
      'CONTRIBUTING.md',
    ];

    for (const file of keyFiles) {
      try {
        const content = await readFileHead(join(projectRoot, file), KEY_FILE_HEAD_CHARS);
        const displayName = file === 'README.md' || file === 'CONTRIBUTING.md' ? 'README' : file;
        info.push(`\n--- ${displayName} ---\n${content}`);
      } catch {
        // File doesn't exist, skip
      }
    }

    // Add directory structure hint
    try {
      const entries = await readdir(projectRoot, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .slice(0, 20);
      info.push(`\n--- Project Directories ---\n${dirs.join(', ')}`);
    } catch {
      // Skip
    }

    return info.join('\n');
  }

  /**
   * Gather files to scan based on patterns.
   */
  private async gatherFiles(
    root: string,
    patterns: string[],
    depth: 'quick' | 'standard' | 'deep',
  ): Promise<string[]> {
    const maxDepth = depth === 'quick' ? 2 : depth === 'deep' ? 20 : 5;
    const extensions = patterns.flatMap((pattern) => {
      const match = pattern.match(/\.[a-z0-9]+$/i);
      return match ? [match[0].toLowerCase()] : [];
    });
    const fallbackExtensions = ['.ts', '.js', '.jsx', '.tsx', '.py', '.go', '.java', '.cs', '.rs'];
    return gatherFiles({
      root,
      extensions: extensions.length > 0 ? [...new Set(extensions)] : fallbackExtensions,
      maxDepth,
      excludePatterns: DEFAULT_EXCLUDE_PATTERNS,
      excludeHidden: true,
    });
  }

  /**
   * Generate fallback skill when LLM fails.
   */
  private generateFallbackSkill(techStack: TechStackInfo): GeneratedSkill {
    return {
      name: `security-scanner-${techStack.stack}`,
      description: `Security scanner for ${techStack.stack} projects`,
      version: '1.0.0',
      techStack: techStack.stack,
      content: { type: 'skill', content: 'Fallback static skill' },
      patterns: [
        {
          id: 'hardcoded-secrets',
          name: 'Hardcoded Secrets',
          severity: 'critical',
          description: 'Detects hardcoded API keys, tokens, passwords',
          patterns: [],
          fileExtensions: ['.ts', '.js', '.env'],
          falsePositiveMarkers: [],
          remediation: 'Use environment variables',
          category: 'secrets',
          confidence: 'medium',
        },
      ],
      metadata: {
        generatedAt: new Date().toISOString(),
        confidence: 0.5,
        targetFiles: [
          `**/*.${techStack.stack === 'nodejs' ? 'ts' : techStack.stack === 'python' ? 'py' : 'ts'}`,
        ],
      },
    };
  }

  /**
   * Quick scan - legacy compatibility.
   * NOTE: This won't use LLM as it doesn't have access to ctx.
   */
  async quickScan(projectRoot: string): Promise<ScanResult> {
    const detectionResult = await this.detector.detect(projectRoot);
    if (detectionResult.detectedStacks.length === 0) {
      throw new ConfigError({
        message: `No supported tech stack detected in ${projectRoot}`,
        code: 'CONFIG_INVALID',
        context: { projectRoot },
      });
    }
    const techStack = expectDefined(detectionResult.detectedStacks[0]);

    // Return minimal result - actual scanning requires LLM context
    return {
      timestamp: new Date().toISOString(),
      projectRoot,
      techStack,
      findings: [],
      summary: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
      scannedFiles: 0,
      scanDurationMs: 0,
      errors: [
        'Quick scan without LLM context is not fully supported. Use run(ctx, options) for full scan.',
      ],
    };
  }
}

export const defaultOrchestrator = new SecurityScannerOrchestrator();
