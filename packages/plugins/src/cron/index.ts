/**
 * cron plugin — Schedules recurring tasks via beforeIteration extension hooks.
 *
 * Tools registered:
 * - cron_schedule: Schedule a recurring action
 * - cron_list: List all scheduled jobs
 * - cron_cancel: Cancel a scheduled job
 */
import { type Plugin, ToolValidationError } from '@wrongstack/contracts/types';
import { createHostStates } from '../runtime/host-state.js';

const COORDINATION_CRON_CAPABILITY = 'coordination.cron';

const API_VERSION = '^0.1.10';

/** Largest delay setTimeout honours; anything above is clamped to 1 ms. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

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
  abort: AbortController;
  pendingDue: WeakSet<CronJob>;
  jobs: Map<string, CronJob>;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  extensionUnregister: (() => void) | null;
  createdAt: string;
}

const hosts = createHostStates<CronState>(
  () => ({
    abort: new AbortController(),
    pendingDue: new WeakSet(),
    jobs: new Map(),
    timers: new Map(),
    extensionUnregister: null,
    createdAt: new Date().toISOString(),
  }),
  clearCronResources,
);

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
): {
  count: number;
  maxConcurrent: number;
  jobs: Array<{
    name: string;
    intervalMs: number;
    action: string;
    enabled: boolean;
    lastRun: string | null;
    nextRun: string;
    runCount: number;
    overdue: boolean;
  }>;
} {
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

function clearCronResources(state: CronState): void {
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
    const state = hosts.reset(api);

    const rawMaxConcurrent = (api.config.extensions?.['cron'] as Record<string, unknown>)?.[
      'maxConcurrentJobs'
    ];
    const maxConcurrent =
      typeof rawMaxConcurrent === 'number' && Number.isFinite(rawMaxConcurrent)
        ? Math.max(1, Math.floor(rawMaxConcurrent))
        : 5;

    function scheduleNextRun(name: string): void {
      const job = state.jobs.get(name);
      if (state.abort.signal.aborted || !job?.enabled) return;

      const existing = state.timers.get(name);
      if (existing) clearTimeout(existing);

      const delay = Math.max(0, new Date(job.nextRun).getTime() - Date.now());
      const timer = setTimeout(() => {
        if (state.abort.signal.aborted || state.jobs.get(name) !== job) return;
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
        if (state.abort.signal.aborted) return;
        const now = Date.now();
        let activeJobs = 0;
        const promises: Array<Promise<void>> = [];

        for (const [name, job] of state.jobs) {
          if (!job.enabled || state.pendingDue.has(job)) continue;
          /* v8 ignore next -- jobs.size is capped at maxConcurrent on schedule, so this break is unreachable via the public API; kept as a safety bound. */
          if (activeJobs >= maxConcurrent) break;

          if (new Date(job.nextRun).getTime() <= now) {
            activeJobs++;
            state.pendingDue.add(job);
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
                state.pendingDue.delete(job);
                if (state.abort.signal.aborted || state.jobs.get(name) !== job) return;
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
        if (state.abort.signal.aborted) return;
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
      description:
        'Schedule a recurring action to fire at a fixed interval (in milliseconds). The action is emitted as a custom event for downstream handlers.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Unique name for this cron job' },
          intervalMs: {
            type: 'number',
            minimum: 1000,
            maximum: MAX_TIMER_DELAY_MS,
            description: `Interval between runs in milliseconds (1000 to ${MAX_TIMER_DELAY_MS})`,
          },
          action: {
            type: 'string',
            description: 'Action identifier or description of what to run',
          },
          enabled: { type: 'boolean', default: true },
        },
        required: ['name', 'intervalMs', 'action'],
      },
      permission: 'confirm',
      category: 'Session',
      mutating: false,
      capabilities: [COORDINATION_CRON_CAPABILITY],
      async execute(input: Record<string, unknown>, _ctx, options) {
        state.abort.signal.throwIfAborted();
        options?.signal?.throwIfAborted();
        const name = (input['name'] ??
          input['jobName'] ??
          input['job_name'] ??
          input['job'] ??
          input['id']) as string;
        const rawInterval =
          input['intervalMs'] ??
          input['interval_ms'] ??
          input['interval'] ??
          input['every'] ??
          input['period'];
        const intervalMs = Math.max(1000, Number(rawInterval));
        const action = (input['action'] ??
          input['task'] ??
          input['command'] ??
          input['run']) as string;
        const enabled = (input['enabled'] as boolean | undefined) ?? true;

        if (!name || typeof name !== 'string' || name.trim() === '') {
          throw new ToolValidationError({
            message: 'name is required and must be a non-empty string',
            field: 'name',
          });
        }
        if (Number.isNaN(intervalMs) || rawInterval === undefined || rawInterval === null) {
          throw new ToolValidationError({
            message: 'intervalMs must be a number >= 1000',
            field: 'intervalMs',
          });
        }
        // setTimeout clamps any delay above 2^31-1 ms to 1 ms, so an
        // oversized interval fired the job on every tick instead of never.
        if (intervalMs > MAX_TIMER_DELAY_MS) {
          throw new ToolValidationError({
            message: `intervalMs must be <= ${MAX_TIMER_DELAY_MS} (about 24.8 days)`,
            field: 'intervalMs',
          });
        }
        // `action` is required by the schema; a job without one fires an empty event.
        if (typeof action !== 'string' || action.trim() === '') {
          throw new ToolValidationError({
            message: 'action is required and must be a non-empty string',
            field: 'action',
          });
        }

        if (state.jobs.has(name)) {
          throw new Error(`Cron job '${name}' already exists. Use cron_cancel first.`);
        }

        if (state.jobs.size >= maxConcurrent) {
          throw new Error(`Maximum concurrent jobs (${maxConcurrent}) reached.`);
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
      description:
        'List all registered cron jobs with their intervals, next run times, and execution counts.',
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
      async execute(input: Record<string, unknown>, _ctx, options) {
        state.abort.signal.throwIfAborted();
        options?.signal?.throwIfAborted();
        const name = (input['name'] ??
          input['jobName'] ??
          input['job_name'] ??
          input['job'] ??
          input['id']) as string;

        if (!name || typeof name !== 'string' || !state.jobs.has(name)) {
          throw new Error(`No cron job named '${name}'`);
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
    hosts.remove(api);
    api.log.info('cron plugin unloaded');
  },

  async health() {
    const jobs = [...hosts.values()].flatMap((state) => [...state.jobs.values()]);
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
