import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { atomicWrite } from '@wrongstack/core/utils';
import type { CredentialReference, ResolvedCredentialBundle } from '../credential-reference.js';
import { stopEnvironmentServices } from '../docker-environment.js';
import {
  type DockerWorkspaceOptions,
  type DockerWorkspaceResult,
  runDockerWorkspace,
  systemDocker,
} from '../docker-workspace.js';
import type { AutomationRun } from './contracts.js';
import { createHeadlessLaunchPlan } from './launch-plan.js';
import { buildAutomationResult } from './result.js';
import type { AutomationStore } from './store.js';
import { verifyAutomationPatch } from './verification.js';

export type AutomationExecutor = (
  options: DockerWorkspaceOptions,
) => Promise<DockerWorkspaceResult>;

export class AutomationService {
  readonly workerId = `${os.hostname()}/${process.pid}/${randomUUID()}`;
  private readonly active = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private ticking = false;
  private tickDone: Promise<void> = Promise.resolve();
  private stopped = false;
  lastError: string | null = null;
  constructor(
    readonly store: AutomationStore,
    private readonly execute: AutomationExecutor = runDockerWorkspace,
    readonly maxConcurrent = 1,
    private readonly resolveCredentials?:
      | ((refs: readonly CredentialReference[]) => Promise<ResolvedCredentialBundle>)
      | undefined,
  ) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 16)
      throw new Error('Automation concurrency must be 1 to 16');
  }
  async tick(now = Date.now()): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    let resolveTick: (() => void) | undefined;
    this.tickDone = new Promise<void>((resolve) => {
      resolveTick = resolve;
    });
    try {
      await this.recoverAbsentWorkers(now);
      if (this.stopped) return;
      try {
        await this.store.scheduleDue(now);
      } catch (error) {
        // A refused schedule (e.g. run capacity) must not stall the runs already queued.
        this.lastError = error instanceof Error ? error.message : 'Automation scheduling failed';
      }
      while (!this.stopped && this.active.size < this.maxConcurrent) {
        const run = await this.store.claim(this.workerId, now);
        if (!run) break;
        if (this.stopped) {
          await this.store.finish(run.id, run.leaseId!, { status: 'cancelled' });
          break;
        }
        const abort = new AbortController();
        const done = this.run(run, abort.signal)
          .catch((error) => {
            this.lastError =
              error instanceof Error ? error.message : 'Automation persistence failed';
          })
          .finally(() => this.active.delete(run.id));
        this.active.set(run.id, { abort, done });
      }
    } finally {
      this.ticking = false;
      resolveTick?.();
    }
  }
  private async run(run: AutomationRun, signal: AbortSignal): Promise<void> {
    const started = performance.now();
    const leaseId = run.leaseId!;
    let heartbeatPending = false;
    const heartbeat = setInterval(() => {
      if (heartbeatPending) return;
      heartbeatPending = true;
      void this.store
        .heartbeat(run.id, leaseId)
        .then((owned) => {
          if (!owned) this.active.get(run.id)?.abort.abort();
        })
        .catch(() => this.active.get(run.id)?.abort.abort())
        .finally(() => {
          heartbeatPending = false;
        });
    }, 15_000);
    heartbeat.unref?.();
    const directory = path.join(this.store.directory, 'runs', run.id);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await atomicWrite(
        path.join(directory, 'claim.json'),
        `${JSON.stringify({ id: run.id, jobId: run.jobId, leaseId, subjectKey: run.subjectKey, trigger: run.trigger, startedAt: run.startedAt })}\n`,
        { mode: 0o600 },
      );
      const args = createHeadlessLaunchPlan(run.job, run.context).args;
      const previous = run.continuationRunId
        ? (await this.store.snapshot()).runs.find(
            (item) =>
              item.id === run.continuationRunId &&
              item.jobId === run.jobId &&
              item.subjectKey === run.subjectKey &&
              item.status === 'completed',
          )
        : run.trigger === 'github'
          ? (await this.store.snapshot()).runs
              .filter(
                (item) =>
                  item.jobId === run.jobId &&
                  item.subjectKey === run.subjectKey &&
                  item.id !== run.id &&
                  item.status === 'completed',
              )
              .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))[0]
          : undefined;
      if (run.continuationRunId && !previous)
        throw new Error('Explicit continuation source is unavailable');
      let initialPatch: string | undefined;
      let previousConversationDirectory: string | undefined;
      if (previous) {
        const prior = path.join(this.store.directory, 'runs', previous.id);
        const patchPath = path.join(prior, 'changes.patch');
        if ((await stat(patchPath)).size > 16 * 1024 * 1024)
          throw new Error('Prior subject patch exceeds 16 MB');
        initialPatch = await readFile(patchPath, 'utf8');
        previousConversationDirectory = path.join(prior, 'conversation');
        try {
          if ((await stat(previousConversationDirectory)).isDirectory()) args.push('--continue');
          else previousConversationDirectory = undefined;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          previousConversationDirectory = undefined;
        }
      }
      if (run.job.credentials?.length && !this.resolveCredentials)
        throw new Error('This worker has no profile credential resolver');
      const credentials = run.job.credentials?.length
        ? await this.resolveCredentials!(run.job.credentials)
        : undefined;
      signal.throwIfAborted();
      const result = await this.execute({
        id: run.id,
        ownerToken: leaseId,
        projectRoot: run.job.projectRoot,
        image: run.job.image,
        environment: run.job.environment,
        onEnvironmentUpdate: run.job.environment
          ? async (receipt) => {
              await atomicWrite(
                path.join(directory, 'environment.json'),
                `${JSON.stringify(receipt, null, 2)}\n`,
                { mode: 0o600 },
              );
            }
          : undefined,
        command: 'wstack',
        args,
        envNames: run.job.envNames,
        env: credentials?.env,
        providerConfigs: credentials?.providers,
        initialPatch,
        previousConversationDirectory,
        conversationDirectory: path.join(directory, 'conversation'),
        timeoutMs: run.job.timeoutMs,
        captureTreeIdentity: run.job.verification !== undefined,
        signal,
      });
      await mkdir(directory, { recursive: true });
      if (result.patch !== null)
        await atomicWrite(path.join(directory, 'changes.patch'), result.patch, { mode: 0o600 });
      await atomicWrite(path.join(directory, 'output.log'), result.output, { mode: 0o600 });
      const { patch: _patch, output: _output, ...metadata } = result;
      const summary = buildAutomationResult(
        result.output,
        result.patch,
        performance.now() - started,
      );
      if (run.job.verification) {
        const verified = await verifyAutomationPatch(run.job, result, signal, this.execute);
        await atomicWrite(path.join(directory, 'verification.log'), verified.output, {
          mode: 0o600,
        });
        await atomicWrite(
          path.join(directory, 'verification.json'),
          `${JSON.stringify(verified.validation, null, 2)}\n`,
          { mode: 0o600 },
        );
        summary.validation = {
          ...verified.validation,
          evidence: [...summary.validation.evidence, 'verification.json', 'verification.log'],
        };
      }
      summary.durationMs = Math.round(performance.now() - started);
      await atomicWrite(
        path.join(directory, 'run.json'),
        `${JSON.stringify({ ...metadata, result: summary }, null, 2)}\n`,
        { mode: 0o600 },
      );
      await this.store.finish(run.id, leaseId, {
        status: signal.aborted
          ? 'cancelled'
          : result.exitCode === 0 && result.patch !== null
            ? 'completed'
            : 'failed',
        exitCode: result.exitCode,
        artifactDirectory: directory,
        error: result.failure,
        result: summary,
      });
    } catch (error) {
      const summary = buildAutomationResult('', null, performance.now() - started);
      summary.validation.evidence = [];
      await this.store.finish(run.id, leaseId, {
        status: signal.aborted ? 'cancelled' : 'failed',
        error:
          error instanceof Error ? error.message.slice(0, 2000) : 'Automation execution failed',
        artifactDirectory: directory,
        result: summary,
      });
    } finally {
      clearInterval(heartbeat);
    }
  }
  /** Recovery requires an expired lease AND a proven absent local process. */
  private async recoverAbsentWorkers(now: number): Promise<void> {
    const state = await this.store.snapshot();
    for (const run of state.runs) {
      if (
        run.status !== 'running' ||
        !run.leaseId ||
        !run.workerId ||
        !run.leaseExpiresAt ||
        run.leaseExpiresAt > now ||
        this.active.has(run.id)
      )
        continue;
      const [host, pidText] = run.workerId.split('/');
      const pid = Number(pidText);
      if (host !== os.hostname() || !Number.isSafeInteger(pid) || pid <= 0) continue;
      try {
        process.kill(pid, 0);
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue;
      }
      // Unknown Docker state leaves the lease visible and prevents a duplicate
      // subject dispatch. A confirmed missing container can be interrupted too.
      const name = `wrongstack-${run.id}`;
      // A container that received a credential is removed, never kept: its configuration
      // holds the forwarded values (see runDockerWorkspace).
      const credentialed = !!run.job.credentials?.length || !!run.job.envNames?.length;
      let removed = false,
        kept = false;
      try {
        const probe = await systemDocker(
          [
            'inspect',
            '--format',
            '{{.Id}} {{ index .Config.Labels "dev.wrongstack.workspace-owner" }}',
            name,
          ],
          { timeoutMs: 10_000 },
        );
        if (probe.code !== 0) {
          if (!/No such (?:object|container)/i.test(probe.stderr)) continue;
        } else {
          const [containerId, marker] = probe.stdout.trim().split(/\s+/);
          if (marker !== run.leaseId || !/^[a-f0-9]{64}$/.test(containerId ?? '')) continue;
          const stop = await systemDocker(
            credentialed
              ? ['rm', '--force', '--volumes', containerId!]
              : ['stop', '--time', '2', containerId!],
            { timeoutMs: 15_000 },
          );
          if (stop.code !== 0) continue;
          removed = credentialed;
          kept = !credentialed;
        }
        if (
          run.job.environment &&
          !(await stopEnvironmentServices(
            run.job.environment,
            run.id,
            run.leaseId,
            systemDocker,
            kept,
          ))
        )
          continue;
        await this.store.finish(
          run.id,
          run.leaseId,
          {
            status: 'interrupted',
            error: removed
              ? 'Worker process exited. The Docker workspace held a credential and was removed.'
              : 'Worker process exited. Partial Docker workspace, when present, is retained for recovery.',
          },
          now,
        );
      } catch {
        /* Unknown liveness does not authorize redispatch or cleanup. */
      }
    }
  }
  async cancel(id: string): Promise<void> {
    if (!this.active.has(id) && this.ticking) await this.tickDone;
    const active = this.active.get(id);
    if (active) {
      active.abort.abort();
      await active.done;
      return;
    }
    try {
      await this.store.cancel(id);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'Only queued runs can be cancelled through the store'
      ) {
        if (this.ticking) await this.tickDone;
        const claimedActive = this.active.get(id);
        if (claimedActive) {
          claimedActive.abort.abort();
          await claimedActive.done;
          return;
        }
        const latest = (await this.store.snapshot()).runs.find((item) => item.id === id);
        if (latest?.status === 'cancelled') return;
      }
      throw error;
    }
  }
  async idle(): Promise<void> {
    await Promise.all([...this.active.values()].map((item) => item.done));
  }
  async stop(): Promise<void> {
    this.stopped = true;
    for (const item of this.active.values()) item.abort.abort();
    await this.tickDone;
    await this.idle();
  }
}
