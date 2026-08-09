/**
 * Additional tests for CLI utilities — covering fmtDuration and fmtTaskResultLine.
 */
import { describe, expect, it } from 'vitest';
import { fmtDuration, fmtTaskResultLine, fmtTok, patchConfig } from '../src/utils.js';

const noColor = {
  green: (s: string) => s,
  red: (s: string) => s,
  yellow: (s: string) => s,
  dim: (s: string) => s,
};

// ============================================================================
// fmtTok (existing, extended)
// ============================================================================

describe('fmtTok', () => {
  it('handles boundary between k and M', () => {
    expect(fmtTok(999_999)).toBe('1000k');
    expect(fmtTok(1_000_000)).toBe('1.0M');
  });
});

// ============================================================================
// fmtDuration
// ============================================================================

describe('fmtDuration', () => {
  it('renders sub-second durations as ms', () => {
    expect(fmtDuration(0)).toBe('0ms');
    expect(fmtDuration(500)).toBe('500ms');
    expect(fmtDuration(999)).toBe('999ms');
  });

  it('renders seconds with one decimal under 10s', () => {
    expect(fmtDuration(1_000)).toBe('1.0s');
    expect(fmtDuration(1_500)).toBe('1.5s');
    expect(fmtDuration(9_999)).toBe('10.0s');
  });

  it('drops decimal at 10s and up', () => {
    expect(fmtDuration(10_000)).toBe('10s');
    expect(fmtDuration(59_000)).toBe('59s');
  });

  it('renders minutes and seconds', () => {
    expect(fmtDuration(60_000)).toBe('1m');
    expect(fmtDuration(61_000)).toBe('1m1s');
    expect(fmtDuration(120_000)).toBe('2m');
    expect(fmtDuration(160_016)).toBe('2m40s');
  });

  it('renders hours and minutes', () => {
    expect(fmtDuration(3_600_000)).toBe('1h0m');
    expect(fmtDuration(7_200_000)).toBe('2h0m');
    expect(fmtDuration(7_500_000)).toBe('2h5m');
  });

  it('handles boundary at 59m59s', () => {
    expect(fmtDuration(3_599_000)).toBe('59m59s');
  });
});

// ============================================================================
// fmtTaskResultLine
// ============================================================================

describe('fmtTaskResultLine', () => {
  const makeResult = (overrides: Record<string, unknown> = {}) => ({
    status: 'success' as const,
    error: undefined,
    iterations: 5,
    toolCalls: 12,
    durationMs: 30_000,
    ...overrides,
  });

  it('renders success', () => {
    const r = fmtTaskResultLine(makeResult(), noColor);
    expect(r.mark).toBe('✓');
    expect(r.stats).toContain('5it');
    expect(r.stats).toContain('12tc');
    expect(r.tail).toBe('');
  });

  it('renders timeout', () => {
    const r = fmtTaskResultLine(makeResult({ status: 'timeout', error: 'timed out' }), noColor);
    expect(r.mark).toBe('⏱');
    expect(r.stats).toContain('timeout');
    expect(r.tail).toContain('timed out');
  });

  it('renders stopped', () => {
    const r = fmtTaskResultLine(makeResult({ status: 'stopped' }), noColor);
    expect(r.mark).toBe('⊘');
    expect(r.stats).toContain('stopped');
  });

  it('renders failed with string error', () => {
    const r = fmtTaskResultLine(
      makeResult({ status: 'failed', error: 'something broke' }),
      noColor,
    );
    expect(r.mark).toBe('✗');
    expect(r.stats).toContain('failed');
    expect(r.tail).toContain('something broke');
  });

  it('renders failed with structured error (kind + message)', () => {
    const r = fmtTaskResultLine(
      makeResult({
        status: 'failed',
        error: { kind: 'provider_rate_limit', message: 'overloaded' },
      }),
      noColor,
    );
    expect(r.mark).toBe('✗');
    expect(r.tail).toContain('provider_rate_limit');
    expect(r.tail).toContain('overloaded');
  });

  it('truncates long error messages at 80 chars', () => {
    const longMsg = 'x'.repeat(200);
    const r = fmtTaskResultLine(makeResult({ status: 'failed', error: longMsg }), noColor);
    expect(r.tail.length).toBeLessThan(100);
    expect(r.tail).toContain('…');
  });

  it('collapses whitespace in error message', () => {
    const r = fmtTaskResultLine(
      makeResult({ status: 'failed', error: 'line1\n\n  line2\tline3' }),
      noColor,
    );
    expect(r.tail).not.toContain('\n');
    expect(r.tail).toContain('line1');
    expect(r.tail).toContain('line2');
  });

  it('renders with colored output (integration check)', () => {
    const color = {
      green: (s: string) => `[GREEN:${s}]`,
      red: (s: string) => `[RED:${s}]`,
      yellow: (s: string) => `[YELLOW:${s}]`,
      dim: (s: string) => `[DIM:${s}]`,
    };
    const r = fmtTaskResultLine(makeResult({ status: 'success' }), color);
    expect(r.mark).toContain('GREEN');
  });
});

// ============================================================================
// patchConfig (existing, extended)
// ============================================================================

describe('patchConfig', () => {
  it('returns frozen result', () => {
    const base: Record<string, number> = Object.freeze({ a: 1 });
    const patched = patchConfig(base, { a: 2 });
    expect(Object.isFrozen(patched)).toBe(true);
  });
});
