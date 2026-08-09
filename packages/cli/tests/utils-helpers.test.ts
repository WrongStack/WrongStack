import { describe, expect, it } from 'vitest';
import { fmtDuration, fmtTaskResultLine, fmtTok, patchConfig } from '../src/utils.js';

const noColor = {
  green: (s: string) => s,
  red: (s: string) => s,
  yellow: (s: string) => s,
  dim: (s: string) => s,
};

describe('fmtTok', () => {
  it('returns raw string below 1000', () => {
    expect(fmtTok(0)).toBe('0');
    expect(fmtTok(999)).toBe('999');
  });

  it('rounds to one decimal when below 10k', () => {
    expect(fmtTok(1200)).toBe('1.2k');
    expect(fmtTok(9999)).toBe('10.0k');
  });

  it('rounds to integer when 10k–1M', () => {
    expect(fmtTok(12_000)).toBe('12k');
    expect(fmtTok(999_999)).toBe('1000k');
  });

  it('renders millions with one decimal', () => {
    expect(fmtTok(1_500_000)).toBe('1.5M');
    expect(fmtTok(12_345_678)).toBe('12.3M');
  });
});

describe('patchConfig', () => {
  it('returns a new object with the patch applied', () => {
    const base = { provider: 'a', model: 'm' };
    const out = patchConfig(base, { model: 'new' });
    expect(out).toEqual({ provider: 'a', model: 'new' });
  });

  it('does not mutate the input', () => {
    const base: Record<string, number> = Object.freeze({ a: 1, b: 2 });
    const out = patchConfig(base, { b: 3 });
    expect(base.b).toBe(2);
    expect(out.b).toBe(3);
  });

  it('returned object is frozen', () => {
    const out = patchConfig({ x: 1 }, { x: 2 });
    expect(Object.isFrozen(out)).toBe(true);
  });
});

describe('fmtDuration', () => {
  it('renders milliseconds below 1s', () => {
    expect(fmtDuration(0)).toBe('0ms');
    expect(fmtDuration(999)).toBe('999ms');
  });

  it('renders seconds with one decimal below 10s', () => {
    expect(fmtDuration(1500)).toBe('1.5s');
    expect(fmtDuration(9999)).toBe('10.0s');
  });

  it('renders integer seconds from 10s–1min', () => {
    expect(fmtDuration(12_500)).toBe('13s');
    expect(fmtDuration(59_000)).toBe('59s');
  });

  it('renders Xm Ys for minutes', () => {
    expect(fmtDuration(60_000)).toBe('1m');
    expect(fmtDuration(160_016)).toBe('2m40s');
  });

  it('renders Xh Ym for hours', () => {
    expect(fmtDuration(3_600_000)).toBe('1h0m');
    expect(fmtDuration(7_200_000)).toBe('2h0m');
    expect(fmtDuration(7_500_000)).toBe('2h5m');
  });
});

describe('fmtTaskResultLine', () => {
  const base = { iterations: 3, toolCalls: 5, durationMs: 12_500 };

  it('renders success without tail', () => {
    const out = fmtTaskResultLine({ ...base, status: 'success' }, noColor);
    expect(out.mark).toBe('✓');
    expect(out.stats).toContain('3it 5tc');
    expect(out.stats).toContain('13s');
    expect(out.tail).toBe('');
  });

  it('renders failed with prefixed status and tail', () => {
    const out = fmtTaskResultLine({ ...base, status: 'failed', error: 'oh no' }, noColor);
    expect(out.mark).toBe('✗');
    expect(out.stats).toContain('failed');
    expect(out.tail).toContain('oh no');
  });

  it('renders timeout with yellow mark and tail', () => {
    const out = fmtTaskResultLine({ ...base, status: 'timeout', error: 'too slow' }, noColor);
    expect(out.mark).toBe('⏱');
    expect(out.stats).toContain('timeout');
    expect(out.tail).toContain('too slow');
  });

  it('renders stopped with dim mark', () => {
    const out = fmtTaskResultLine({ ...base, status: 'stopped' }, noColor);
    expect(out.mark).toBe('⊘');
    expect(out.stats).toContain('stopped');
  });

  it('surfaces structured error.kind and message', () => {
    const out = fmtTaskResultLine(
      {
        ...base,
        status: 'failed',
        error: { kind: 'provider_rate_limit', message: 'rate limited' },
      },
      noColor,
    );
    expect(out.tail).toContain('[provider_rate_limit]');
    expect(out.tail).toContain('rate limited');
  });

  it('truncates long error messages with ellipsis', () => {
    const longMsg = 'x'.repeat(200);
    const out = fmtTaskResultLine({ ...base, status: 'failed', error: longMsg }, noColor);
    expect(out.tail).toContain('…');
    expect(out.tail.length).toBeLessThan(longMsg.length);
  });

  it('collapses whitespace in error tails', () => {
    const out = fmtTaskResultLine(
      { ...base, status: 'failed', error: 'multi  \n   space\n\nerror' },
      noColor,
    );
    expect(out.tail).not.toMatch(/\n/);
    expect(out.tail).toContain('multi space error');
  });

  it('handles structured error with only kind (no message)', () => {
    const out = fmtTaskResultLine(
      { ...base, status: 'failed', error: { kind: 'unknown' } },
      noColor,
    );
    expect(out.tail).toContain('[unknown]');
  });
});
