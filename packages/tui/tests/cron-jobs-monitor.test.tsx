import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CronJobsMonitor, type CronListResult } from '../src/components/cron-jobs.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));
const NOW = new Date('2026-07-30T12:00:00.000Z').getTime();

function snapshot(): CronListResult {
  return {
    ok: true,
    count: 3,
    maxConcurrent: 2,
    jobs: [
      {
        name: 'fast-job',
        intervalMs: 500,
        action: 'run fast',
        enabled: true,
        lastRun: new Date(NOW - 30_000).toISOString(),
        nextRun: new Date(NOW + 30_000).toISOString(),
        runCount: 2,
        overdue: false,
      },
      {
        name: 'overdue-job',
        intervalMs: 120_000,
        action: 'run overdue',
        enabled: true,
        lastRun: new Date(NOW - 7_200_000).toISOString(),
        nextRun: new Date(NOW - 120_000).toISOString(),
        runCount: 3,
        overdue: true,
      },
      {
        name: 'disabled-job',
        intervalMs: 7_200_000,
        action: 'do nothing',
        enabled: false,
        lastRun: null,
        nextRun: new Date(NOW + 172_800_000).toISOString(),
        runCount: 0,
        overdue: false,
      },
    ],
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('CronJobsMonitor', () => {
  it('renders live job summaries, interval units, and relative times', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const getCronJobs = vi.fn().mockResolvedValue(snapshot());
    const view = render(React.createElement(CronJobsMonitor, { getCronJobs }));
    await flush();

    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('CRON JOBS');
    expect(frame).toContain('2 / 3 jobs');
    expect(frame).toContain('1 overdue');
    expect(frame).toContain('5 runs');
    expect(frame).toContain('fast-job');
    expect(frame).toContain('500ms');
    expect(frame).toContain('overdue-job');
    expect(frame).toContain('2.0m');
    expect(frame).toContain('disabled-job');
    expect(frame).toContain('2.0h');
    expect(frame).toContain('<1m');
    expect(frame).toContain('2h ago');
    view.unmount();
    vi.restoreAllMocks();
  });

  it('surfaces unsuccessful results and rejected refreshes', async () => {
    const failedResult = vi.fn().mockResolvedValue({
      ok: false,
      count: 0,
      maxConcurrent: 0,
      jobs: [],
      error: 'cron offline',
    });
    const failed = render(React.createElement(CronJobsMonitor, { getCronJobs: failedResult }));
    await flush();
    expect(failed.lastFrame() ?? '').toContain('cron offline');
    failed.unmount();

    const rejected = render(
      React.createElement(CronJobsMonitor, {
        getCronJobs: vi.fn().mockRejectedValue(new Error('network down')),
      }),
    );
    await flush();
    expect(rejected.lastFrame() ?? '').toContain('network down');
    rejected.unmount();
  });

  it('shows the empty state when no jobs are scheduled', async () => {
    const view = render(
      React.createElement(CronJobsMonitor, {
        getCronJobs: vi.fn().mockResolvedValue({
          ok: true,
          count: 0,
          maxConcurrent: 1,
          jobs: [],
        }),
      }),
    );
    await flush();
    expect(view.lastFrame() ?? '').toContain('No cron jobs');
    expect(view.lastFrame() ?? '').toContain('cron_schedule');
    view.unmount();
  });

  it('requires confirmation before cancelling the focused job', async () => {
    const onCancel = vi.fn().mockResolvedValue(null);
    const view = render(
      React.createElement(CronJobsMonitor, {
        getCronJobs: vi.fn().mockResolvedValue(snapshot()),
        onCancel,
      }),
    );
    await flush();
    view.stdin.write('x');
    await flush();
    expect(view.lastFrame() ?? '').toContain('Cancel “fast-job”?');
    expect(onCancel).not.toHaveBeenCalled();

    view.stdin.write('y');
    await flush();
    expect(onCancel).toHaveBeenCalledWith('fast-job');
    view.unmount();
  });
});
