import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite, withFileLock } from '@wrongstack/core/utils';
import {
  type AutomationJob,
  type AutomationJobSpec,
  type AutomationRun,
  type AutomationState,
  validateJobSpec,
} from './contracts.js';
import { nextCronTime, previewSchedule } from './schedule.js';

export class AutomationRevisionConflict extends Error {
  constructor() {
    super('Automation changed; refresh the list and reopen Edit before saving');
  }
}

/** A job cannot be removed while one of its runs is queued or running. */
export class AutomationJobBusy extends Error {
  constructor() {
    super('This automation has a queued or running run; cancel it or wait before deleting');
  }
}

const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_RUNS = 2000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export class AutomationStore {
  readonly file: string;
  constructor(readonly directory: string) {
    this.file = path.join(directory, 'jobs.json');
  }
  private async read(): Promise<AutomationState> {
    let text: string;
    try {
      if ((await stat(this.file)).size > MAX_STATE_BYTES)
        throw new Error('Automation state exceeds 16 MB');
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { version: 1, jobs: [], runs: [] };
      throw error;
    }
    const state = JSON.parse(text) as AutomationState;
    if (
      state?.version !== 1 ||
      !Array.isArray(state.jobs) ||
      !Array.isArray(state.runs) ||
      state.jobs.length > 128 ||
      state.runs.length > MAX_RUNS
    )
      throw new Error('Invalid automation state');
    const jobs = new Set<string>();
    const runs = new Set<string>();
    for (const job of state.jobs) {
      validateJobSpec(job);
      if (
        typeof job.id !== 'string' ||
        !UUID.test(job.id) ||
        !path.isAbsolute(job.projectRoot) ||
        jobs.has(job.id) ||
        !Number.isFinite(job.createdAt) ||
        (job.nextRunAt !== null && !Number.isFinite(job.nextRunAt))
      )
        throw new Error('Invalid automation job record');
      jobs.add(job.id);
    }
    for (const run of state.runs) {
      validateJobSpec(run.job);
      if (
        typeof run.id !== 'string' ||
        !UUID.test(run.id) ||
        runs.has(run.id) ||
        !jobs.has(run.jobId) ||
        run.job.id !== run.jobId ||
        !['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(
          run.status,
        ) ||
        typeof run.subjectKey !== 'string' ||
        typeof run.deliveryKey !== 'string' ||
        typeof run.context !== 'string' ||
        (run.continuationRunId !== undefined &&
          (typeof run.continuationRunId !== 'string' ||
            !UUID.test(run.continuationRunId) ||
            run.continuationRunId === run.id)) ||
        !Number.isFinite(run.createdAt)
      )
        throw new Error('Invalid automation run record');
      if (
        run.status === 'running' &&
        (typeof run.leaseId !== 'string' ||
          !UUID.test(run.leaseId) ||
          typeof run.workerId !== 'string' ||
          !Number.isFinite(run.leaseExpiresAt))
      )
        throw new Error('Invalid automation lease');
      runs.add(run.id);
    }
    return state;
  }
  private async change<T>(update: (state: AutomationState) => T): Promise<T> {
    return withFileLock(this.file, async () => {
      const state = await this.read();
      const before = JSON.stringify(state);
      const result = update(state);
      const text = `${JSON.stringify(state)}\n`;
      if (Buffer.byteLength(text) > MAX_STATE_BYTES)
        throw new Error('Automation state capacity reached');
      if (text !== `${before}\n`) await atomicWrite(this.file, text, { mode: 0o600 });
      return structuredClone(result);
    });
  }
  async snapshot(): Promise<AutomationState> {
    return this.read();
  }
  async add(spec: AutomationJobSpec, now = Date.now()): Promise<AutomationJob> {
    validateJobSpec(spec);
    const projectRoot = await realpath(spec.projectRoot);
    return this.change((state) => {
      if (state.jobs.length >= 128 || state.jobs.some((job) => job.name === spec.name))
        throw new Error('Automation name exists or job capacity reached');
      const job: AutomationJob = {
        ...structuredClone(spec),
        projectRoot,
        id: randomUUID(),
        createdAt: now,
        revision: 1,
        nextRunAt: previewSchedule(spec, now, 1)[0] ?? null,
      };
      state.jobs.push(job);
      return job;
    });
  }
  async update(
    id: string,
    spec: AutomationJobSpec,
    expectedRevision: number,
    now = Date.now(),
  ): Promise<AutomationJob> {
    validateJobSpec(spec);
    const projectRoot = await realpath(spec.projectRoot);
    return this.change((state) => {
      const index = state.jobs.findIndex((job) => job.id === id);
      const previous = state.jobs[index];
      if (!previous || previous.projectRoot !== projectRoot)
        throw new Error('Automation job not found');
      if ((previous.revision ?? 1) !== expectedRevision) throw new AutomationRevisionConflict();
      if (state.jobs.some((job) => job.id !== id && job.name === spec.name))
        throw new Error('Automation name exists');
      const changedSchedule =
        previous.intervalMs !== spec.intervalMs ||
        previous.schedule?.type !== spec.schedule?.type ||
        previous.schedule?.expression !== spec.schedule?.expression ||
        previous.schedule?.timezone !== spec.schedule?.timezone;
      const reenabledWithStaleNextRun =
        !previous.enabled &&
        spec.enabled &&
        (previous.nextRunAt === null || previous.nextRunAt <= now);
      const job = {
        ...structuredClone(spec),
        projectRoot,
        id,
        createdAt: previous.createdAt,
        revision: expectedRevision + 1,
        nextRunAt:
          changedSchedule || reenabledWithStaleNextRun
            ? (previewSchedule(spec, now, 1)[0] ?? null)
            : previous.nextRunAt,
      };
      state.jobs[index] = job;
      return job;
    });
  }
  async setEnabled(
    id: string,
    enabled: boolean,
    expectedRevision?: number,
    projectRoot?: string,
    now = Date.now(),
  ): Promise<void> {
    await this.change((state) => {
      const job = state.jobs.find((item) => item.id === id);
      if (!job) throw new Error('Automation job not found');
      if (projectRoot !== undefined && job.projectRoot !== projectRoot)
        throw new Error('Automation job not found');
      if (expectedRevision !== undefined && (job.revision ?? 1) !== expectedRevision)
        throw new AutomationRevisionConflict();
      if (!job.enabled && enabled && (job.nextRunAt === null || job.nextRunAt <= now)) {
        job.nextRunAt = previewSchedule(job, now, 1)[0] ?? null;
      }
      job.enabled = enabled;
      job.revision = (job.revision ?? 1) + 1;
    });
  }
  private enqueueIn(
    state: AutomationState,
    job: AutomationJob,
    trigger: AutomationRun['trigger'],
    key: string,
    subjectKey: string,
    context: string,
    now: number,
    payloadHash?: string,
  ): AutomationRun {
    if (payloadHash !== undefined && !/^[a-f0-9]{64}$/.test(payloadHash))
      throw new Error('Invalid event payload fingerprint');
    const existing = state.runs.find((run) => run.jobId === job.id && run.deliveryKey === key);
    if (existing) {
      if (
        existing.subjectKey !== subjectKey ||
        existing.context !== context ||
        existing.trigger !== trigger ||
        existing.payloadHash !== payloadHash
      )
        throw new Error('Delivery ID reused for another payload');
      return existing;
    }
    if (payloadHash) {
      const duplicate = state.runs.find(
        (run) =>
          run.jobId === job.id &&
          run.subjectKey === subjectKey &&
          run.payloadHash === payloadHash &&
          run.trigger === trigger &&
          run.context === context,
      );
      if (duplicate) return duplicate;
    }
    if (state.runs.length >= MAX_RUNS)
      throw new Error('Automation run capacity reached; export and prune completed history');
    if (!job.enabled) throw new Error('Automation job is disabled');
    if (
      !key ||
      key.length > 256 ||
      !subjectKey ||
      subjectKey.length > 512 ||
      context.length > 16_384
    )
      throw new Error('Automation trigger exceeds its bounds');
    const run: AutomationRun = {
      id: randomUUID(),
      jobId: job.id,
      job: structuredClone(job),
      subjectKey,
      trigger,
      deliveryKey: key,
      payloadHash,
      context,
      createdAt: now,
      status: 'queued',
    };
    state.runs.push(run);
    return run;
  }
  async enqueue(
    id: string,
    trigger: AutomationRun['trigger'] = 'manual',
    key: string = randomUUID(),
    subjectKey = 'default',
    context = '',
    now = Date.now(),
    payloadHash?: string,
    projectRoot?: string,
    expectedRevision?: number,
  ): Promise<AutomationRun> {
    return this.change((state) => {
      const job = state.jobs.find((item) => item.id === id);
      if (!job) throw new Error('Automation job not found');
      if (projectRoot !== undefined && job.projectRoot !== projectRoot)
        throw new Error('Automation job not found');
      if (expectedRevision !== undefined && (job.revision ?? 1) !== expectedRevision)
        throw new AutomationRevisionConflict();
      return this.enqueueIn(state, job, trigger, key, subjectKey, context, now, payloadHash);
    });
  }
  async scheduleDue(now = Date.now()): Promise<void> {
    await this.change((state) => {
      for (const job of state.jobs) {
        if (
          !job.enabled ||
          (!job.intervalMs && !job.schedule) ||
          job.nextRunAt === null ||
          job.nextRunAt > now
        )
          continue;
        const due = job.nextRunAt;
        this.enqueueIn(state, job, 'schedule', `schedule:${due}`, 'schedule', '', now);
        // Coalesce downtime rather than dispatching a catch-up storm.
        job.nextRunAt = job.schedule
          ? nextCronTime(job.schedule, now)
          : due + (Math.floor((now - due) / job.intervalMs!) + 1) * job.intervalMs!;
      }
    });
  }
  /** A repair continues one exact successful run using the still-current frozen job revision. */
  async enqueueCIRepair(
    sourceRunId: string,
    context: string,
    payloadHash: string,
  ): Promise<AutomationRun> {
    return this.change((state) => {
      const source = state.runs.find((run) => run.id === sourceRunId);
      if (source?.status !== 'completed' || source.result?.validation.status !== 'passed')
        throw new Error('Verified CI repair source is unavailable');
      const job = state.jobs.find((job) => job.id === source.jobId);
      if (
        !job ||
        job.projectRoot !== source.job.projectRoot ||
        (job.revision ?? 1) !== (source.job.revision ?? 1)
      )
        throw new AutomationRevisionConflict();
      const run = this.enqueueIn(
        state,
        job,
        'github',
        `ci-repair:${source.id}:${payloadHash}`,
        source.subjectKey,
        context,
        Date.now(),
        payloadHash,
      );
      if (run.continuationRunId !== undefined && run.continuationRunId !== source.id)
        throw new Error('CI repair continuation identity changed');
      run.continuationRunId = source.id;
      return run;
    });
  }
  async claim(workerId: string, now = Date.now(), leaseMs = 60_000): Promise<AutomationRun | null> {
    return this.change((state) => {
      const run = state.runs.find(
        (candidate) =>
          candidate.status === 'queued' &&
          state.jobs.some((job) => job.id === candidate.jobId && job.enabled) &&
          !state.runs.some(
            (active) =>
              active.status === 'running' &&
              active.jobId === candidate.jobId &&
              active.subjectKey === candidate.subjectKey,
          ),
      );
      if (!run) return null;
      const job = state.jobs.find((item) => item.id === run.jobId);
      if (!job?.enabled) return null;
      run.status = 'running';
      run.leaseId = randomUUID();
      run.workerId = workerId;
      run.startedAt = now;
      run.leaseExpiresAt = now + leaseMs;
      return run;
    });
  }
  async heartbeat(
    id: string,
    leaseId: string,
    now = Date.now(),
    leaseMs = 60_000,
  ): Promise<boolean> {
    return this.change((state) => {
      const run = state.runs.find((item) => item.id === id);
      if (run?.status !== 'running' || run.leaseId !== leaseId) return false;
      run.leaseExpiresAt = now + leaseMs;
      return true;
    });
  }
  async finish(
    id: string,
    leaseId: string,
    result: Pick<AutomationRun, 'status' | 'exitCode' | 'artifactDirectory' | 'error' | 'result'>,
    now = Date.now(),
  ): Promise<boolean> {
    if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(result.status))
      throw new Error('Invalid terminal run status');
    return this.change((state) => {
      const run = state.runs.find((item) => item.id === id);
      if (run?.status !== 'running' || run.leaseId !== leaseId) return false;
      Object.assign(run, result, { completedAt: now });
      delete run.leaseExpiresAt;
      return true;
    });
  }
  /**
   * Removes a job at the reviewed revision together with its run records (every run must belong
   * to a stored job). Artifact files on disk are not touched. Refused while a run of the job is
   * queued or running. Returns how many run records were removed.
   */
  async remove(id: string, expectedRevision: number, projectRoot?: string): Promise<number> {
    return this.change((state) => {
      const index = state.jobs.findIndex((item) => item.id === id);
      const job = state.jobs[index];
      if (!job || (projectRoot !== undefined && job.projectRoot !== projectRoot))
        throw new Error('Automation job not found');
      if ((job.revision ?? 1) !== expectedRevision) throw new AutomationRevisionConflict();
      if (
        state.runs.some(
          (run) => run.jobId === id && (run.status === 'queued' || run.status === 'running'),
        )
      )
        throw new AutomationJobBusy();
      state.jobs.splice(index, 1);
      const before = state.runs.length;
      state.runs = state.runs.filter((run) => run.jobId !== id);
      return before - state.runs.length;
    });
  }
  async cancel(id: string): Promise<void> {
    await this.change((state) => {
      const run = state.runs.find((item) => item.id === id);
      if (!run) throw new Error('Automation run not found');
      if (run.status !== 'queued')
        throw new Error('Only queued runs can be cancelled through the store');
      run.status = 'cancelled';
      run.completedAt = Date.now();
    });
  }

  /** Prune metadata only; retain artifacts and the latest successful GitHub checkpoint. */
  async prune(before: number): Promise<number> {
    if (!Number.isFinite(before) || before < 0) throw new Error('Invalid history cutoff');
    return this.change((state) => {
      const retained = new Map<string, AutomationRun>();
      for (const run of state.runs) {
        if (run.status !== 'completed' || run.trigger !== 'github') continue;
        const key = `${run.jobId}\0${run.subjectKey}`;
        const previous = retained.get(key);
        if (!previous || (run.completedAt ?? 0) >= (previous.completedAt ?? 0))
          retained.set(key, run);
      }
      const keep = new Set([...retained.values()].map((run) => run.id));
      for (const run of state.runs) {
        if (
          run.status === 'queued' ||
          run.status === 'running' ||
          (run.completedAt ?? run.createdAt) >= before
        )
          keep.add(run.id);
      }
      // Retained continuations need their exact ancestor artifacts, not a newer unrelated checkpoint.
      const byId = new Map(state.runs.map((run) => [run.id, run]));
      for (const id of keep) {
        const parent = byId.get(id)?.continuationRunId;
        if (parent) keep.add(parent);
      }
      const length = state.runs.length;
      state.runs = state.runs.filter(
        (run) =>
          run.status === 'queued' ||
          run.status === 'running' ||
          keep.has(run.id) ||
          (run.completedAt ?? run.createdAt) >= before,
      );
      return length - state.runs.length;
    });
  }
}
