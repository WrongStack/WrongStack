import { describe, expect, it } from 'vitest';
import { getPerfProfile } from '../src/utils/perf-profile.js';

describe('getPerfProfile alias fallback', () => {
  it('falls back to WSTACK_PERF_PROFILE when WRONGSTACK_PERF_PROFILE is empty or whitespace', () => {
    const prevMain = process.env.WRONGSTACK_PERF_PROFILE;
    const prevAlias = process.env.WSTACK_PERF_PROFILE;
    try {
      process.env.WSTACK_PERF_PROFILE = 'frugal';
      process.env.WRONGSTACK_PERF_PROFILE = '   ';
      expect(getPerfProfile()).toBe('frugal');
      process.env.WRONGSTACK_PERF_PROFILE = '';
      expect(getPerfProfile()).toBe('frugal');
    } finally {
      if (prevMain === undefined) delete process.env.WRONGSTACK_PERF_PROFILE;
      else process.env.WRONGSTACK_PERF_PROFILE = prevMain;
      if (prevAlias === undefined) delete process.env.WSTACK_PERF_PROFILE;
      else process.env.WSTACK_PERF_PROFILE = prevAlias;
    }
  });
});
