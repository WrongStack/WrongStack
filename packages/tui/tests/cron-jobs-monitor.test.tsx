import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CronJobsMonitor, type CronListResult } from '../src/components/cron-jobs.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));
const NOW = new Date('2026-07-30T12:00:00.000Z').getTime();

/**
 * Sample frames until `predicate` holds (bounded). A single `flush()` is not
 * sufficient: the observed content lands only after effect → fetch promise →
 * setState → React/ink scheduler commit, and the commit is a macrotask that
 * does not guarantee ordering against one `setImmediate`. On a contended CI
 * runner the sample can beat the commit and read the initial frame — the
 * exact failure of CI run 32137776491 ('cron offline' assertion saw the
 * pre-commit 'No cron jobs' empty state). Polling the rendered frame until
 * it settles removes the ordering assumption entirely.
 */
async function waitForFrame(
  view: { lastFrame: () => string | undefined },
  predicate: (frame: string) => boolean,
  timeoutMs = 2000,
): Promise<string> {
  // performance.now(), NOT Date.now(): the first test freezes Date.now to a
  // constant, which would make a Date.now()-derived deadline unreachable and
  // convert a genuine regression into a 60s testTimeout hang instead of a
  // crisp assertion failure. performance.now() is monotonic and mock-free.
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const frame = view.lastFrame() ?? '';
    if (predicate(frame)) return frame;
    if (performance.now() > deadline) return frame;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

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
  // Restored here rather than at the end of the first test so a thrown
  // assertion there cannot leak the frozen Date.now into the remaining
  // tests (whose waitForFrame bounds would then be dead too).
  vi.restoreAllMocks();
});

describe('CronJobsMonitor', () => {
  it('renders live job summaries, interval units, and relative times', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const getCronJobs = vi.fn().mockResolvedValue(snapshot());
    const view = render(React.createElement(CronJobsMonitor, { getCronJobs }));
    const frame = await waitForFrame(
      view,
      (f) => f.includes('CRON JOBS') && f.includes('fast-job'),
    );

    expect(frame).toContain('2 / 3 jobs');
    expect(frame).toContain('1 overdue');
    expect(frame).toContain('5 runs');
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
    expect(await waitForFrame(failed, (f) => f.includes('cron offline'))).toContain('cron offline');
    failed.unmount();

    const rejected = render(
      React.createElement(CronJobsMonitor, {
        getCronJobs: vi.fn().mockRejectedValue(new Error('network down')),
      }),
    );
    expect(await waitForFrame(rejected, (f) => f.includes('network down'))).toContain(
      'network down',
    );
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
    const frame = await waitForFrame(view, (f) => f.includes('No cron jobs'));
    expect(frame).toContain('cron_schedule');
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
    await waitForFrame(view, (f) => f.includes('fast-job'));
    view.stdin.write('x');
    expect(await waitForFrame(view, (f) => f.includes('Cancel “fast-job”?'))).toContain(
      'Cancel “fast-job”?',
    );
    expect(onCancel).not.toHaveBeenCalled();

    view.stdin.write('y');
    await flush();
    expect(onCancel).toHaveBeenCalledWith('fast-job');
    view.unmount();
  });
});
