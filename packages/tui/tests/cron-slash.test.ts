import { describe, expect, it } from 'vitest';
import { renderCronList, type CronListResult } from '../src/cron-slash.js';

function makeJob(
  overrides: Partial<CronListResult['jobs'][number]> = {},
): CronListResult['jobs'][number] {
  return {
    name: 'test-job',
    intervalMs: 30_000,
    action: 'check_health',
    enabled: true,
    lastRun: null,
    nextRun: new Date(Date.now() + 60_000).toISOString(),
    runCount: 0,
    overdue: false,
    ...overrides,
  };
}

function snapshot(jobs: CronListResult['jobs']): CronListResult {
  return {
    ok: true,
    count: jobs.length,
    maxConcurrent: 5,
    jobs: jobs.flat(),
  };
}

describe('renderCronList', () => {
  it('shows empty message when no jobs', () => {
    const result = snapshot([]);
    const output = renderCronList(result);

    expect(output).toContain('none scheduled');
    expect(output).toContain('Max concurrent: 5');
  });

  it('renders a single active job', () => {
    const result = snapshot([
      makeJob({ name: 'health-check', intervalMs: 30_000, action: 'check_health', runCount: 12 }),
    ]);
    const output = renderCronList(result);

    expect(output).toContain('health-check');
    expect(output).toContain('30.0s');
    expect(output).toContain('runs: 12');
    expect(output).toContain('1 job');
    expect(output).toContain('1 enabled');
    expect(output).toContain('0 overdue');
    expect(output).toMatch(/🟢.*active/);
  });

  it('shows overdue state', () => {
    const past = new Date(Date.now() - 120_000).toISOString();
    const result = snapshot([makeJob({ name: 'stale-job', nextRun: past, overdue: true })]);
    const output = renderCronList(result);

    expect(output).toContain('stale-job');
    expect(output).toContain('1 overdue');
    expect(output).toMatch(/🔶.*overdue/);
  });

  it('shows disabled state', () => {
    const result = snapshot([makeJob({ name: 'paused-job', enabled: false })]);
    const output = renderCronList(result);

    expect(output).toContain('paused-job');
    expect(output).toContain('0 enabled');
    expect(output).toMatch(/🔴.*disabled/);
  });

  it('renders multiple jobs with summary counts', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const result = snapshot([
      makeJob({ name: 'job-a', enabled: true, overdue: false, runCount: 5 }),
      makeJob({ name: 'job-b', enabled: true, overdue: true, nextRun: past, runCount: 3 }),
      makeJob({ name: 'job-c', enabled: false, runCount: 0 }),
    ]);
    const output = renderCronList(result);

    expect(output).toContain('3 jobs');
    expect(output).toContain('2 enabled');
    expect(output).toContain('1 overdue');
    expect(output).toContain('8 total runs');
    expect(output).toMatch(/🟢.*job-a/);
    expect(output).toMatch(/🔶.*job-b/);
    expect(output).toMatch(/🔴.*job-c/);
  });

  it('handles very long names and actions', () => {
    const longName = 'x'.repeat(60);
    const longAction = 'y'.repeat(80);
    const result = snapshot([makeJob({ name: longName, action: longAction })]);
    const output = renderCronList(result);

    // Long names and actions should be truncated (≤24 chars for name, ≤50 for action)
    expect(output).not.toContain(longName);
    expect(output).toContain('…');
  });

  it('formats various intervals', () => {
    const result = snapshot([
      makeJob({ name: 'fast', intervalMs: 1000 }),
      makeJob({ name: 'medium', intervalMs: 300_000 }),
      makeJob({ name: 'slow', intervalMs: 7_200_000 }),
    ]);
    const output = renderCronList(result);

    expect(output).toContain('1.0s');
    expect(output).toContain('5.0m');
    expect(output).toContain('2.0h');
  });
});
