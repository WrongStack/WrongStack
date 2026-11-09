import { CalendarClock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Trans } from 'react-i18next';
import { useDesktopText } from './desktop-i18n';
import type { EngineState } from './engine-state';
import {
  intervalText,
  type ScheduleWords,
  scheduledJobs,
  scheduledSummary,
  whenText,
} from './scheduled-jobs-model';
import { surfaceI18n } from './surface-i18n';
import './scheduled-jobs.css';

/**
 * The wakeups this conversation's agent scheduled with `session_wakeup`, as the WebUI's panel
 * shows them: shown only while there are jobs, kept live by `cron.snapshot`, with times that
 * move on by themselves.
 */
export function ScheduledJobs({ state }: { state: EngineState }) {
  const { t } = useDesktopText();
  const words: ScheduleWords = {
    in: (amount) => t('jobs.in', { amount }),
    ago: (amount) => t('jobs.ago', { amount }),
    active: (active, total) => t('jobs.active', { active, total }),
    overdue: (count) => t('jobs.overdue', { count }),
    runs: (count) => t(count === 1 ? 'jobs.run' : 'jobs.runs', { count }),
  };
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
        <CalendarClock size={14} /> {t('jobs.title')} · {scheduledSummary(jobs, words)}
      </summary>
      <ul>
        {jobs.map((job) => {
          const status = !job.enabled ? 'paused' : job.overdue ? 'overdue' : 'active';
          return (
            <li key={job.name}>
              <div className="scheduled-job-head">
                <strong>{job.name}</strong>
                <span className={`scheduled-job-status ${status}`}>
                  {t(`jobs.status.${status}`)}
                </span>
              </div>
              <small>
                {[
                  // A one-shot wakeup has no interval.
                  ...(job.intervalMs > 0
                    ? [t('jobs.every', { interval: intervalText(job.intervalMs) })]
                    : []),
                  words.runs(job.runCount),
                  t('jobs.next', { when: whenText(job.nextRun, now, words) }),
                  t('jobs.last', { when: whenText(job.lastRun, now, words) }),
                ].join(' · ')}
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
        {maxConcurrent > 0 && `${t('jobs.limit', { count: maxConcurrent })} `}
        <Trans
          i18n={surfaceI18n}
          ns="desktop"
          i18nKey="jobs.howTo"
          components={{ code: <code /> }}
        />
      </p>
    </details>
  );
}
