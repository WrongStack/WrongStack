import { describe, expect, it } from 'vitest';
import { INJECTION_AGE_OUT_MS, isAgedOutForInjection } from '../src/shared/injection-recency.js';

describe('isAgedOutForInjection invalid createdAt with valid lastUsedAt', () => {
  it('uses lastUsedAt when createdAt is unparseable instead of producing NaN', () => {
    const now = Date.parse('2026-11-25T00:00:00Z');
    const oldIso = new Date(now - INJECTION_AGE_OUT_MS - 86_400_000).toISOString();
    const recentIso = new Date(now - 1000).toISOString();

    expect(
      isAgedOutForInjection(
        {
          kind: 'fact',
          persistence: 'short_lived',
          importance: 0.5,
          createdAt: 'not-a-date',
          lastUsedAt: oldIso,
        },
        now,
      ),
    ).toBe(true);
    expect(
      isAgedOutForInjection(
        {
          kind: 'fact',
          persistence: 'short_lived',
          importance: 0.5,
          createdAt: 'not-a-date',
          lastUsedAt: recentIso,
        },
        now,
      ),
    ).toBe(false);
  });
});
