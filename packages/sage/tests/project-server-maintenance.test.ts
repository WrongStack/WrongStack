import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SageHygieneReport } from '../src/memory-hygiene-types.js';
import { createHygieneRunner, maintenanceDoctorCheck } from '../src/project-server-hygiene.js';
import type { CompleteSageStore } from '../src/project-server-options.js';

const REPORT = {
  startedAt: '2026-10-19T00:00:00.000Z',
  completedAt: '2026-10-19T00:00:01.000Z',
  examined: 10,
  deleted: 2,
  staled: 1,
  reviewCandidatesCreated: 0,
  superseded: 0,
} as unknown as SageHygieneReport;

let directory: string;
let statePath: string;

beforeEach(async () => {
  // Only the scheduler's clock is faked: the state file is written through
  // real fs promises, which need the real immediate/microtask machinery.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wrongstack-sage-maint-'));
  statePath = path.join(directory, 'hygiene', 'maintenance.json');
});

afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(directory, { recursive: true, force: true });
});

function fakeStore() {
  const hygiene = vi.fn(async () => REPORT);
  return { store: { hygiene } as unknown as CompleteSageStore, hygiene };
}

async function waitForState(): Promise<Record<string, unknown>> {
  // The write may wait on fs work and on a (faked) rename-retry timer; step
  // both. The budget is real time (performance is not faked): a count of polls
  // ran out in ~100ms when a loaded Windows host took longer to land the
  // write. Fake time stops advancing past the rename retries (~4s), so the
  // wait never reaches the runner's own interval and fires an extra pass.
  const deadline = performance.now() + 15_000;
  let faked = 0;
  while (performance.now() < deadline) {
    try {
      return JSON.parse(await fs.readFile(statePath, 'utf8')) as Record<string, unknown>;
    } catch {
      if (faked < 5_000) {
        await vi.advanceTimersByTimeAsync(10);
        faked += 10;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  throw new Error('maintenance state was never written');
}

describe('daemon-owned SAGE maintenance', () => {
  it('runs hygiene by itself once a host schedules it, then persists the run', async () => {
    const { store, hygiene } = fakeStore();
    const runner = createHygieneRunner(store, { statePath, settleMs: 1_000, intervalMs: 60_000 });
    const options = { retentionDays: 30 };

    expect(runner.schedule(options).scheduled).toBe(true);
    expect(hygiene).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(hygiene).toHaveBeenCalledWith(options);
    const state = await waitForState();
    expect(state['lastRunAt']).toEqual(expect.any(String));
    expect(runner.status().lastReport).toEqual(REPORT);

    // Re-armed for the next interval while the daemon stays alive.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hygiene).toHaveBeenCalledTimes(2);
    runner.dispose();
  });

  it('remembers the last run across daemon restarts instead of restarting the cadence', async () => {
    const first = fakeStore();
    const runner = createHygieneRunner(first.store, { statePath, settleMs: 0, intervalMs: 60_000 });
    runner.schedule();
    await vi.advanceTimersByTimeAsync(0);
    await waitForState();
    runner.dispose();

    const second = fakeStore();
    const restarted = createHygieneRunner(second.store, {
      statePath,
      settleMs: 0,
      intervalMs: 60_000,
    });
    // An automatic teardown request right after a restart is served from the
    // persisted report, not re-run.
    await expect(restarted.run({ automatic: true })).resolves.toEqual(REPORT);
    expect(second.hygiene).not.toHaveBeenCalled();

    restarted.schedule();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(second.hygiene).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(second.hygiene).toHaveBeenCalledTimes(1);
    restarted.dispose();
  });

  it('waits for in-flight requests before holding the daemon thread', async () => {
    const { store, hygiene } = fakeStore();
    let busy = true;
    const runner = createHygieneRunner(store, {
      settleMs: 0,
      intervalMs: 60_000,
      isBusy: () => busy,
    });
    runner.schedule();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(hygiene).not.toHaveBeenCalled();
    busy = false;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(hygiene).toHaveBeenCalledTimes(1);
    runner.dispose();
  });

  it('self-heals after every pass and keeps the schedule when healing fails', async () => {
    const { store, hygiene } = fakeStore();
    const afterMaintenance = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('doctor boom'))
      .mockResolvedValue(undefined);
    const log = vi.fn();
    const runner = createHygieneRunner(store, {
      settleMs: 0,
      intervalMs: 60_000,
      afterMaintenance,
      log,
    });
    runner.schedule();
    await vi.advanceTimersByTimeAsync(0);
    expect(afterMaintenance).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('doctor failed: doctor boom'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hygiene).toHaveBeenCalledTimes(2);
    expect(afterMaintenance).toHaveBeenCalledTimes(2);
    runner.dispose();
  });

  it('flags a store whose maintenance never ran, failed, or is overdue', () => {
    const now = Date.parse('2026-10-19T12:00:00.000Z');
    const base = {
      owner: 'daemon' as const,
      scheduled: true,
      intervalMs: 3_600_000,
      running: false,
    };
    expect(maintenanceDoctorCheck(base, now).severity).toBe('warn');
    expect(maintenanceDoctorCheck({ ...base, lastError: 'boom' }, now).severity).toBe('error');
    expect(
      maintenanceDoctorCheck({ ...base, lastRunAt: '2026-10-18T00:00:00.000Z' }, now).severity,
    ).toBe('warn');
    expect(
      maintenanceDoctorCheck({ ...base, lastRunAt: '2026-10-19T11:30:00.000Z' }, now).severity,
    ).toBe('ok');
  });
});
