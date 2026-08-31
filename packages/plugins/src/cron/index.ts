/**
 * cron plugin — Schedules recurring tasks via beforeIteration extension hooks.
 *
 * Tools registered:
 * - cron_schedule: Schedule a recurring action
 * - cron_list: List all scheduled jobs
 * - cron_cancel: Cancel a scheduled job
 */
import type { Plugin } from '@wrongstack/core/types';

const COORDINATION_CRON_CAPABILITY = 'coordination.cron';

const API_VERSION = '^0.1.10';

interface CronJob {
  name: string;
  intervalMs: number;
  action: string;
  enabled: boolean;
  lastRun: string | null;
  nextRun: string;
  runCount: number;
}

interface CronState {
  jobs: Map<string, CronJob>;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  extensionUnregister: (() => void) | null;
  createdAt: string;
}

// Module-level state, shared between `setup` and `teardown`.
//
// Why module-level? The Plugin interface in @wrongstack/core does not
// currently thread state from `setup` → `teardown`. The previous
// implementation kept `state` as a `const` inside the setup closure,
// which made it inaccessible from teardown — so the teardown function
// fell through to a `?? { jobs: new Map(), timers: new Map() }` default
// and silently leaked every setTimeout timer it had registered (H1
// audit, 2026-06-03). Keeping a single shared object with stable Map
// identity lets teardown actually clear resources. The contents are
// reset in setup (idempotent re-init on plugin reload) and cleared in
// teardown (resource release).
const state: CronState = {
  jobs: new Map(),
  timers: new Map(),
  extensionUnregister: null,
  createdAt: new Date().toISOString(),
};

function formatNextRun(intervalMs: number): string {
  /* v8 ignore next -- callers always pass a clamped interval (>=1000); the NaN/<=0/non-finite -> 60_000 fallback is defensive. */
  const ms =
    Number.isNaN(intervalMs) || !Number.isFinite(intervalMs) || intervalMs <= 0
      ? 60_000
      : intervalMs;
  return new Date(Date.now() + ms).toISOString();
}

/** Build a serializable snapshot of the current cron job state for custom events. */
function buildSnapshot(
  s: CronState,
  maxConcurrent: number,
): { count: number; maxConcurrent: number; jobs: Array<{
    name: string;
    intervalMs: number;
    action: string;
    enabled: boolean;
    lastRun: string | null;
    nextRun: string;
    runCount: number;
    overdue: boolean;
  }> } {
  const jobs = Array.from(s.jobs.values()).map((j) => ({
    name: j.name,
    intervalMs: j.intervalMs,
    action: j.action,
    enabled: j.enabled,
    lastRun: j.lastRun,
    nextRun: j.nextRun,
    runCount: j.runCount,
    overdue: new Date(j.nextRun).getTime() < Date.now(),
  }));
  return { count: jobs.length, maxConcurrent, jobs };
}

function clearCronResources(): void {
  for (const timer of state.timers.values()) {
    clearTimeout(timer);
  }
  state.timers.clear();
  state.jobs.clear();
  if (state.extensionUnregister) {
    try {
      state.extensionUnregister();
    } catch {
      // best-effort — extension registry may already be gone during shutdown
    }
    state.extensionUnregister = null;
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'cron',
  version: '0.1.0',
  description: 'Schedules recurring tasks using beforeIteration/afterIteration extension hooks',
  apiVersion: API_VERSION,
  capabilities: { tools: true },
  defaultConfig: {
    maxConcurrentJobs: 5,
    timezone: 'UTC',
    persistSchedules: false,
  },
  configSchema: {
    type: 'object',
    properties: {
      maxConcurrentJobs: { type: 'number', default: 5 },
      timezone: { type: 'string', default: 'UTC' },
      persistSchedules: { type: 'boolean', default: false },
    },
  },

  setup(api) {
    // Idempotent re-init: if the plugin is reloaded (e.g. via /plugin
    // reload), clear any previous timers/jobs first. The shared
    // `state` object lives at module scope so teardown can reach it.
    clearCronResources();
    state.createdAt = new Date().toISOString();

    const maxConcurrent = (api.config.extensions?.['cron'] as Record<string, unknown>)?.['maxConcurrentJobs'] as number ?? 5;

    function scheduleNextRun(name: string): void {
      const job = state.jobs.get(name);
      if (!job?.enabled) return;

      const existing = state.timers.get(name);
      if (existing) clearTimeout(existing);

      const delay = Math.max(0, new Date(job.nextRun).getTime() - Date.now());
      const timer = setTimeout(() => {
        job.runCount++;
        job.lastRun = new Date().toISOString();
        job.nextRun = formatNextRun(job.intervalMs);

        // Emit custom event
        api.emitCustom('cron:job_fired', {
          name,
          action: job.action,
          runCount: job.runCount,
          ts: new Date().toISOString(),
        });

        // Broadcast state snapshot so connected UIs see updated runCount/nextRun.
        api.emitCustom('cron:state_snapshot', buildSnapshot(state, maxConcurrent));

        api.metrics.counter('cron_job_fired', 1, { job: name });
        api.metrics.histogram('cron_job_interval_ms', job.intervalMs, { job: name });

        // Schedule next
        scheduleNextRun(name);
      }, delay);

      // A cron job scheduled hours out must not, by itself, keep the host
      // process alive. `unref` keeps the timer firing for as long as the
      // process is running for other reasons, while letting the CLI exit
      // when the user's work is done instead of hanging on a pending job.
      timer.unref?.();

      state.timers.set(name, timer);
    }

    function cancelJob(name: string): void {
      const timer = state.timers.get(name);
      if (timer) {
        clearTimeout(timer);
        state.timers.delete(name);
      }
      state.jobs.delete(name);
    }

    // Register a single extension covering before/after iteration hooks.
    // Keep the disposer so reload/teardown cannot stack duplicate hooks.
    state.extensionUnregister = api.extensions.register({
      name: 'cron-iteration-hooks',
      owner: 'cron',
      beforeIteration: async (_ctx, _idx) => {
        const now = Date.now();
        let activeJobs = 0;
        const promises: Array<Promise<void>> = [];

        for (const [name, job] of state.jobs) {
          if (!job.enabled) continue;
          /* v8 ignore next -- jobs.size is capped at maxConcurrent on schedule, so this break is unreachable via the public API; kept as a safety bound. */
          if (activeJobs >= maxConcurrent) break;

          if (new Date(job.nextRun).getTime() <= now) {
            activeJobs++;
            promises.push(
              (async () => {
                try {
                  await api.session?.append?.({
                    type: 'cron:scheduled_trigger',
                    ts: new Date().toISOString(),
                    jobName: name,
                    action: job.action,
                    runCount: job.runCount + 1,
                  });
                } catch {
                  // best-effort
                }
                api.emitCustom('cron:job_due', {
                  name,
                  action: job.action,
                  dueAt: new Date().toISOString(),
                });
              })(),
            );
          }
        }

        await Promise.all(promises);
      },
      afterIteration: async (_ctx, _idx) => {
        for (const job of state.jobs.values()) {
          if (!job.enabled) continue;
          if (new Date(job.nextRun).getTime() <= Date.now()) {
            job.nextRun = formatNextRun(job.intervalMs);
          }
        }
      },
    });

    // --- cron_schedule ---
    api.tools.register({
      name: 'cron_schedule',
      description: 'Schedule a recurring action to fire at a fixed interval (in milliseconds). The action is emitted as a custom event for downstream handlers.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Unique name for this cron job' },
          intervalMs: { type: 'number', description: 'Interval between runs in milliseconds (minimum 1000)' },
          action: { type: 'string', description: 'Action identifier or description of what to run' },
          enabled: { type: 'boolean', default: true },
        },
        required: ['name', 'intervalMs', 'action'],
      },
      permission: 'confirm',
      category: 'Session',
      mutating: false,
      capabilities: [COORDINATION_CRON_CAPABILITY],
      async execute(input: Record<string, unknown>) {
        const name = (input['name'] ?? input['jobName'] ?? input['job_name'] ?? input['job'] ?? input['id']) as string;
        const rawInterval =
          input['intervalMs'] ??
          input['interval_ms'] ??
          input['interval'] ??
          input['every'] ??
          input['period'];
        const intervalMs = Math.max(1000, Number(rawInterval));
        const action = (input['action'] ?? input['task'] ?? input['command'] ?? input['run']) as string;
        const enabled = (input['enabled'] as boolean | undefined) ?? true;

        if (!name || typeof name !== 'string' || name.trim() === '') {
          return { ok: false, error: 'name is required and must be a non-empty string' };
        }
        if (Number.isNaN(intervalMs) || rawInterval === undefined || rawInterval === null) {
          return { ok: false, error: 'intervalMs must be a number >= 1000' };
        }

        if (state.jobs.has(name)) {
          return { ok: false, error: `Cron job '${name}' already exists. Use cron_cancel first.` };
        }

        if (state.jobs.size >= maxConcurrent) {
          return { ok: false, error: `Maximum concurrent jobs (${maxConcurrent}) reached.` };
        }

        const job: CronJob = {
          name,
          intervalMs,
          action,
          enabled,
          lastRun: null,
          nextRun: formatNextRun(intervalMs),
          runCount: 0,
        };

        state.jobs.set(name, job);
        scheduleNextRun(name);

        api.metrics.gauge('cron_active_jobs', state.jobs.size);

        // Broadcast full state snapshot so connected UIs stay in sync.
        api.emitCustom('cron:state_snapshot', buildSnapshot(state, maxConcurrent));

        return {
          ok: true,
          name,
          intervalMs,
          nextRun: job.nextRun,
          message: `Scheduled '${name}' every ${intervalMs}ms.`,
        };
      },
    });

    // --- cron_list ---
    api.tools.register({
      name: 'cron_list',
      description: 'List all registered cron jobs with their intervals, next run times, and execution counts.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      mutating: false,
      capabilities: [COORDINATION_CRON_CAPABILITY],
      async execute() {
        const jobs = Array.from(state.jobs.values()).map((j) => ({
          name: j.name,
          intervalMs: j.intervalMs,
          action: j.action,
          enabled: j.enabled,
          lastRun: j.lastRun,
          nextRun: j.nextRun,
          runCount: j.runCount,
          overdue: new Date(j.nextRun).getTime() < Date.now(),
        }));

        return {
          ok: true,
          count: jobs.length,
          maxConcurrent,
          jobs,
        };
      },
    });

    // --- cron_cancel ---
    api.tools.register({
      name: 'cron_cancel',
      description: 'Cancel and remove a cron job by name.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name of the cron job to cancel' },
        },
        required: ['name'],
      },
      permission: 'auto',
      mutating: false,
      capabilities: [COORDINATION_CRON_CAPABILITY],
      async execute(input: Record<string, unknown>) {
        const name = (input['name'] ?? input['jobName'] ?? input['job_name'] ?? input['job'] ?? input['id']) as string;

        if (!name || typeof name !== 'string' || !state.jobs.has(name)) {
          return { ok: false, error: `No cron job named '${name}'` };
        }

        cancelJob(name);
        api.metrics.gauge('cron_active_jobs', state.jobs.size);

        // Broadcast full state snapshot so connected UIs stay in sync.
        api.emitCustom('cron:state_snapshot', buildSnapshot(state, maxConcurrent));

        return {
          ok: true,
          name,
          message: `Cancelled cron job '${name}'.`,
        };
      },
    });

    api.log.info('cron plugin loaded', { version: '0.1.0', maxConcurrent });
  },

  teardown(api) {
    // Clear every pending timer and unregister the iteration extension so the
    // agent loop never invokes callbacks against a torn-down plugin.
    clearCronResources();
    api.log.info('cron plugin unloaded');
  },

  async health() {
    const jobs = Array.from(state.jobs.values());
    const overdue = jobs.filter(
      (job) => job.enabled && new Date(job.nextRun).getTime() < Date.now(),
    ).length;
    return {
      ok: overdue === 0,
      message:
        overdue > 0
          ? `cron: ${overdue} overdue job(s) out of ${jobs.length}`
          : `cron: ${jobs.length} active job(s)`,
      activeJobs: jobs.length,
      overdueJobs: overdue,
      totalRuns: jobs.reduce((sum, job) => sum + job.runCount, 0),
    };
  },
};

export default plugin;
