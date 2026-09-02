import { describe, expect, it } from 'vitest';
import {
  bucketActivity,
  fmtCost,
  fmtDuration,
  fmtElapsed,
  getIterations,
  getLastEventAt,
  sparkline,
} from '../../src/components/AgentsPage';
import type { SubagentView } from '../../src/stores';

// ── Leader-style entry shape ───────────────────────────────────────────
interface LeaderEntry {
  id: 'leader';
  name: string;
  provider?: string | undefined;
  model?: string | undefined;
  status: 'running' | 'idle';
  iterations: number;
  toolCalls: number;
  costUsd: number;
  ctxPct: number;
  ctxTokens: number;
  maxContext: number;
  startedAt: number;
  lastEventAt: number;
  extensions: number;
  currentTool?: string | undefined;
  toolLog: SubagentView['toolLog'];
  partialText?: string | undefined;
  finalText?: string | undefined;
  error?: { kind: string | undefined; message: string } | undefined;
}

function makeLeader(overrides: Partial<LeaderEntry> = {}): LeaderEntry {
  return {
    id: 'leader',
    name: 'LEADER',
    status: 'idle',
    iterations: 42,
    toolCalls: 150,
    costUsd: 0.05,
    ctxPct: 55,
    ctxTokens: 110_000,
    maxContext: 200_000,
    startedAt: 1_000_000,
    lastEventAt: 1_200_000,
    extensions: 3,
    toolLog: [],
    ...overrides,
  };
}

function makeSub(overrides: Partial<SubagentView> & { id: string }): SubagentView {
  return {
    name: 'TestAgent',
    status: 'running',
    iteration: 10,
    toolCalls: 25,
    costUsd: 0.02,
    ctxPct: 30,
    ctxTokens: 60_000,
    maxContext: 200_000,
    extensions: 1,
    startedAt: 1_000_000,
    completedAt: undefined,
    toolLog: [],
    ...overrides,
  };
}

// ── getIterations ──────────────────────────────────────────────────────

describe('getIterations', () => {
  it('returns leader.iterations for leader entries', () => {
    const leader = makeLeader({ iterations: 42 });
    expect(getIterations(leader)).toBe(42);
  });

  it('returns agent.iteration for SubagentView entries', () => {
    const sub = makeSub({ id: 'a1', iteration: 10 });
    expect(getIterations(sub)).toBe(10);
  });

  it('returns 0 for subagent with no iteration set', () => {
    const sub = makeSub({ id: 'a2', iteration: 0 });
    expect(getIterations(sub)).toBe(0);
  });
});

// ── getLastEventAt ─────────────────────────────────────────────────────

describe('getLastEventAt', () => {
  it('returns leader.lastEventAt for leader entries', () => {
    const leader = makeLeader({ lastEventAt: 1_500_000 });
    expect(getLastEventAt(leader)).toBe(1_500_000);
  });

  it('returns completedAt for finished subagents', () => {
    const sub = makeSub({
      id: 'a3',
      status: 'completed',
      startedAt: 1_000_000,
      completedAt: 1_300_000,
    });
    expect(getLastEventAt(sub)).toBe(1_300_000);
  });

  it('falls back to startedAt when completedAt is undefined', () => {
    const sub = makeSub({
      id: 'a4',
      status: 'running',
      startedAt: 1_000_000,
      completedAt: undefined,
    });
    expect(getLastEventAt(sub)).toBe(1_000_000);
  });
});

// ── fmtCost ────────────────────────────────────────────────────────────

describe('fmtCost', () => {
  it('returns $0 for zero', () => {
    expect(fmtCost(0)).toBe('$0');
  });

  it('returns $0 for negative', () => {
    expect(fmtCost(-1)).toBe('$0');
  });

  it('formats >= 1 cent with 3 decimals', () => {
    expect(fmtCost(0.05)).toBe('$0.050');
    expect(fmtCost(1.5)).toBe('$1.500');
  });

  it('formats sub-cent values with high precision', () => {
    const result = fmtCost(0.000123);
    expect(result).toContain('$0.00012');
  });
});

// ── fmtDuration ────────────────────────────────────────────────────────

describe('fmtDuration', () => {
  it('formats seconds', () => {
    expect(fmtDuration(5000)).toBe('5s');
  });

  it('formats minutes', () => {
    expect(fmtDuration(120_000)).toBe('2m 0s');
  });

  it('formats longer durations', () => {
    expect(fmtDuration(185_000)).toBe('3m 5s');
  });
});

// ── fmtElapsed ─────────────────────────────────────────────────────────

describe('fmtElapsed', () => {
  it('formats seconds-only', () => {
    expect(fmtElapsed(45_000)).toBe('00:45');
  });

  it('formats minutes and seconds', () => {
    expect(fmtElapsed(125_000)).toBe('02:05');
  });

  it('formats hours', () => {
    expect(fmtElapsed(3_600_000 + 120_000)).toBe('1:02:00');
  });

  it('pad-zeros single-digit minutes', () => {
    expect(fmtElapsed(60_000)).toBe('01:00');
  });
});

// ── bucketActivity ─────────────────────────────────────────────────────

describe('bucketActivity', () => {
  it('returns zero-filled array for no timestamps', () => {
    const result = bucketActivity([], Date.now());
    expect(result).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('buckets timestamps into correct bins', () => {
    const now = 100_000;
    // 12 bins × 2000ms = 24000ms window
    // bin 0: at 76_000..78_000
    // bin 11: at 98_000..100_000
    const result = bucketActivity([77_000, 95_000, 99_500], now, 12, 2000);
    // bin 0 should have the 77_000 timestamp
    expect(result[0]).toBe(1);
    // bin 11 should have the 99_500 timestamp
    expect(result[11]).toBe(1);
    // Sum should be 3
    expect(result.reduce((s, v) => s + v, 0)).toBe(3);
  });

  it('ignores timestamps outside the window', () => {
    const now = 100_000;
    const result = bucketActivity([50_000, 150_000], now, 12, 2000);
    expect(result.reduce((s, v) => s + v, 0)).toBe(0);
  });

  it('handles edge timestamps at window boundary', () => {
    const now = 100_000;
    const windowStart = now - 12 * 2000; // 76_000
    const result = bucketActivity([windowStart, now], now, 12, 2000);
    expect(result[0]).toBe(1); // windowStart → bin 0
    expect(result[11]).toBe(1); // now → bin 11
  });

  it('respects custom bin count and size', () => {
    const now = 10_000;
    const result = bucketActivity([now - 500, now], now, 5, 1000);
    expect(result).toHaveLength(5);
    expect(result[4]).toBe(2);
  });
});

// ── sparkline ──────────────────────────────────────────────────────────

describe('sparkline', () => {
  it('returns empty string for empty input', () => {
    expect(sparkline([])).toBe('');
  });

  it('returns sparkline characters for values', () => {
    const result = sparkline([0, 1, 5, 10]);
    expect(result).toHaveLength(4);
    // 0 → '▁', non-zero at max → '█'
    expect(result[0]).toBe('▁');
    expect(result[3]).toBe('█');
  });

  it('handles uniform values (all zeros)', () => {
    const result = sparkline([0, 0, 0]);
    expect(result).toHaveLength(3);
    expect(result.split('').every((c) => c === '▁')).toBe(true);
  });

  it('handles uniform non-zero values', () => {
    const result = sparkline([5, 5, 5]);
    expect(result).toHaveLength(3);
    // All values equal max → all should be '█'
    expect(result.split('').every((c) => c === '█')).toBe(true);
  });

  it('scales proportionally to max', () => {
    const result = sparkline([1, 10, 100]);
    expect(result).toHaveLength(3);
    // 1/100 * 7 = 0.07 → ceil → 1 → SPARK[1] = '▂'
    expect(result[0]).toBe('▂');
    expect(result[1]).not.toBe('█'); // 10/100 → some middle value
    expect(result[2]).toBe('█'); // 100/100 → max
  });
});
