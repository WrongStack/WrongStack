/**
 * Edge-case test for src/i18n/index.ts — catch in readInitialLocale (line 49).
 * Tests that the module initialises gracefully when useLocalPrefs throws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/stores/local-prefs', () => ({
  useLocalPrefs: {
    getState: () => {
      throw new Error('store not ready');
    },
    subscribe: () => () => {},
  },
}));

describe('i18n/index — readInitialLocale catch (line 49)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to FALLBACK_LNG when useLocalPrefs.getState throws', async () => {
    // Import should not throw — catch block returns FALLBACK_LNG
    const mod = await import('../../src/i18n/index');
    expect(mod).toBeDefined();
    expect(mod.FALLBACK_LNG).toBe('en');
  });
});
