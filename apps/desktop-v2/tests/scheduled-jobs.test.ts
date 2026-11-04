// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyEngineState, reduceEngine } from '../src/engine-state';
import { ScheduledJobs } from '../src/ScheduledJobs';
import {
  intervalText,
  scheduledJobs,
  scheduledSummary,
  whenText,
} from '../src/scheduled-jobs-model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse('2026-11-04T10:00:00.000Z');
const snapshot = {
  count: 2,
  maxConcurrent: 3,
  jobs: [
    {
      name: 'check-ci',
      intervalMs: 300_000,
      action: 'Check the CI run and report failures',
      enabled: true,
      lastRun: '2026-11-04T09:58:00.000Z',
      nextRun: '2026-11-04T10:03:00.000Z',
      runCount: 4,
      overdue: false,
    },
    {
      name: 'nightly',
      intervalMs: 86_400_000,
      action: 'Run the nightly report',
      enabled: true,
      lastRun: null,
      nextRun: '2026-11-04T08:00:00.000Z',
      runCount: 0,
      overdue: true,
    },
  ],
};

describe('scheduled jobs', () => {
  afterEach(() => vi.useRealTimers());

  it('reads the scheduler snapshot and words it as the WebUI does', () => {
    const { jobs, maxConcurrent } = scheduledJobs(snapshot);
    expect(maxConcurrent).toBe(3);
    expect(jobs.map((job) => job.name)).toEqual(['check-ci', 'nightly']);
    expect(scheduledSummary(jobs)).toBe('1 of 2 active · 1 overdue · 4 runs');
    expect(intervalText(300_000)).toBe('5m');
    expect(intervalText(5_400_000)).toBe('1.5h');
    expect(intervalText(45_000)).toBe('45s');
    expect(whenText('2026-11-04T10:03:00.000Z', NOW)).toBe('in 3m');
    expect(whenText('2026-11-04T08:00:00.000Z', NOW)).toBe('2h ago');
    expect(whenText(null, NOW)).toBe('—');
    expect(scheduledJobs(undefined).jobs).toEqual([]);
  });

  it('appears only while the conversation has jobs, from the engine broadcast', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const host = document.createElement('div');
    const root = createRoot(host);
    act(() => root.render(createElement(ScheduledJobs, { state: emptyEngineState })));
    expect(host.textContent).toBe('');
    const live = reduceEngine(emptyEngineState, { type: 'cron.snapshot', payload: snapshot });
    act(() => root.render(createElement(ScheduledJobs, { state: live })));
    expect(host.querySelector('summary')?.textContent).toContain(
      'Scheduled jobs · 1 of 2 active · 1 overdue · 4 runs',
    );
    expect(host.querySelector('.scheduled-jobs.overdue')).not.toBeNull();
    expect(host.textContent).toContain('every 5m · 4 runs · next in 3m · last 2m ago');
    act(() => vi.advanceTimersByTime(60_000));
    expect(host.textContent).toContain('next in 2m');
    const cleared = reduceEngine(live, {
      type: 'cron.snapshot',
      payload: { count: 0, maxConcurrent: 3, jobs: [] },
    });
    act(() => root.render(createElement(ScheduledJobs, { state: cleared })));
    expect(host.textContent).toBe('');
  });

  it('forgets the jobs when the engine connection closes, since a new engine has none', () => {
    const live = reduceEngine(emptyEngineState, { type: 'cron.snapshot', payload: snapshot });
    const closed = reduceEngine(live, { type: 'desktop.disconnected', payload: {} });
    expect(scheduledJobs(closed.results['cron.snapshot']).jobs).toEqual([]);
    expect(scheduledJobs(live.results['cron.snapshot']).jobs).toHaveLength(2);
  });
});
