import { describe, expect, it } from 'vitest';
import { isIdleProgressLog, PROGRESS_LOG_IDLE_MS } from '../src/shared/progress-log.js';

describe('isIdleProgressLog invalid createdAt with valid lastUsedAt', () => {
  it('uses lastUsedAt when createdAt is unparseable instead of producing NaN', () => {
    const now = Date.parse('2026-11-25T00:00:00Z');
    const oldIso = new Date(now - PROGRESS_LOG_IDLE_MS - 86_400_000).toISOString();
    const recentIso = new Date(now - 1000).toISOString();
    const logText =
      'Bug-hunt round r17-20261023 (17/25 session): NO-PROVEN-BUG, suites 120/120 green';

    expect(
      isIdleProgressLog(
        { text: logText, persistence: 'short_lived', createdAt: 'not-a-date', lastUsedAt: oldIso },
        now,
      ),
    ).toBe(true);
    expect(
      isIdleProgressLog(
        {
          text: logText,
          persistence: 'short_lived',
          createdAt: 'not-a-date',
          lastUsedAt: recentIso,
        },
        now,
      ),
    ).toBe(false);
  });
});
