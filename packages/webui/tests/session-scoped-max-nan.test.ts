import { describe, expect, it } from 'vitest';
import { createSessionScopedStore } from '../src/stores/session-scoped-store';

describe('createSessionScopedStore max cap guard', () => {
  it('falls back to default cap when options.max is NaN', () => {
    const store = createSessionScopedStore(() => ({ count: 0 }), { max: Number.NaN });
    for (let i = 0; i < 20; i++) {
      store.for(`sess-${i}`);
    }
    expect(store.sessionIds().length).toBeLessThanOrEqual(10);
  });
});
