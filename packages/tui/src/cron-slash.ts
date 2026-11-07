/**
 * `/cron` — List the session wakeups: timers the agent scheduled for itself
 * with `session_wakeup` (they replaced the cron plugin's jobs).
 *
 * Reads the list through the agent's `session_wakeup` tool (action=list) and
 * maps it onto the job view the slash command and the F-key panel share.
 * A one-shot wakeup has interval 0 and renders as "once".
 */

import type { SlashCommand } from '@wrongstack/contracts/types';
import type { Agent } from '@wrongstack/core/agent';
import { type SessionWakeupView, WAKEUP_MAX_PER_SESSION } from '@wrongstack/tools';

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
    const wakeupTool = agent.tools.get('session_wakeup');
    if (!wakeupTool) {
      return {
        ok: false,
        count: 0,
        maxConcurrent: 0,
        jobs: [],
        error: 'session_wakeup tool is not registered',
      };
    }
    try {
      const result = (await wakeupTool.execute({ action: 'list' }, agent.ctx, {
        signal: AbortSignal.timeout(5000),
      })) as { wakeups?: SessionWakeupView[] | undefined };
      const jobs = (result.wakeups ?? []).map(
        (w): CronJobView => ({
          name: w.id,
          intervalMs: (w.every_s ?? 0) * 1000,
          action: w.prompt,
          enabled: true,
          lastRun: w.last_fired_at ?? null,
          nextRun: w.next_at,
          runCount: w.fires,
          overdue: false,
        }),
      );
      return { ok: true, count: jobs.length, maxConcurrent: WAKEUP_MAX_PER_SESSION, jobs };
    } catch (err) {
      return { ok: false, count: 0, maxConcurrent: 0, jobs: [], error: String(err) };
    }
  };
}

// ── Slash command ───────────────────────────────────────────────────────────

const USAGE =
  'Usage:\n' +
  '  /cron                  — list the session wakeups the agent scheduled\n' +
  '  /cron list             — same as /cron';

export function createCronSlashCommand(deps: CronSlashDeps): SlashCommand {
  return {
    name: 'cron',
    description: 'List the session wakeups (timers the agent scheduled with session_wakeup).',
    async run(args) {
      const trimmed = args.trim().toLowerCase();
      if (trimmed !== '' && trimmed !== 'list') {
        return { message: `Unknown subcommand "${trimmed}".\n${USAGE}` };
      }

      const result = await deps.getCronJobs();
      if (!result.ok) {
        return { message: `Failed to read session wakeups: ${result.error ?? 'unknown error'}` };
      }

      return { message: renderCronList(result) };
    },
  };
}

// ── Render (exported for testing) ──────────────────────────────────────────

function fmtInterval(ms: number): string {
  if (ms <= 0) return 'once';
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
      '⏱ **Session wakeups** — none scheduled',
      '',
      `  Max per session: ${maxConcurrent}`,
      '  The agent schedules them with session_wakeup.',
    ].join('\n');
  }

  const overdueCount = jobs.filter((j) => j.overdue).length;
  const enabledCount = jobs.filter((j) => j.enabled).length;
  const totalRuns = jobs.reduce((s, j) => s + j.runCount, 0);

  const header = [
    '⏱ **Session wakeups**',
    '',
    `  ${count} job${count === 1 ? '' : 's'} · ${enabledCount} enabled · ${overdueCount} overdue · ${totalRuns} total runs · max ${maxConcurrent} per session`,
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

  return [
    ...header,
    ...rows,
    '',
    '  The agent adds them with session_wakeup and removes them with action=cancel.',
  ].join('\n');
}
