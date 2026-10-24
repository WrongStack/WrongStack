import {
  activeLimits,
  clampLimit,
  formatLimitRange,
  installLimitsSource,
  LIMIT_BOUNDS,
  LIMITS_BUDGET_KEYS,
  LIMITS_SCALAR_KEYS,
  limitValueError,
  positiveLimit,
  TOOL_MEMORY_GUARD_BYTES,
} from '@wrongstack/contracts/types/config/limits';
import { afterEach, describe, expect, it } from 'vitest';

let uninstall: (() => void) | undefined;

afterEach(() => {
  uninstall?.();
  uninstall = undefined;
});

describe('limits source', () => {
  it('reports no limits when nothing is installed', () => {
    expect(activeLimits()).toEqual({});
  });

  it('reads the installed source live, so a config change applies on the next read', () => {
    let limits: { historyMessages?: number } = {};
    uninstall = installLimitsSource(() => limits);
    expect(activeLimits().historyMessages).toBeUndefined();
    limits = { historyMessages: 400 };
    expect(activeLimits().historyMessages).toBe(400);
  });

  it('treats an unset config block and a throwing source as no limits', () => {
    uninstall = installLimitsSource(() => undefined);
    expect(activeLimits()).toEqual({});
    uninstall();
    uninstall = installLimitsSource(() => {
      throw new Error('store gone');
    });
    expect(activeLimits()).toEqual({});
  });

  it('uninstall restores "no limits"', () => {
    uninstall = installLimitsSource(() => ({ fetchBytes: 10 }));
    uninstall();
    uninstall = undefined;
    expect(activeLimits()).toEqual({});
  });
});

describe('positiveLimit', () => {
  it.each([
    [5, 5],
    [2.7, 2],
    [0, undefined],
    [-1, undefined],
    [Number.NaN, undefined],
    [Number.POSITIVE_INFINITY, undefined],
    [undefined, undefined],
    ['5', undefined],
  ])('%s → %s', (value, expected) => {
    expect(positiveLimit(value as never)).toBe(expected);
  });
});

describe('limit bounds', () => {
  it('bounds every limit, with a reason for the range', () => {
    for (const key of [...LIMITS_SCALAR_KEYS, ...LIMITS_BUDGET_KEYS]) {
      const bound = LIMIT_BOUNDS[key];
      expect(bound.min).toBeGreaterThan(0);
      if (bound.max !== undefined) expect(bound.max).toBeGreaterThan(bound.min);
      else expect(bound.maxNote).toBeTruthy();
      expect(bound.why.length).toBeGreaterThan(10);
    }
  });

  it('only sets a maximum where something real sits above it', () => {
    expect(LIMIT_BOUNDS.fetchBytes.max).toBe(TOOL_MEMORY_GUARD_BYTES);
    expect(LIMIT_BOUNDS.toolOutputPreviewBytes.max).toBe(TOOL_MEMORY_GUARD_BYTES);
    // Node's setTimeout overflows (and fires at once) above 2^31-1 ms.
    expect(LIMIT_BOUNDS.timeoutMs.max).toBe(2 ** 31 - 1);
    expect(LIMIT_BOUNDS.responseOutputTokens.max).toBeUndefined();
    expect(LIMIT_BOUNDS.historyMessages.max).toBeUndefined();
  });

  it('accepts clearing and in-range whole numbers, refuses the rest with the range', () => {
    expect(limitValueError('historyMessages', undefined)).toBeNull();
    expect(limitValueError('historyMessages', 20)).toBeNull();
    expect(limitValueError('historyMessages', 19)).toBe(
      "must be ≥ 20 messages (max: the model's window (compaction))",
    );
    expect(limitValueError('fetchBytes', TOOL_MEMORY_GUARD_BYTES + 1)).toBe(
      'must be 1,024 – 67,108,864 bytes',
    );
    expect(limitValueError('fetchBytes', 2048.5)).toBe('must be a whole number');
    expect(limitValueError('fetchBytes', '2048')).toBe('must be a whole number');
  });

  it('formats a range for display', () => {
    expect(formatLimitRange('timeoutMs')).toBe('10,000 – 2,147,483,647 ms');
    expect(formatLimitRange('responseOutputTokens')).toBe(
      "≥ 1,024 tokens (max: the model's own output ceiling)",
    );
  });

  it('pulls a hand-edited out-of-range value into range on read', () => {
    expect(clampLimit('historyMessages', 3)).toBe(20);
    expect(clampLimit('fetchBytes', 10 * TOOL_MEMORY_GUARD_BYTES)).toBe(TOOL_MEMORY_GUARD_BYTES);
    expect(clampLimit('historyMessages', 0)).toBeUndefined();
    uninstall = installLimitsSource(() => ({
      historyMessages: 3,
      fetchBytes: 400,
      subagentDefaultBudget: { maxIterations: 1, timeoutMs: 2 ** 40 },
    }));
    expect(activeLimits()).toEqual({
      historyMessages: 20,
      fetchBytes: 1024,
      subagentDefaultBudget: { maxIterations: 2, timeoutMs: 2 ** 31 - 1 },
    });
  });
});
