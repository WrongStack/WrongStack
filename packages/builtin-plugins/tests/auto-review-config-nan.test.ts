import type { Config } from '@wrongstack/contracts/types/config';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_MAX_CASCADE_DEPTH,
  DEFAULT_MAX_CONCURRENT_REVIEWS,
  DEFAULT_MAX_FILES_PER_BATCH,
  resolveAutoReviewConfig,
  selectRoundRobinReviewerAssignment,
  trimKnownFingerprints,
} from '../src/auto-review-config.js';

describe('auto-review-config non-finite cursor and numeric bounds (F1855)', () => {
  it('handles non-finite round-robin cursor without crashing', () => {
    const pool = ['openai/gpt-5', 'anthropic/claude-4'];
    for (const badCursor of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const res = selectRoundRobinReviewerAssignment(pool, badCursor, 'openai', 'gpt-5');
      expect(res.provider).toBe('openai');
      expect(res.model).toBe('gpt-5');
      expect(res.nextCursor).toBe(1);
    }
  });

  it('falls back to defaults for invalid numeric config fields', () => {
    const sessionCfg = {
      provider: 'openai',
      model: 'gpt-5',
      fallbackModels: [],
      fallbackAuto: false,
    } as unknown as Config;
    const resolved = resolveAutoReviewConfig(
      {
        debounceMs: Number.NaN,
        maxFilesPerBatch: 0,
        maxConcurrentReviews: -2,
        maxCascadeDepth: Number.POSITIVE_INFINITY,
      },
      sessionCfg,
    );
    expect(resolved.debounceMs).toBe(DEFAULT_DEBOUNCE_MS);
    expect(resolved.maxFilesPerBatch).toBe(DEFAULT_MAX_FILES_PER_BATCH);
    expect(resolved.maxConcurrentReviews).toBe(DEFAULT_MAX_CONCURRENT_REVIEWS);
    expect(resolved.maxCascadeDepth).toBe(DEFAULT_MAX_CASCADE_DEPTH);

    const map = new Map<string, string>([
      ['a', '1'],
      ['b', '2'],
    ]);
    trimKnownFingerprints(map, 1);
    expect([...map.keys()]).toEqual(['b']);
  });
});
