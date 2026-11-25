import { describe, expect, it } from 'vitest';
import { setupTeardownRegistrar } from '../src/wiring/teardown-registrar.js';

describe('setupTeardownRegistrar null-prototype close error guard (F2307)', () => {
  it('handles null-prototype errors from vectorMemoryStore.close() without escaping teardown', () => {
    const handlers: Array<() => void> = [];
    let logged = '';
    setupTeardownRegistrar({
      flags: {},
      events: { on: () => {}, off: () => {} } as never,
      logger: {
        debug: (m) => {
          logged = m;
        },
      },
      teardownHandlers: handlers,
      vectorMemoryStore: {
        close: () => {
          throw Object.create(null);
        },
      } as never,
    });
    expect(() => {
      for (const h of handlers) h();
    }).not.toThrow();
    expect(logged).toContain('vector memory close failed');
  });
});
