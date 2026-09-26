import { randomUUID } from 'node:crypto';
import type { InventoryOptions } from '../adapters/interface.js';
import type { ResearchPartial, TechStackResearcher } from '../research/types.js';
import type { TechStackStore } from '../store/sqlite.js';
import type { Snapshot, TechStackJob, TechStackJobProgress, TechStackJobStatus } from '../types.js';
import { type EnrichOptions, runEnrichPhase } from './enrich-phase.js';
import { runInventoryPhase } from './inventory-phase.js';
import { generateReport, type ReportFormat } from './report-generator.js';
import { type ResearchPhaseOptions, runResearchPhase } from './research-phase.js';

export type { EnrichOptions } from './enrich-phase.js';
export type { ReportFormat } from './report-generator.js';

/**
 * How far down the pipeline `analyze()` runs.
 *
 * `inventory` is the deterministic manifest+lockfile read — no network, no
 * LLM. `enrich` adds the registry/OSV audit lookup but skips the LLM stage,
 * which is the right "are we vulnerable?" dry-run. `full` runs everything
 * including the LLM researcher; it is the only depth that produces
 * interpretation findings (severity != deterministic).
 */
export type AnalyzeDepth = 'inventory' | 'enrich' | 'full';

export interface AnalyzeOptions {
  readonly targetRoot: string;
  readonly sessionId?: string | undefined;
  readonly requestedBy?: string | undefined;
  /** Deprecated alias for `depth`. `true` ≡ `full`, `false` ≡ `inventory`. */
  readonly online?: boolean | undefined;
  /** Pipeline depth. Wins over `online` when both are set. */
  readonly depth?: AnalyzeDepth | undefined;
  /**
   * Model id chosen by the user for this run. Persisted on the job row for
   * audit; the engine itself does not bind it (the `getLlm()` accessor at the
   * caller decides what provider/model is actually used).
   */
  readonly model?: string | undefined;
  readonly autoDeliver?: boolean | undefined;
  readonly jobId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((phase: string, completed: number, total: number) => void) | undefined;
  /**
   * Streaming per-dependency research progress. The HTTP layer forwards each
   * call to the WS layer as `techstack.research.partial`. Absent when the
   * caller has no WS surface wired (CLI/embedded).
   */
  readonly onResearchPartial?: ((partial: ResearchPartial) => void) | undefined;
  readonly researcher?: TechStackResearcher | undefined;
  readonly researchLimit?: number | undefined;
  readonly includeTransitive?: boolean | undefined;
}

/** Resolve `depth` from the (deprecated) `online` flag and the explicit value. */
export function resolveAnalyzeDepth(options: AnalyzeOptions): AnalyzeDepth {
  if (options.depth) return options.depth;
  if (options.online === undefined) return 'full';
  return options.online ? 'full' : 'inventory';
}

export class TechStackEngine {
  constructor(private readonly store: TechStackStore) {}

  inventory(
    projectId: string,
    targetRoot: string,
    _jobId?: string,
    onProgress?: (phase: string, completed: number, total: number) => void,
    options: InventoryOptions = {},
  ): Promise<Snapshot> {
    return runInventoryPhase(this.store, projectId, targetRoot, { ...options, onProgress });
  }

  enrich(snapshot: Snapshot, options: EnrichOptions = {}): Promise<Snapshot> {
    return runEnrichPhase(snapshot, options);
  }

  research(snapshot: Snapshot, options: ResearchPhaseOptions = {}): Promise<Snapshot> {
    return runResearchPhase(snapshot, options);
  }

  generateReport(snapshot: Snapshot, format: ReportFormat = 'md'): string {
    return generateReport(snapshot, format);
  }

  async analyze(
    projectId: string,
    options: AnalyzeOptions,
  ): Promise<{ snapshot: Snapshot; job: TechStackJob }> {
    const jobId = options.jobId ?? randomUUID();
    const depth = resolveAnalyzeDepth(options);
    const job: TechStackJob = {
      id: jobId,
      projectId,
      targetRoot: options.targetRoot,
      kind: 'analyze',
      status: 'queued',
      fingerprint: '',
      requestedBy: options.requestedBy ?? 'system',
      sessionId: options.sessionId,
      createdAt: new Date().toISOString(),
      progress: { phase: 'queued', completed: 0, total: 0 },
      ...(options.model ? { model: options.model } : {}),
      depth,
    };
    this.store.saveJob(job);
    const updateJob = (status: TechStackJobStatus, progress?: TechStackJobProgress): void => {
      this.store.updateJobStatus(jobId, status, progress);
      if (progress) options.onProgress?.(progress.phase, progress.completed, progress.total);
    };
    const throwIfAborted = (): void => {
      if (options.signal?.aborted) throw new DOMException('TechStack job cancelled', 'AbortError');
    };
    try {
      throwIfAborted();
      updateJob('discovering', { phase: 'discovering', completed: 0, total: 1 });
      let snapshot = await this.inventory(
        projectId,
        options.targetRoot,
        jobId,
        (phase, completed, total) => {
          throwIfAborted();
          updateJob(phase as TechStackJobStatus, { phase, completed, total });
        },
        { includeTransitive: options.includeTransitive, signal: options.signal },
      );
      throwIfAborted();
      if (depth === 'inventory') {
        this.store.saveSnapshot(snapshot);
        updateJob('completed', { phase: 'completed', completed: 1, total: 1 });
        return {
          snapshot,
          job: { ...job, status: 'completed', completedAt: new Date().toISOString() },
        };
      }
      updateJob('enriching', { phase: 'enriching', completed: 0, total: 1 });
      snapshot = await this.enrich(snapshot, { online: true, signal: options.signal });
      throwIfAborted();
      if (depth === 'full') {
        snapshot = await this.research(snapshot, {
          researcher: options.researcher,
          researchLimit: options.researchLimit,
          signal: options.signal,
          onProgress: (phase, completed, total) => updateJob(phase, { phase, completed, total }),
          ...(options.onResearchPartial ? { onPartial: options.onResearchPartial } : {}),
        });
        throwIfAborted();
      }
      this.store.saveSnapshot(snapshot);
      updateJob('completed', { phase: 'completed', completed: 1, total: 1 });
      return {
        snapshot,
        job: { ...job, status: 'completed', completedAt: new Date().toISOString() },
      };
    } catch (error) {
      updateJob(
        options.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')
          ? 'cancelled'
          : 'failed',
      );
      throw error;
    }
  }
}
