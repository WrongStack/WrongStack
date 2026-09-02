import { describe, expect, it } from 'vitest';
import {
  fmtCost,
  fmtTok,
  fmtElapsed,
  fmtDuration,
  fmtAgo,
  shortModel,
  statusColor,
  sparkline,
} from '../../src/components/dashboard-primitives.js';

describe('dashboard-primitives', () => {
  describe('fmtCost', () => {
    it('formats zero and negative safely', () => {
      expect(fmtCost(0)).toBe('$0.0000');
      expect(fmtCost(-1)).toBe('$0.0000');
    });

    it('formats sub-cent costs with 4 decimals', () => {
      expect(fmtCost(0.0001)).toBe('$0.0001');
      expect(fmtCost(0.005)).toBe('$0.0050');
    });

    it('formats cent-level costs with 3 decimals', () => {
      expect(fmtCost(0.01)).toBe('$0.010');
      expect(fmtCost(0.5)).toBe('$0.500');
    });

    it('formats dollar+ costs with 2 decimals', () => {
      expect(fmtCost(1)).toBe('$1.00');
      expect(fmtCost(42.5)).toBe('$42.50');
    });

    it('handles undefined and non-finite', () => {
      expect(fmtCost(undefined)).toBe('$0.0000');
      expect(fmtCost(Number.NaN)).toBe('$0.0000');
      expect(fmtCost(Number.POSITIVE_INFINITY)).toBe('$0.0000');
    });
  });

  describe('fmtTok', () => {
    it('formats small numbers as-is', () => {
      expect(fmtTok(0)).toBe('0');
      expect(fmtTok(42)).toBe('42');
      expect(fmtTok(999)).toBe('999');
    });

    it('formats thousands with k suffix', () => {
      expect(fmtTok(1000)).toBe('1.0k');
      expect(fmtTok(1500)).toBe('1.5k');
    });

    it('formats millions with M suffix', () => {
      expect(fmtTok(1_000_000)).toBe('1.0M');
      expect(fmtTok(2_500_000)).toBe('2.5M');
    });

    it('handles undefined and non-finite', () => {
      expect(fmtTok(undefined)).toBe('0');
      expect(fmtTok(Number.NaN)).toBe('0');
    });
  });

  describe('fmtElapsed', () => {
    it('formats seconds', () => {
      expect(fmtElapsed(0)).toBe('0s');
      expect(fmtElapsed(30_000)).toBe('30s');
      expect(fmtElapsed(59_999)).toBe('1m');
    });

    it('formats minutes', () => {
      expect(fmtElapsed(60_000)).toBe('1m');
      expect(fmtElapsed(180_000)).toBe('3m');
    });

    it('formats hours', () => {
      expect(fmtElapsed(3_600_000)).toBe('1h');
      expect(fmtElapsed(7_200_000)).toBe('2h');
    });

    it('handles undefined and non-finite', () => {
      expect(fmtElapsed(undefined)).toBe('—');
      expect(fmtElapsed(-1)).toBe('—');
      expect(fmtElapsed(Number.NaN)).toBe('—');
    });
  });

  describe('fmtDuration', () => {
    it('returns — for undefined', () => {
      expect(fmtDuration(undefined)).toBe('—');
    });

    it('returns — for unparseable ISO', () => {
      expect(fmtDuration('not-a-date')).toBe('—');
    });

    it('formats elapsed from a past ISO timestamp', () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      expect(fmtDuration(past)).toBe('1m');
    });
  });

  describe('fmtAgo', () => {
    it('returns "never" for undefined or invalid', () => {
      expect(fmtAgo(undefined)).toBe('never');
      expect(fmtAgo('bad')).toBe('never');
    });

    it('formats seconds ago', () => {
      const past = new Date(Date.now() - 30_000).toISOString();
      expect(fmtAgo(past)).toBe('30s ago');
    });

    it('formats minutes ago', () => {
      const past = new Date(Date.now() - 180_000).toISOString();
      expect(fmtAgo(past)).toBe('3m ago');
    });
  });

  describe('shortModel', () => {
    it('returns undefined for empty input', () => {
      expect(shortModel(undefined)).toBeUndefined();
      expect(shortModel('')).toBeUndefined();
    });

    it('extracts last path segment', () => {
      expect(shortModel('anthropic/claude-opus-4')).toBe('claude-opus-4');
    });

    it('truncates long names', () => {
      expect(shortModel('provider/very-long-model-name-that-exceeds-limit')).toHaveLength(22);
    });
  });

  describe('statusColor', () => {
    it('returns green for active/running', () => {
      expect(statusColor('active')).toBe('hsl(var(--success))');
      expect(statusColor('running')).toBe('hsl(var(--success))');
    });

    it('returns blue for streaming', () => {
      expect(statusColor('streaming')).toBe('hsl(var(--primary))');
    });

    it('returns red for error/failed', () => {
      expect(statusColor('error')).toBe('hsl(var(--destructive))');
      expect(statusColor('failed')).toBe('hsl(var(--destructive))');
    });

    it('returns gray for idle/unknown', () => {
      expect(statusColor('idle')).toBe('hsl(var(--muted-foreground))');
      expect(statusColor('unknown')).toBe('hsl(var(--muted-foreground))');
    });
  });

  describe('sparkline', () => {
    it('returns empty for no values', () => {
      expect(sparkline([])).toBe('');
    });

    it('produces unicode block characters for values', () => {
      const result = sparkline([1, 2, 3, 4]);
      expect(result).toHaveLength(4);
      expect(result).toMatch(/^[▁▂▃▄▅▆▇█·]+$/);
    });

    it('respects custom width', () => {
      const result = sparkline(
        Array.from({ length: 100 }, (_, i) => i),
        10,
      );
      expect(result.length).toBeLessThanOrEqual(10);
    });

    it('handles all-zero values', () => {
      const result = sparkline([0, 0, 0]);
      expect(result).toBe('   ');
    });
  });
});
