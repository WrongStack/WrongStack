/**
 * `/cron` — List all scheduled cron jobs from the cron plugin.
 *
 * Reads the cron job list via a getter callback wired to the agent's
 * `cron_list` tool at registration time. Renders a formatted table of
 * job names, intervals, actions, run counts, and overdue status.
 */
import type { Agent } from '@wrongstack/core/agent';
import type { SlashCommand } from '@wrongstack/core/types';

// ── Types ───────────────────────────────────────────────────────────────────

export interface CronJobView {
  name: string;
  intervalMs: number;
  action: string;
  enabled: boolean;
  lastRun: string | null;
  nextRun: string;
  runCount: number;
  overdue: boolean;
}

export interface CronListResult {
  ok: boolean;
  count: number;
  maxConcurrent: number;
  jobs: CronJobView[];
  error?: string | undefined;
}

interface CronSlashDeps {
  getCronJobs: () => Promise<CronListResult>;
}

/** Build the shared cron-list loader used by both the slash command and panel. */
export function createCronJobsGetter(
  agent: Pick<Agent, 'ctx' | 'tools'>,
): () => Promise<CronListResult> {
  return async () => {
    const cronListTool = agent.tools.get('cron_list');
    if (!cronListTool) {
      return {
        ok: false,
        count: 0,
        maxConcurrent: 0,
        jobs: [],
        error: 'Cron plugin not loaded (cron_list tool not found)',
      };
    }
    try {
      const result = await cronListTool.execute({}, agent.ctx, {
        signal: AbortSignal.timeout(5000),
      });
      return result as CronListResult;
    } catch (err) {
      return { ok: false, count: 0, maxConcurrent: 0, jobs: [], error: String(err) };
    }
  };
}

// ── Slash command ───────────────────────────────────────────────────────────

const USAGE =
  'Usage:\n' +
  '  /cron                  — list all scheduled cron jobs\n' +
  '  /cron list             — same as /cron';

export function createCronSlashCommand(deps: CronSlashDeps): SlashCommand {
  return {
    name: 'cron',
    description: 'List all scheduled cron jobs with their status, interval, and run counts.',
    async run(args) {
      const trimmed = args.trim().toLowerCase();
      if (trimmed !== '' && trimmed !== 'list') {
        return { message: `Unknown subcommand "${trimmed}".\n${USAGE}` };
      }

      const result = await deps.getCronJobs();
      if (!result.ok) {
        return { message: `Failed to read cron state: ${result.error ?? 'unknown error'}` };
      }

      return { message: renderCronList(result) };
    },
  };
}

// ── Render (exported for testing) ──────────────────────────────────────────

function fmtInterval(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = Date.now();
  const diff = d.getTime() - now;
  const abs = Math.abs(diff);

  // Recent — show relative
  if (abs < 60_000) return diff >= 0 ? '<1m' : '<1m ago';
  if (abs < 3_600_000) {
    const mins = Math.round(abs / 60_000);
    return diff >= 0 ? `${mins}m` : `${mins}m ago`;
  }
  if (abs < 86_400_000) {
    const hrs = Math.round(abs / 3_600_000);
    return diff >= 0 ? `${hrs}h` : `${hrs}h ago`;
  }
  // Far — show date
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function renderCronList(result: CronListResult): string {
  const { jobs, count, maxConcurrent } = result;

  if (count === 0) {
    return [
      '⏱ **Cron jobs** — none scheduled',
      '',
      `  Max concurrent: ${maxConcurrent}`,
      '  Schedule a job with cron_schedule.',
    ].join('\n');
  }

  const overdueCount = jobs.filter((j) => j.overdue).length;
  const enabledCount = jobs.filter((j) => j.enabled).length;
  const totalRuns = jobs.reduce((s, j) => s + j.runCount, 0);

  const header = [
    '⏱ **Cron jobs**',
    '',
    `  ${count} job${count === 1 ? '' : 's'} · ${enabledCount} enabled · ${overdueCount} overdue · ${totalRuns} total runs · max ${maxConcurrent} concurrent`,
    '',
  ];

  const rows = jobs.map((job) => {
    const status = !job.enabled ? '🔴 disabled' : job.overdue ? '🔶 overdue' : '🟢 active';

    const interval = fmtInterval(job.intervalMs);
    const next = fmtTime(job.nextRun);
    const last = fmtTime(job.lastRun);
    const runs = String(job.runCount);
    const action = job.action.length > 50 ? job.action.slice(0, 47) + '…' : job.action;
    const name = job.name.length > 24 ? job.name.slice(0, 21) + '…' : job.name.padEnd(24);

    return `  ${status}  ${name}  ${interval.padEnd(8)}  runs:${runs.padStart(3)}  next:${next.padEnd(9)}  last:${last.padEnd(9)}  ${action}`;
  });

  return [...header, ...rows, '', '  Use cron_schedule to add, cron_cancel to remove.'].join('\n');
}
