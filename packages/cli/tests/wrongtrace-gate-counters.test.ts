import { afterEach, describe, expect, it } from 'vitest';
import {
  createWrongTraceGateCounter,
  formatGateCounterReport,
  loadWrongTraceGateCounters,
  persistWrongTraceGateCounters,
  recordGateDecision,
  resetGateDecisions,
  snapshotGateDecisions,
  type WrongTraceGateCounterSnapshot,
} from '../src/wiring/wrongtrace-gate-counters.js';

const EVENT_FACTORY = {
  deny: (path = 'a.ts') => ({ kind: 'deny', path, reason: 'WrongTrace lock: peer' }),
  allowFragile: (path = 'b.ts') => ({ kind: 'allow-fragile', path, reasons: ['x'] }),
  lockAcquired: (path = 'c.ts') => ({ kind: 'lock-acquired', path, owner: 'wrongstack:s1' }),
  lockConflictRace: (path = 'd.ts') => ({ kind: 'lock-conflict-race', path }),
  lockReleased: (path = 'e.ts') => ({ kind: 'lock-released', path }),
} as const;

type KnownEvent = ReturnType<(typeof EVENT_FACTORY)[keyof typeof EVENT_FACTORY]>;

describe('wrongtrace-gate-counters', () => {
  afterEach(() => {
    resetGateDecisions();
  });

  it('tallies each decision kind and total', () => {
    const c = createWrongTraceGateCounter();
    c.record(EVENT_FACTORY.deny());
    c.record(EVENT_FACTORY.deny());
    c.record(EVENT_FACTORY.allowFragile());
    c.record(EVENT_FACTORY.lockAcquired());
    c.record(EVENT_FACTORY.lockConflictRace());
    c.record(EVENT_FACTORY.lockReleased());

    expect(c.snapshot()).toEqual({
      deny: 2,
      allowFragile: 1,
      lockAcquired: 1,
      lockConflictRace: 1,
      lockReleased: 1,
      total: 6,
    });
  });

  it('reset zeroes the tally', () => {
    const c = createWrongTraceGateCounter();
    c.record(EVENT_FACTORY.deny());
    c.reset();
    expect(c.snapshot()).toEqual({
      deny: 0,
      allowFragile: 0,
      lockAcquired: 0,
      lockConflictRace: 0,
      lockReleased: 0,
      total: 0,
    });
  });

  it('process-shared singleton records and snapshots', () => {
    recordGateDecision(EVENT_FACTORY.deny());
    recordGateDecision(EVENT_FACTORY.lockAcquired());
    const s = snapshotGateDecisions();
    expect(s.deny).toBe(1);
    expect(s.lockAcquired).toBe(1);
    expect(s.total).toBe(2);
  });

  it('persist/load round-trips a snapshot', async () => {
    const c = createWrongTraceGateCounter();
    c.record(EVENT_FACTORY.deny());
    const snapshot: WrongTraceGateCounterSnapshot = c.snapshot();

    // Isolated tmp dir so the test can't collide with a live session's file.
    const os = await import('node:os');
    const path = await import('node:path');
    await persistWrongTraceGateCounters(os.tmpdir(), snapshot);

    const loaded = await loadWrongTraceGateCounters(os.tmpdir());
    expect(loaded).toEqual(snapshot);
    expect(path.join).toBeDefined(); // keep path import used
  });

  it('formatGateCounterReport is human-readable', () => {
    const c = createWrongTraceGateCounter();
    c.record(EVENT_FACTORY.deny());
    c.record(EVENT_FACTORY.lockAcquired());
    const line = formatGateCounterReport(c.snapshot());
    expect(line).toContain('deny=1');
    expect(line).toContain('lock-acquired=1');
    expect(line).toContain('total=2');
  });

  it('load returns null when no file exists', async () => {
    const path = await import('node:path');
    const absent = path.join(process.cwd(), '.wrongstack', 'definitely-missing-counters.json');
    // Point at a nonexistent path via a fake projectRoot deep under tmp.
    const loaded = await loadWrongTraceGateCounters(path.join(process.cwd(), 'no-such-project-dir-xyz'));
    expect(loaded).toBeNull();
    expect(absent.length).toBeGreaterThan(0);
  });

  // Type-level: all event kinds are assignable.
  const _types: KnownEvent[] = [
    EVENT_FACTORY.deny(),
    EVENT_FACTORY.allowFragile(),
    EVENT_FACTORY.lockAcquired(),
    EVENT_FACTORY.lockConflictRace(),
    EVENT_FACTORY.lockReleased(),
  ];
  void _types;
});