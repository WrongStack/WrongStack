import { describe, expect, it } from 'vitest';
import { isAgedOutForInjection } from '../src/shared/injection-recency.js';

describe('isAgedOutForInjection non-finite clock guard', () => {
  it('does not age out memories when nowMs is non-finite', () => {
    const mem = {
      kind: 'fact' as const,
      persistence: 'session' as const,
      importance: 0.5,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(isAgedOutForInjection(mem, Number.POSITIVE_INFINITY)).toBe(false);
    expect(isAgedOutForInjection(mem, Number.NaN)).toBe(false);
    expect(isAgedOutForInjection(mem, Date.parse('2026-06-01T00:00:00.000Z'))).toBe(true);
  });
});
