import { displayLocale } from './display-dates';
import { entries, record } from './engine-values';

/** One job the engine's cron scheduler runs, as `cron.snapshot` reports it. */
export interface ScheduledJob {
  name: string;
  intervalMs: number;
  action: string;
  enabled: boolean;
  lastRun: string | null;
  nextRun: string;
  runCount: number;
  overdue: boolean;
}

/** The scheduler's jobs from the latest `cron.snapshot`; none before the first one. */
export function scheduledJobs(value: unknown): { jobs: ScheduledJob[]; maxConcurrent: number } {
  const snapshot = record(value);
  const jobs = entries(snapshot['jobs'])
    .filter((job) => typeof job['name'] === 'string' && job['name'])
    .map((job) => ({
      name: String(job['name']),
      intervalMs: typeof job['intervalMs'] === 'number' ? job['intervalMs'] : 0,
      action: typeof job['action'] === 'string' ? job['action'] : '',
      enabled: job['enabled'] !== false,
      lastRun: typeof job['lastRun'] === 'string' ? job['lastRun'] : null,
      nextRun: typeof job['nextRun'] === 'string' ? job['nextRun'] : '',
      runCount: typeof job['runCount'] === 'number' ? job['runCount'] : 0,
      overdue: job['overdue'] === true,
    }));
  const maxConcurrent = snapshot['maxConcurrent'];
  return { jobs, maxConcurrent: typeof maxConcurrent === 'number' ? maxConcurrent : 0 };
}

/** `45s`, `5m`, `1.5h`: how often a job runs. */
/** The words the schedule's texts are made of: English unless the panel passes its language's. */
export interface ScheduleWords {
  in: (amount: string) => string;
  ago: (amount: string) => string;
  active: (active: number, total: number) => string;
  overdue: (count: number) => string;
  runs: (count: number) => string;
}
const ENGLISH: ScheduleWords = {
  in: (amount) => `in ${amount}`,
  ago: (amount) => `${amount} ago`,
  active: (active, total) => `${active} of ${total} active`,
  overdue: (count) => `${count} overdue`,
  runs: (count) => `${count} run${count === 1 ? '' : 's'}`,
};

export function intervalText(ms: number): string {
  const trim = (value: number) => String(Number(value.toFixed(1)));
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${trim(ms / 1000)}s`;
  if (ms < 3_600_000) return `${trim(ms / 60_000)}m`;
  return `${trim(ms / 3_600_000)}h`;
}

/** `in 3m`, `2h ago`, or a date beyond a day; a dash when unknown. */
export function whenText(iso: string | null, now: number, words: ScheduleWords = ENGLISH): string {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(at)) return '—';
  const diff = at - now;
  const span = Math.abs(diff);
  const amount =
    span < 60_000
      ? '<1m'
      : span < 3_600_000
        ? `${Math.round(span / 60_000)}m`
        : span < 86_400_000
          ? `${Math.round(span / 3_600_000)}h`
          : '';
  if (!amount)
    return new Date(at).toLocaleString(displayLocale(), {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  return diff >= 0 ? words.in(amount) : words.ago(amount);
}

/** `2 of 3 active · 1 overdue · 14 runs`. */
export function scheduledSummary(
  jobs: readonly ScheduledJob[],
  words: ScheduleWords = ENGLISH,
): string {
  const active = jobs.filter((job) => job.enabled && !job.overdue).length;
  const overdue = jobs.filter((job) => job.overdue).length;
  const runs = jobs.reduce((sum, job) => sum + job.runCount, 0);
  return [
    words.active(active, jobs.length),
    overdue ? words.overdue(overdue) : '',
    words.runs(runs),
  ]
    .filter(Boolean)
    .join(' · ');
}
