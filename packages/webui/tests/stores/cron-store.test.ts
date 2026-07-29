import { beforeEach, describe, expect, it } from 'vitest';
import { type CronJobView, type CronSnapshot, useCronStore } from '../../src/stores/cron-store';

const store = () => useCronStore.getState();

function job(overrides: Partial<CronJobView> = {}): CronJobView {
  return {
    name: 'nightly-report',
    intervalMs: 86_400_000,
    action: '/report',
    enabled: true,
    lastRun: null,
    nextRun: '2026-07-30T03:00:00.000Z',
    runCount: 0,
    overdue: false,
    ...overrides,
  };
}

function snapshot(overrides: Partial<CronSnapshot> = {}): CronSnapshot {
  return { count: 1, maxConcurrent: 2, jobs: [job()], ...overrides };
}

describe('cron store', () => {
  beforeEach(() => {
    store().clear();
  });

  it('starts with no snapshot, no fire history and revision 0', () => {
    const s = store();
    expect(s.snapshot).toBeNull();
    expect(s.lastFiredAt).toEqual({});
    expect(s.revision).toBe(0);
  });

  it('setSnapshot stores the payload verbatim', () => {
    const snap = snapshot();
    store().setSnapshot(snap);
    expect(store().snapshot).toEqual(snap);
  });

  it('setSnapshot bumps the revision so components re-render', () => {
    store().setSnapshot(snapshot());
    expect(store().revision).toBe(1);
    store().setSnapshot(snapshot());
    expect(store().revision).toBe(2);
  });

  it('replaces the previous snapshot rather than merging it', () => {
    store().setSnapshot(snapshot({ jobs: [job({ name: 'a' }), job({ name: 'b' })], count: 2 }));
    store().setSnapshot(snapshot({ jobs: [job({ name: 'c' })], count: 1 }));
    expect(store().snapshot?.jobs.map((j) => j.name)).toEqual(['c']);
    expect(store().snapshot?.count).toBe(1);
  });

  it('carries overdue and disabled job flags through', () => {
    store().setSnapshot(
      snapshot({ jobs: [job({ name: 'stale', overdue: true, enabled: false, runCount: 12 })] }),
    );
    expect(store().snapshot?.jobs[0]).toMatchObject({
      overdue: true,
      enabled: false,
      runCount: 12,
    });
  });

  it('accepts an empty job list', () => {
    store().setSnapshot(snapshot({ count: 0, jobs: [] }));
    expect(store().snapshot?.jobs).toEqual([]);
    expect(store().revision).toBe(1);
  });

  it('recordFired keys the timestamp by job name', () => {
    store().recordFired('nightly-report', '2026-07-29T03:00:00.000Z');
    expect(store().lastFiredAt).toEqual({ 'nightly-report': '2026-07-29T03:00:00.000Z' });
  });

  it('recordFired bumps the revision', () => {
    store().recordFired('a', 't1');
    expect(store().revision).toBe(1);
  });

  it('recordFired overwrites an earlier timestamp for the same job', () => {
    store().recordFired('a', 't1');
    store().recordFired('a', 't2');
    expect(store().lastFiredAt.a).toBe('t2');
  });

  it('recordFired tracks jobs independently', () => {
    store().recordFired('a', 't1');
    store().recordFired('b', 't2');
    expect(store().lastFiredAt).toEqual({ a: 't1', b: 't2' });
  });

  it('recordFired accepts a job that is not in the current snapshot', () => {
    store().setSnapshot(snapshot());
    store().recordFired('not-in-snapshot', 't1');
    expect(store().lastFiredAt['not-in-snapshot']).toBe('t1');
  });

  it('replaces the lastFiredAt object so shallow-compared selectors re-run', () => {
    store().recordFired('a', 't1');
    const before = store().lastFiredAt;
    store().recordFired('b', 't2');
    expect(store().lastFiredAt).not.toBe(before);
  });

  it('setSnapshot preserves the fire history', () => {
    store().recordFired('a', 't1');
    store().setSnapshot(snapshot());
    expect(store().lastFiredAt.a).toBe('t1');
  });

  it('clear() resets the snapshot, history and revision', () => {
    store().setSnapshot(snapshot());
    store().recordFired('a', 't1');
    store().clear();
    const s = store();
    expect(s.snapshot).toBeNull();
    expect(s.lastFiredAt).toEqual({});
    expect(s.revision).toBe(0);
  });
});
