import { randomUUID } from 'node:crypto';
import type { InventoryOptions } from '../adapters/interface.js';
import type { TechStackResearcher } from '../research/types.js';
import type { TechStackStore } from '../store/sqlite.js';
import type { Snapshot, TechStackJob, TechStackJobProgress, TechStackJobStatus } from '../types.js';
import { runEnrichPhase, type EnrichOptions } from './enrich-phase.js';
import { runInventoryPhase } from './inventory-phase.js';
import { generateReport, type ReportFormat } from './report-generator.js';
import { runResearchPhase, type ResearchPhaseOptions } from './research-phase.js';

export type { EnrichOptions } from './enrich-phase.js';
export type { ReportFormat } from './report-generator.js';

export interface AnalyzeOptions {
  readonly targetRoot: string;
  readonly sessionId?: string | undefined;
  readonly requestedBy?: string | undefined;
  readonly online?: boolean | undefined;
  readonly autoDeliver?: boolean | undefined;
  readonly jobId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((phase: string, completed: number, total: number) => void) | undefined;
  readonly researcher?: TechStackResearcher | undefined;
  readonly researchLimit?: number | undefined;
  readonly includeTransitive?: boolean | undefined;
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
      if (options.online !== false) {
        updateJob('enriching', { phase: 'enriching', completed: 0, total: 1 });
        snapshot = await this.enrich(snapshot, { online: true, signal: options.signal });
        throwIfAborted();
        snapshot = await this.research(snapshot, {
          researcher: options.researcher,
          researchLimit: options.researchLimit,
          signal: options.signal,
          onProgress: (phase, completed, total) => updateJob(phase, { phase, completed, total }),
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
