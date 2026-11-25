import { describe, expect, it } from 'vitest';
import { isIdleProgressLog, PROGRESS_LOG_IDLE_MS } from '../src/shared/progress-log.js';

describe('isIdleProgressLog (F2166)', () => {
  it('returns false when nowMs is non-finite instead of retiring fresh logs', () => {
    const now = Date.parse('2026-11-25T00:00:00Z');
    const memory = {
      text: 'Bug-hunt round r17/25: LANDED suites 10/10 pass HEAD abcdef1',
      persistence: 'session' as const,
      createdAt: new Date(now - 1000).toISOString(),
      lastUsedAt: undefined,
    };

    expect(isIdleProgressLog(memory, Number.NaN)).toBe(false);
    expect(isIdleProgressLog(memory, Number.POSITIVE_INFINITY)).toBe(false);
    expect(isIdleProgressLog(memory, now + PROGRESS_LOG_IDLE_MS + 1000)).toBe(true);
  });
});
