import { describe, expect, it } from 'vitest';
import {
  applyRatchet,
  evaluateGuard,
  formatGuardReport,
  guardFailed,
  type PerfBaselineEntry,
  type PerfBaselineFile,
  parseBaselineFile,
} from '../../src/performance/perf-guard.js';

const BASELINE: PerfBaselineFile = {
  schemaVersion: 1,
  thresholdPct: 10,
  entries: [
    {
      id: 'boot.cold-start',
      label: 'CLI cold start',
      metric: 'cold-start-ms',
      value: 400,
      source: 'hyperfine "wstack --version"',
      recordedAt: '2026-08-01T00:00:00.000Z',
    },
    {
      id: 'search.throughput',
      label: 'Index search throughput',
      metric: 'throughput-ops',
      value: 1000,
      source: 'vitest bench search',
      recordedAt: '2026-08-01T00:00:00.000Z',
    },
    {
      id: 'session.rss',
      label: 'Session peak RSS',
      metric: 'peak-rss-bytes',
      value: 500_000_000,
      source: '/usr/bin/time -v',
      recordedAt: '2026-08-01T00:00:00.000Z',
      thresholdPct: 25,
    },
  ],
};

describe('parseBaselineFile', () => {
  it('accepts a well-formed file and fills in defaults', () => {
    const parsed = parseBaselineFile(JSON.stringify({ entries: BASELINE.entries }));
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.thresholdPct).toBe(15);
    expect(parsed.entries).toHaveLength(3);
  });

  it('names the problem instead of throwing a JSON parse error at the user', () => {
    expect(() => parseBaselineFile('{oops')).toThrow(/not valid JSON/);
    expect(() => parseBaselineFile('null')).toThrow(/must be a JSON object/);
  });

  it('rejects a duplicate id, which would silently guard only one of them', () => {
    const entries = [BASELINE.entries[0], BASELINE.entries[0]];
    expect(() => parseBaselineFile(JSON.stringify({ entries }))).toThrow(/duplicate id/);
  });

  it('rejects an unknown metric and a non-numeric value', () => {
    expect(() =>
      parseBaselineFile(JSON.stringify({ entries: [{ ...BASELINE.entries[0], metric: 'vibes' }] })),
    ).toThrow(/unknown metric/);
    expect(() =>
      parseBaselineFile(JSON.stringify({ entries: [{ ...BASELINE.entries[0], value: 'fast' }] })),
    ).toThrow(/non-numeric value/);
  });
});

describe('evaluateGuard', () => {
  it('passes a run inside the band and fails one outside it', () => {
    const results = evaluateGuard(BASELINE, {
      'boot.cold-start': 420, // +5% slower, inside the 10% band
      'search.throughput': 1010,
      'session.rss': 700_000_000, // +40% — outside its own 25% override
    });
    const byId = new Map(results.map((r) => [r.id, r]));
    expect(byId.get('boot.cold-start')?.verdict).toBe('noise');
    expect(byId.get('session.rss')?.verdict).toBe('regressed');
    expect(byId.get('session.rss')?.thresholdPct).toBe(25);
    expect(guardFailed(results)).toBe(true);
  });

  it('reads a higher-is-better metric in the right direction', () => {
    const dropped = evaluateGuard(BASELINE, { 'search.throughput': 700 });
    expect(dropped.find((r) => r.id === 'search.throughput')?.verdict).toBe('regressed');
    const raised = evaluateGuard(BASELINE, { 'search.throughput': 1400 });
    expect(raised.find((r) => r.id === 'search.throughput')?.verdict).toBe('improved');
  });

  it('fails a baselined metric the run stopped reporting', () => {
    // A benchmark that silently stopped running is the most common way a green
    // guard quietly stops meaning anything.
    const results = evaluateGuard(BASELINE, { 'boot.cold-start': 400 });
    expect(results.filter((r) => r.verdict === 'missing')).toHaveLength(2);
    expect(guardFailed(results)).toBe(true);
  });

  it('can be told to ignore missing metrics', () => {
    const results = evaluateGuard(BASELINE, { 'boot.cold-start': 400 }, { failOnMissing: false });
    expect(guardFailed(results)).toBe(false);
  });

  it('surfaces an unbaselined measurement without failing on it', () => {
    const results = evaluateGuard(BASELINE, {
      'boot.cold-start': 400,
      'search.throughput': 1000,
      'session.rss': 5e8,
      'new.bench': 12,
    });
    expect(results.find((r) => r.id === 'new.bench')?.verdict).toBe('unbaselined');
    expect(guardFailed(results)).toBe(false);
  });
});

describe('applyRatchet', () => {
  const now = () => new Date('2026-09-01T12:00:00.000Z');

  it('tightens only the improved entries and never loosens', () => {
    const results = evaluateGuard(BASELINE, {
      'boot.cold-start': 300, // improved
      'search.throughput': 1010, // noise
      'session.rss': 900_000_000, // regressed
    });
    const { file, tightened } = applyRatchet(BASELINE, results, { now, commit: 'deadbee' });
    expect(tightened).toEqual(['boot.cold-start']);
    const byId = new Map(file.entries.map((e) => [e.id, e]));
    expect(byId.get('boot.cold-start')?.value).toBe(300);
    expect(byId.get('boot.cold-start')?.commit).toBe('deadbee');
    expect(byId.get('boot.cold-start')?.recordedAt).toBe('2026-09-01T12:00:00.000Z');
    // The regressed entry keeps its original number — re-recording a worse
    // value is how a "guarded" project drifts without a single red check.
    expect(byId.get('session.rss')?.value).toBe(500_000_000);
    expect(byId.get('search.throughput')?.value).toBe(1000);
  });

  it('does not mutate the input file', () => {
    const before = JSON.stringify(BASELINE);
    applyRatchet(BASELINE, evaluateGuard(BASELINE, { 'boot.cold-start': 100 }), { now });
    expect(JSON.stringify(BASELINE)).toBe(before);
  });

  it('adopts new measurements only when asked', () => {
    const results = evaluateGuard(BASELINE, { 'new.bench': 12 });
    expect(applyRatchet(BASELINE, results, { now }).adopted).toEqual([]);
    const adopted = applyRatchet(BASELINE, results, { now, adoptNew: true });
    expect(adopted.adopted).toEqual(['new.bench']);
    expect(adopted.file.entries).toHaveLength(4);
  });
});

describe('a declared but unrecorded probe', () => {
  const pending: PerfBaselineFile = {
    schemaVersion: 1,
    thresholdPct: 10,
    entries: [
      {
        id: 'boot.cold-start',
        label: 'CLI cold start',
        metric: 'cold-start-ms',
        value: null,
        source: 'hyperfine "wstack --version"',
        recordedAt: '1970-01-01T00:00:00.000Z',
      },
    ],
  };

  it('accepts null and a missing value as "not measured yet"', () => {
    expect(parseBaselineFile(JSON.stringify(pending)).entries[0]?.value).toBeNull();
    const withoutValue = { entries: [{ ...pending.entries[0], value: undefined }] };
    expect(parseBaselineFile(JSON.stringify(withoutValue)).entries[0]?.value).toBeNull();
  });

  it('never fails the guard — there is nothing to compare against', () => {
    // Seeding an unrecorded probe as 0 would report the first run as an
    // infinite regression, which makes a hand-authored baseline unusable.
    const measured = evaluateGuard(pending, { 'boot.cold-start': 400 });
    expect(measured[0]?.verdict).toBe('unbaselined');
    expect(guardFailed(measured)).toBe(false);
    const unmeasured = evaluateGuard(pending, {});
    expect(unmeasured[0]?.message).toMatch(/not measured yet/);
    expect(guardFailed(unmeasured)).toBe(false);
  });

  it('takes its first number in either direction, then ratchets normally', () => {
    const now = () => new Date('2026-09-01T12:00:00.000Z');
    const first = applyRatchet(pending, evaluateGuard(pending, { 'boot.cold-start': 400 }), {
      now,
    });
    expect(first.recorded).toEqual(['boot.cold-start']);
    expect(first.tightened).toEqual([]);
    expect(first.file.entries[0]?.value).toBe(400);

    // Now that it has a baseline, a worse number must not move it.
    const worse = applyRatchet(first.file, evaluateGuard(first.file, { 'boot.cold-start': 800 }), {
      now,
    });
    expect(worse.recorded).toEqual([]);
    expect(worse.file.entries[0]?.value).toBe(400);
  });

  it('is not double-counted as an adoption', () => {
    const now = () => new Date('2026-09-01T12:00:00.000Z');
    const result = applyRatchet(pending, evaluateGuard(pending, { 'boot.cold-start': 400 }), {
      now,
      adoptNew: true,
    });
    expect(result.adopted).toEqual([]);
    expect(result.file.entries).toHaveLength(1);
  });
});

describe('machine drift', () => {
  const HERE = 'ryzen-9950x / 32c / linux';
  const THERE = 'm2-pro / 12c / darwin';
  const recordedElsewhere: PerfBaselineFile = {
    schemaVersion: 1,
    thresholdPct: 10,
    entries: [
      {
        id: 'boot.cold-start',
        label: 'CLI cold start',
        metric: 'cold-start-ms',
        value: 400,
        source: 'hyperfine',
        recordedAt: '2026-08-01T00:00:00.000Z',
        machine: THERE,
      },
    ],
  };

  it('does not fail the gate on a baseline from another machine', () => {
    // A slower box would otherwise invent a regression nobody wrote.
    const results = evaluateGuard(
      recordedElsewhere,
      { 'boot.cold-start': 900 },
      { currentMachine: HERE },
    );
    expect(results[0]?.verdict).toBe('machine-drift');
    expect(results[0]?.message).toContain(THERE);
    expect(guardFailed(results)).toBe(false);
  });

  it('still reports the delta so the run is not silent', () => {
    const results = evaluateGuard(
      recordedElsewhere,
      { 'boot.cold-start': 800 },
      { currentMachine: HERE },
    );
    expect(results[0]?.deltaPct).toBeCloseTo(-100, 1);
    expect(results[0]?.current).toBe(800);
  });

  it('refuses to ratchet the baseline down on a faster machine', () => {
    // This is the dangerous direction: adopting a faster box's number leaves a
    // target the original machine can never hit, and every later run there
    // fails for a slowdown that never happened.
    const results = evaluateGuard(
      recordedElsewhere,
      { 'boot.cold-start': 120 },
      { currentMachine: HERE },
    );
    const { file, tightened, recorded } = applyRatchet(recordedElsewhere, results, {
      now: () => new Date('2026-09-01T12:00:00.000Z'),
    });
    expect(tightened).toEqual([]);
    expect(recorded).toEqual([]);
    expect(file.entries[0]?.value).toBe(400);
    expect(file.entries[0]?.machine).toBe(THERE);
  });

  it('compares normally on the machine the baseline came from', () => {
    const results = evaluateGuard(
      recordedElsewhere,
      { 'boot.cold-start': 900 },
      { currentMachine: THERE },
    );
    expect(results[0]?.verdict).toBe('regressed');
    expect(guardFailed(results)).toBe(true);
  });

  it('compares regardless when no current machine is supplied', () => {
    const results = evaluateGuard(recordedElsewhere, { 'boot.cold-start': 900 });
    expect(results[0]?.verdict).toBe('regressed');
  });

  it('records a never-measured probe here even if it names another machine', () => {
    // Nothing to protect yet: the first number is the baseline, and the ratchet
    // stamps this machine onto it.
    const pending: PerfBaselineFile = {
      ...recordedElsewhere,
      entries: [{ ...(recordedElsewhere.entries[0] as PerfBaselineEntry), value: null }],
    };
    const results = evaluateGuard(pending, { 'boot.cold-start': 400 }, { currentMachine: HERE });
    expect(results[0]?.verdict).toBe('unbaselined');
    const { recorded, file } = applyRatchet(pending, results, {
      now: () => new Date('2026-09-01T12:00:00.000Z'),
      machine: HERE,
    });
    expect(recorded).toEqual(['boot.cold-start']);
    expect(file.entries[0]?.machine).toBe(HERE);
  });
});

describe('formatGuardReport', () => {
  it('puts the failures first', () => {
    const results = evaluateGuard(BASELINE, {
      'boot.cold-start': 300,
      'search.throughput': 500,
      'session.rss': 500_000_000,
    });
    const report = formatGuardReport(results);
    expect(report[0]).toMatch(/^FAIL/);
    expect(report.some((line) => line.startsWith('GAIN'))).toBe(true);
  });
});
