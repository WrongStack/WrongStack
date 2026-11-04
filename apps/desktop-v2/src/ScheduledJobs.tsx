import { CalendarClock } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { EngineState } from './engine-state';
import { intervalText, scheduledJobs, scheduledSummary, whenText } from './scheduled-jobs-model';
import './scheduled-jobs.css';

/**
 * The jobs this conversation's agent scheduled with `cron_schedule`, as the WebUI's cron panel
 * shows them: shown only while there are jobs, kept live by `cron.snapshot`, with times that
 * move on by themselves.
 */
export function ScheduledJobs({ state }: { state: EngineState }) {
  const { jobs, maxConcurrent } = scheduledJobs(state.results['cron.snapshot']);
  const [now, setNow] = useState(() => Date.now());
  const hasJobs = jobs.length > 0;
  useEffect(() => {
    if (!hasJobs) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [hasJobs]);
  if (!hasJobs) return null;
  const overdue = jobs.some((job) => job.overdue);
  return (
    <details className={overdue ? 'scheduled-jobs overdue' : 'scheduled-jobs'}>
      <summary>
        <CalendarClock size={14} /> Scheduled jobs · {scheduledSummary(jobs)}
      </summary>
      <ul>
        {jobs.map((job) => {
          const status = !job.enabled ? 'paused' : job.overdue ? 'overdue' : 'active';
          return (
            <li key={job.name}>
              <div className="scheduled-job-head">
                <strong>{job.name}</strong>
                <span className={`scheduled-job-status ${status}`}>{status}</span>
              </div>
              <small>
                every {intervalText(job.intervalMs)} · {job.runCount} run
                {job.runCount === 1 ? '' : 's'} · next {whenText(job.nextRun, now)} · last{' '}
                {whenText(job.lastRun, now)}
              </small>
              {job.action && (
                <code className="scheduled-job-action" title={job.action}>
                  {job.action}
                </code>
              )}
            </li>
          );
        })}
      </ul>
      <p>
        {maxConcurrent > 0 && `Up to ${maxConcurrent} run at once. `}Ask the agent to schedule a job
        with <code>cron_schedule</code> or remove one with <code>cron_cancel</code>.
      </p>
    </details>
  );
}
