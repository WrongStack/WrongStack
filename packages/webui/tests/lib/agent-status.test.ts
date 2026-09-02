import { describe, expect, it } from 'vitest';
import {
  AGENT_STATUS_LABEL,
  classifyCtxPct,
  compareAgentsByActivity,
  computeAgentStats,
  fmtCost,
  fmtDuration,
  fmtTok,
  isAgentActive,
  tallyAgents,
} from '../../src/lib/agent-status.js';
import type { SubagentView } from '../../src/stores/types.js';

const mk = (status: string, startedAt: number) => ({ status, startedAt });

/** Minimal SubagentView factory for computeAgentStats tests. */
function agent(overrides: Partial<SubagentView> & { id: string; name: string }): SubagentView {
  return {
    id: overrides.id,
    name: overrides.name,
    status: overrides.status ?? 'running',
    iteration: overrides.iteration ?? 0,
    toolCalls: overrides.toolCalls ?? 0,
    costUsd: overrides.costUsd ?? 0,
    ctxPct: overrides.ctxPct ?? 0,
    ctxTokens: overrides.ctxTokens ?? 0,
    maxContext: overrides.maxContext ?? 0,
    extensions: overrides.extensions ?? 0,
    startedAt: overrides.startedAt ?? 0,
    completedAt: overrides.completedAt,
    toolLog: overrides.toolLog ?? [],
    sparklineBins: overrides.sparklineBins ?? Array(12).fill(0),
    tokensIn: overrides.tokensIn,
    tokensOut: overrides.tokensOut,
  } as SubagentView;
}

describe('agent-status helpers', () => {
  it('isAgentActive is true only for running', () => {
    expect(isAgentActive('running')).toBe(true);
    for (const s of ['completed', 'failed', 'timeout', 'stopped', 'idle']) {
      expect(isAgentActive(s)).toBe(false);
    }
  });

  it('AGENT_STATUS_LABEL maps completed → done and passes others through', () => {
    expect(AGENT_STATUS_LABEL.completed).toBe('done');
    expect(AGENT_STATUS_LABEL.running).toBe('running');
    expect(AGENT_STATUS_LABEL.failed).toBe('failed');
    expect(AGENT_STATUS_LABEL.timeout).toBe('timeout');
    expect(AGENT_STATUS_LABEL.stopped).toBe('stopped');
  });

  it('compareAgentsByActivity puts running first, then oldest-started', () => {
    const list = [mk('completed', 100), mk('running', 300), mk('running', 200), mk('failed', 50)];
    const sorted = [...list].sort(compareAgentsByActivity);
    expect(sorted.map((a) => `${a.status}@${a.startedAt}`)).toEqual([
      'running@200',
      'running@300',
      'failed@50',
      'completed@100',
    ]);
  });

  it('tallyAgents buckets running / completed / failed(+timeout) and total', () => {
    const t = tallyAgents([
      mk('running', 1),
      mk('running', 2),
      mk('completed', 3),
      mk('failed', 4),
      mk('timeout', 5),
      mk('stopped', 6),
    ]);
    expect(t).toEqual({ running: 2, completed: 1, failed: 2, total: 6 });
  });

  it('tallyAgents on an empty list is all zeros', () => {
    expect(tallyAgents([])).toEqual({ running: 0, completed: 0, failed: 0, total: 0 });
  });
});

describe('classifyCtxPct', () => {
  it('clamps and classifies low below 70', () => {
    expect(classifyCtxPct(0)).toEqual({ clamped: 0, severity: 'low' });
    expect(classifyCtxPct(50)).toEqual({ clamped: 50, severity: 'low' });
    expect(classifyCtxPct(69)).toEqual({ clamped: 69, severity: 'low' });
  });

  it('classifies medium at 70–84', () => {
    expect(classifyCtxPct(70)).toEqual({ clamped: 70, severity: 'medium' });
    expect(classifyCtxPct(80)).toEqual({ clamped: 80, severity: 'medium' });
    expect(classifyCtxPct(84)).toEqual({ clamped: 84, severity: 'medium' });
  });

  it('classifies high at 85+', () => {
    expect(classifyCtxPct(85)).toEqual({ clamped: 85, severity: 'high' });
    expect(classifyCtxPct(95)).toEqual({ clamped: 95, severity: 'high' });
    expect(classifyCtxPct(100)).toEqual({ clamped: 100, severity: 'high' });
  });

  it('clamps out-of-range values', () => {
    expect(classifyCtxPct(-10)).toEqual({ clamped: 0, severity: 'low' });
    expect(classifyCtxPct(150)).toEqual({ clamped: 100, severity: 'high' });
  });

  it('handles NaN and Infinity gracefully', () => {
    expect(classifyCtxPct(Number.NaN)).toEqual({ clamped: 0, severity: 'low' });
    expect(classifyCtxPct(Number.POSITIVE_INFINITY)).toEqual({ clamped: 0, severity: 'low' });
  });
});

describe('fmtTok', () => {
  it('formats small numbers as-is', () => {
    expect(fmtTok(0)).toBe('0');
    expect(fmtTok(5)).toBe('5');
    expect(fmtTok(999)).toBe('999');
  });

  it('formats thousands as K', () => {
    expect(fmtTok(1_000)).toBe('1.0K');
    expect(fmtTok(1_500)).toBe('1.5K');
    expect(fmtTok(999_999)).toBe('1000.0K');
  });

  it('formats millions as M', () => {
    expect(fmtTok(1_000_000)).toBe('1.0M');
    expect(fmtTok(2_500_000)).toBe('2.5M');
  });

  it('returns "0" for null, undefined, NaN, Infinity', () => {
    expect(fmtTok(null)).toBe('0');
    expect(fmtTok(undefined)).toBe('0');
    expect(fmtTok(Number.NaN)).toBe('0');
    expect(fmtTok(Number.POSITIVE_INFINITY)).toBe('0');
  });

  it('clamps negative values to "0"', () => {
    expect(fmtTok(-5)).toBe('0');
    expect(fmtTok(-1000)).toBe('0');
  });
});

describe('fmtCost', () => {
  it('returns "$0" for zero, negative, null, NaN', () => {
    expect(fmtCost(0)).toBe('$0');
    expect(fmtCost(-0.5)).toBe('$0');
    expect(fmtCost(null)).toBe('$0');
    expect(fmtCost(undefined)).toBe('$0');
    expect(fmtCost(Number.NaN)).toBe('$0');
  });

  it('formats sub-cent values with 5 decimal places', () => {
    expect(fmtCost(0.001)).toBe('$0.001');
    expect(fmtCost(0.009)).toBe('$0.009');
  });

  it('preserves trailing zero when the 5th decimal place is significant', () => {
    // 0.0001 → toFixed(5) → "0.00010" — the trailing zero is padding,
    // and the regex should produce "$0.0001".
    expect(fmtCost(0.0001)).toBe('$0.0001');
    // Same value written with explicit trailing zero → same result.
    expect(fmtCost(0.0001)).toBe('$0.0001');
    // Very small sub-cent values that round to zero at 5 decimals return $0.
    expect(fmtCost(0.000001)).toBe('$0');
    expect(fmtCost(1e-7)).toBe('$0');
  });

  it('formats regular values with 3 decimal places', () => {
    expect(fmtCost(0.01)).toBe('$0.010');
    expect(fmtCost(0.1)).toBe('$0.100');
    expect(fmtCost(1)).toBe('$1.000');
    expect(fmtCost(12.345)).toBe('$12.345');
  });
});

describe('fmtDuration', () => {
  it('returns "—" for null, undefined, NaN, negative', () => {
    expect(fmtDuration(null)).toBe('—');
    expect(fmtDuration(undefined)).toBe('—');
    expect(fmtDuration(Number.NaN)).toBe('—');
    expect(fmtDuration(-100)).toBe('—');
  });

  it('formats seconds (< 60s)', () => {
    expect(fmtDuration(0)).toBe('0s');
    expect(fmtDuration(5_000)).toBe('5s');
    expect(fmtDuration(59_000)).toBe('59s');
  });

  it('formats minutes and seconds (1–60 min)', () => {
    expect(fmtDuration(60_000)).toBe('1m 0s');
    expect(fmtDuration(90_000)).toBe('1m 30s');
    expect(fmtDuration(3_590_000)).toBe('59m 50s');
  });

  it('formats hours and minutes (1–24 h)', () => {
    expect(fmtDuration(3_600_000)).toBe('1h 0m');
    expect(fmtDuration(7_800_000)).toBe('2h 10m');
    expect(fmtDuration(86_390_000)).toBe('23h 59m');
  });

  it('formats days (≥24 h)', () => {
    expect(fmtDuration(86_400_000)).toBe('1d');
    expect(fmtDuration(172_800_000)).toBe('2d');
  });
});

describe('computeAgentStats', () => {
  const NOW = 1_000_000_000_000;

  it('computes stats for a running agent using live elapsed', () => {
    const a = agent({
      id: 'a1',
      name: 'worker-1',
      status: 'running',
      startedAt: NOW - 120_000, // 2 min ago
      iteration: 5,
      toolCalls: 42,
      costUsd: 0.123,
      ctxPct: 72,
      tokensIn: 10_000,
      tokensOut: 5_000,
    });

    const stats = computeAgentStats(a, NOW);

    expect(stats.ctxClamped).toBe(72);
    expect(stats.ctxSeverity).toBe('medium');
    expect(stats.elapsed).toBe('2m 0s');
    expect(stats.cost).toBe('$0.123');
    expect(stats.iterationCount).toBe(5);
    expect(stats.toolCount).toBe(42);
    expect(stats.tokensIn).toBe('10.0K');
    expect(stats.tokensOut).toBe('5.0K');
  });

  it('computes stats for a completed agent using completedAt', () => {
    const a = agent({
      id: 'a2',
      name: 'done-worker',
      status: 'completed',
      startedAt: NOW - 300_000, // 5 min ago
      completedAt: NOW - 60_000, // completed 1 min ago → 4 min elapsed
      iteration: 10,
      toolCalls: 99,
      costUsd: 0.5,
      ctxPct: 30,
    });

    const stats = computeAgentStats(a, NOW);

    expect(stats.elapsed).toBe('4m 0s');
    expect(stats.cost).toBe('$0.500');
    expect(stats.iterationCount).toBe(10);
    expect(stats.toolCount).toBe(99);
    expect(stats.ctxSeverity).toBe('low');
  });

  it('computes stats for a failed agent without completedAt', () => {
    const a = agent({
      id: 'a3',
      name: 'failed-worker',
      status: 'failed',
      startedAt: NOW - 5000,
      // no completedAt — falls back to `now`
    });

    const stats = computeAgentStats(a, NOW);
    expect(stats.elapsed).toBe('5s');
    expect(stats.ctxSeverity).toBe('low');
    expect(stats.cost).toBe('$0');
  });

  it('handles high context with high severity', () => {
    const a = agent({
      id: 'a4',
      name: 'hot-agent',
      status: 'running',
      startedAt: NOW,
      ctxPct: 92,
    });

    const stats = computeAgentStats(a, NOW);
    expect(stats.ctxClamped).toBe(92);
    expect(stats.ctxSeverity).toBe('high');
  });

  it('returns em-dash for startedAt=0 (stale snapshot guard)', () => {
    const a = agent({
      id: 'a6',
      name: 'pre-init-agent',
      status: 'failed',
      startedAt: 0,
      // no completedAt — would otherwise compute now - 0 ≈ 5e11 ms
    });

    const stats = computeAgentStats(a, NOW);
    expect(stats.elapsed).toBe('\u2014');
  });

  it('handles NaN ctxPct gracefully', () => {
    const a = agent({
      id: 'a5',
      name: 'weird-agent',
      status: 'running',
      startedAt: NOW,
      ctxPct: Number.NaN,
    });

    const stats = computeAgentStats(a, NOW);
    expect(stats.ctxClamped).toBe(0);
    expect(stats.ctxSeverity).toBe('low');
  });
});
