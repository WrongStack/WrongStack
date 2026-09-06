import { join } from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import type { Provider, Request } from '@wrongstack/core/types';
import { ConfigError } from '@wrongstack/core/types';
import { expectDefined } from '@wrongstack/core/utils';
import type { ErrorHandler, RetryPolicy } from './_compat-types.js';
import { BatchScanner } from './batch-scanner.js';
import { ReportWriter } from './report-writer.js';
import { SkillGenerator } from './skill-generator.js';
import { defaultTechStackDetector } from './detector.js';
import { GitignoreUpdater, defaultGitignoreUpdater } from './gitignore-updater.js';
import { retryProviderComplete } from './llm-client.js';
import type { ReportOptions } from './report-generator.js';
import type { ScanResult } from './scanner.js';
import type {
  GeneratedSkill,
  GitignoreUpdateResult,
  TechStackDetectionResult,
  TechStackInfo,
} from './types.js';

/** Card 7B-5: 3-phase pipeline sequencer. All LLM-bearing phases delegate to
 *  extracted modules; this file is the orchestration glue only. */

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
  model?: string | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

export type SecurityScannerContext =
  | Context
  | Provider
  | { provider: Provider; model?: string | undefined };

export interface FullScanResult {
  detectionResult: TechStackDetectionResult;
  generatedSkill: GeneratedSkill;
  scanResult: ScanResult;
  reportPath: string;
  synthesizedReport: string;
  gitignoreResult?: GitignoreUpdateResult | undefined;
  durationMs?: number;
}

export class SecurityScannerOrchestrator {
  private readonly detector = defaultTechStackDetector;
  private readonly gitignoreUpdater = defaultGitignoreUpdater;
  private readonly batchScanner = new BatchScanner();
  private readonly reportWriter = new ReportWriter({
    provider: undefined as unknown as Provider,
    completeWithRetry: (provider, request, abortController) =>
      this.completeWithRetry(provider, request, abortController),
  });
  private readonly skillGenerator = new SkillGenerator({
    provider: undefined as unknown as Provider,
    completeWithRetry: (provider, request, abortController) =>
      this.completeWithRetry(provider, request, abortController),
  });

  constructor(
    private readonly retryPolicy?: RetryPolicy,
    private readonly errorHandler?: ErrorHandler,
  ) {}

  /** LLM-retry shim — wraps provider.complete with the orchestrator's policy. */
  private completeWithRetry(
    provider: Provider,
    request: Request,
    abortController: AbortController,
    _attempt: number = 0,
  ): Promise<Awaited<ReturnType<Provider['complete']>>> {
    void _attempt;
    return retryProviderComplete({
      provider,
      request,
      abortController,
      retryPolicy: this.retryPolicy,
      errorHandler: this.errorHandler,
    });
  }

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

    const startMs = Date.now();
    const abortController = new AbortController();

    let timeoutId: NodeJS.Timeout | undefined;
    const onAbort = () => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
      abortController.abort();
    };

    if (externalSignal?.aborted) {
      abortController.abort();
    } else {
      if (externalSignal) {
        externalSignal.addEventListener('abort', onAbort, { once: true });
      }
      if (timeoutMs) {
        timeoutId = setTimeout(() => abortController.abort(), timeoutMs);
      }
    }

    try {
      // Phase 1: tech-stack detection (static, deterministic).
      const detectionResult = await this.detector.detect(projectRoot);
      if (detectionResult.detectedStacks.length === 0) {
        throw new ConfigError({
          message: `No supported tech stack detected in ${projectRoot}`,
          code: 'CONFIG_INVALID',
          context: { projectRoot },
        });
      }
      const techStack: TechStackInfo = expectDefined(detectionResult.detectedStacks[0]);

      // Phase 2: skill generation (LLM-rendered with static fallback).
      const generatedSkill = await this.skillGenerator.generateSkillLLM(
        provider,
        model,
        projectRoot,
        techStack,
        abortController,
      );

      // Phase 3: batch scan (LLM-per-batch with severity summary).
      const scanResult = await this.batchScanner.runBatchScan({
        provider,
        model,
        projectRoot,
        skill: generatedSkill,
        techStack,
        depth: options.scanOptions?.depth || 'standard',
        llmBatchSize: options.scanOptions?.llmBatchSize,
        fileConcurrency: options.scanOptions?.fileConcurrency,
        abortController,
        retryPolicy: this.retryPolicy,
        errorHandler: this.errorHandler,
      });

      // Phase 4: report synthesis + write (LLM-rendered markdown with fallback).
      const synthesizedReport = await this.reportWriter.synthesizeReportLLM(
        provider,
        model,
        projectRoot,
        techStack,
        scanResult,
        abortController,
      );
      const reportPath = await this.reportWriter.writeReport(
        synthesizedReport,
        projectRoot,
        reportOptions,
      );

      let gitignoreResult: GitignoreUpdateResult | undefined;
      if (!skipGitignore) {
        if (this.gitignoreUpdater !== defaultGitignoreUpdater) {
          gitignoreResult = await this.gitignoreUpdater.update();
        } else {
          const outputDir = reportOptions?.outputDir || 'security-reports';
          const updater = new GitignoreUpdater({
            gitignorePath: join(projectRoot, '.gitignore'),
            entries: [`${outputDir}/`, `${outputDir}/*`],
          });
          gitignoreResult = await updater.update();
        }
      }

      return {
        detectionResult,
        generatedSkill,
        scanResult,
        reportPath,
        synthesizedReport,
        gitignoreResult,
        durationMs: Date.now() - startMs,
      };
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onAbort);
      }
    }
  }

  /** Quick scan — legacy entry point that does not require a full LLM context. */
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

  // Backward-compat re-exports so existing callers and tests can still reach
  // helper types without importing from the inner modules directly.
  reexportForCompat = {
    ReportWriter,
    SkillGenerator,
    BatchScanner,
  } as const;
}

export const defaultOrchestrator = new SecurityScannerOrchestrator();
